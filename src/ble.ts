/**
 * Transport: discovery, connection and command writes to a BLE LED strip via
 * BlueZ (the node-ble library, which talks to org.bluez over D-Bus).
 *
 * Real-world quirks handled here:
 *
 *  - The strip advertises ONLY while nothing is connected to it. If the phone
 *    keeps its app open, the device is not on air and cannot be connected to.
 *    Hence the explicit error with a hint.
 *  - BlueZ remembers devices from its cache, so before connecting by address we
 *    always start discovery: this "wakes" the strip and puts it into the cache
 *    (otherwise Connect fails with "not available").
 *  - The strip sleeps and drops off, so there are retries and a "warm"
 *    connection: it is kept for N ms after the last command so a series of
 *    commands does not reconnect every time.
 *  - All operations are strictly serialized: parallel writes would interleave
 *    the mandatory settle delay and some commands would be silently swallowed.
 */

import { createBluetooth } from "node-ble"
import type { Adapter, Bluetooth, Device, GattCharacteristic, GattServer } from "node-ble"

import { configPath, resolveTarget, saveConfig, type BleConfig, type Target } from "./config.js"
import { debug, log } from "./log.js"
import { Protocol, decodePacket, formatHex, sleep, type DecodedPacket } from "./protocol.js"

export interface BleLedOptions {
    /** How long to wait for the device to appear on air, ms. */
    timeoutMs?: number
    /** How long to keep the connection after the last command, ms (0 — drop immediately). */
    warmMs?: number
    /** Address/name/model (CLI flags, env, config). */
    target?: Partial<Target>
    /** Number of connection attempts. */
    connectTries?: number
}

export interface ScanResult {
    address: string
    name?: string
    rssi?: number
    addressType?: string
    /** The device appeared on air during this scan (as opposed to sitting in the BlueZ cache). */
    fresh: boolean
    /** The name matched the configured target. */
    matchesTarget: boolean
}

export interface CharacteristicInfo {
    uuid: string
    flags: string[]
}

export interface ServiceInfo {
    uuid: string
    characteristics: CharacteristicInfo[]
}

export interface DeviceInfo {
    address?: string
    name?: string
    rssi?: number
    addressType?: string
    /** Detected protocol model. */
    model: string
    writeUuid: string
    notifyUuid: string
    settleMs: number
    services: ServiceInfo[]
}

export interface CommandResult {
    address: string
    model: string
    /** Sent packets in hex. */
    sent: string[]
    /** The pause that was honoured between commands. */
    settleMs: number
}

export interface StatusInfo {
    /** Address from the config/flags (may be absent — then we search by name). */
    address?: string
    /** The name we search for. */
    name: string
    /** Model, if forced explicitly. */
    model?: string
    /** Whether a live connection exists right now. */
    connected: boolean
    /** Name of the connected device, if connected. */
    deviceName?: string
    /** Detected protocol model, if connected. */
    protocol?: string
    settleMs?: number
    /** Last command sent (hex). */
    lastSent?: string
    configPath: string
}

interface Connection {
    device: Device
    gatt: GattServer
    write: GattCharacteristic
    notify?: GattCharacteristic
    protocol: Protocol
    /** The characteristic only supports write with response. */
    writeWithResponse: boolean
    deviceName?: string
    address: string
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
}

export class BleLed {
    private bluetooth?: Bluetooth
    private destroySession?: () => void
    private adapter?: Adapter
    private conn?: Connection
    private idleTimer?: NodeJS.Timeout
    /** Operation queue: guarantees that commands do not interleave. */
    private queue: Promise<unknown> = Promise.resolve()
    private target: Partial<Target>
    private lastSent?: string

    constructor(private readonly options: BleLedOptions = {}) {
        this.target = options.target ?? {}
    }

    /** Change the target (address/name/model). Changing the address drops the connection. */
    async configure(target: Partial<Target>): Promise<void> {
        const previous = resolveTarget(this.target)
        const next = resolveTarget({ ...this.target, ...target })
        const addressChanged = previous.address !== next.address || previous.name !== next.name
        this.target = { ...this.target, ...target }
        if (addressChanged && this.conn) {
            await this.close()
        }
    }

    private async serialize<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.queue.then(operation, operation)
        this.queue = run.then(
            () => undefined,
            () => undefined,
        )
        return run
    }

    private async getAdapter(): Promise<Adapter> {
        if (this.adapter) return this.adapter
        if (!this.bluetooth) {
            const session = createBluetooth()
            this.bluetooth = session.bluetooth
            this.destroySession = session.destroy
        }
        this.adapter = await this.bluetooth.defaultAdapter()
        debug(`адаптер: ${await this.adapter.getAddress()}`)
        return this.adapter
    }

    private async ensureDiscovery(adapter: Adapter): Promise<void> {
        if (!(await adapter.isDiscovering())) {
            await adapter.startDiscovery()
        }
    }

    private async safeName(device: Device): Promise<string | undefined> {
        const name = await device
            .getName()
            .then((value: string) => value?.trim())
            .catch(() => undefined)
        if (name) return name
        return device
            .getAlias()
            .then((value: string) => value?.trim())
            .catch(() => undefined)
    }

    private async safeRssi(device: Device): Promise<number | undefined> {
        const rssi = await device
            .getRSSI()
            .then((value) => Number(value))
            .catch(() => Number.NaN)
        return Number.isFinite(rssi) ? rssi : undefined
    }

    /** Skip a device: "garbage" cache entries have no RSSI. */
    private matchesName(name: string | undefined, wanted: string): boolean {
        if (!name) return false
        const clean = wanted.trim().replace(/\*+$/, "").toLowerCase()
        return name.trim().toLowerCase().startsWith(clean)
    }

    /** Wait until the device appears on air and return its address. */
    private async waitForAddress(adapter: Adapter, name: string, timeoutMs: number): Promise<string> {
        await this.ensureDiscovery(adapter)
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            for (const address of await adapter.devices()) {
                const device = await adapter.getDevice(address)
                const deviceName = await this.safeName(device)
                if (this.matchesName(deviceName, name)) return address
            }
            await sleep(1000)
        }
        throw new Error(
            `устройство «${name}» не найдено за ${Math.round(timeoutMs / 1000)} с. ` +
                `Проверь: лента включена в розетку и приложение на телефоне закрыто ` +
                `(пока телефон держит коннект, лента не рекламируется).`,
        )
    }

    /** Find a characteristic by UUID by walking the services (the service UUID differs between models). */
    private async locateCharacteristic(gatt: GattServer, uuid: string): Promise<GattCharacteristic> {
        const wanted = uuid.toLowerCase()
        for (const serviceUuid of await gatt.services()) {
            const service = await gatt.getPrimaryService(serviceUuid)
            const characteristics = await service.characteristics()
            const found = characteristics.find((characteristic) => characteristic.toLowerCase() === wanted)
            if (found) return service.getCharacteristic(found)
        }
        throw new Error(`характеристика ${uuid} не найдена в GATT-профиле устройства`)
    }

    private async connect(): Promise<Connection> {
        if (this.conn) return this.conn

        const target = resolveTarget(this.target)
        const adapter = await this.getAdapter()
        const timeoutMs = this.options.timeoutMs ?? 30_000

        let address = target.address
        let discoveredName: string | undefined
        if (!address) {
            address = await this.waitForAddress(adapter, target.name, timeoutMs)
            debug(`нашли по имени: ${address}`)
        }

        const tries = this.options.connectTries ?? 3
        let lastError: unknown

        for (let attempt = 1; attempt <= tries; attempt++) {
            try {
                // Discovery is always needed: without a fresh entry in the BlueZ
                // cache, Connect by address fails with "not available".
                await this.ensureDiscovery(adapter)
                const device = await adapter.waitDevice(address, Math.min(timeoutMs, 20_000))
                await device.connect()

                discoveredName = discoveredName ?? (await this.safeName(device))
                const protocol = Protocol.forDevice(discoveredName ?? target.name, target.model)
                const gatt = await device.gatt()
                const write = await this.locateCharacteristic(gatt, protocol.writeUuid)
                const flags = await write.getFlags().catch(() => [] as string[])
                const notify = await this.locateCharacteristic(gatt, protocol.notifyUuid).catch(() => undefined)

                this.conn = {
                    device,
                    gatt,
                    write,
                    notify,
                    protocol,
                    writeWithResponse: !flags.includes("write-without-response"),
                    deviceName: discoveredName,
                    address,
                }
                this.lastSent = undefined

                // Remember the discovered address so future connections go straight to it.
                if (target.address !== address) {
                    try {
                        saveConfig({ address, name: discoveredName ?? target.name })
                    } catch (error) {
                        debug(`не удалось сохранить адрес в конфиг: ${errorText(error)}`)
                    }
                }

                debug(
                    `подключено: ${discoveredName ?? "(без имени)"} [${address}], модель ${protocol.name}, ` +
                        `settle ${protocol.settleMs} мс${this.conn.writeWithResponse ? ", write с ответом" : ""}`,
                )
                return this.conn
            } catch (error) {
                lastError = error
                debug(`попытка подключения ${attempt}/${tries}: ${errorText(error)}`)
                if (attempt < tries) await sleep(attempt * 500)
            }
        }
        throw new Error(
            `не удалось подключиться к ${address}: ${errorText(lastError)}. ` +
                `Если лента занята телефоном, закрой приложение.`,
        )
    }

    private async write(conn: Connection, packet: Buffer): Promise<void> {
        if (conn.writeWithResponse) await conn.write.writeValueWithResponse(packet)
        else await conn.write.writeValueWithoutResponse(packet)
    }

    /**
     * Build and send commands.
     *
     * Building happens AFTER connecting and receives the actual Protocol: the
     * model is detected from the name that really came from the air, not from
     * what is written in the config. Otherwise auto-detection could easily send
     * another model's bytes.
     */
    async run(build: (protocol: Protocol) => Buffer | Buffer[]): Promise<CommandResult> {
        return this.send(build)
    }

    /** Send one or more commands in sequence, with the mandatory pauses. */
    async send(packets: Buffer[] | ((protocol: Protocol) => Buffer | Buffer[])): Promise<CommandResult> {
        return this.serialize(async () => {
            const conn = await this.connect()
            const built = typeof packets === "function" ? packets(conn.protocol) : packets
            const list = Array.isArray(built) ? built : [built]
            const sent: string[] = []
            for (const packet of list) {
                await this.write(conn, packet)
                sent.push(formatHex(packet))
                this.lastSent = formatHex(packet)
                debug(`→ ${formatHex(packet)}`)
                // The pause is always needed, including after the last command in
                // a series: otherwise the next one (from another call) could land
                // inside the window.
                await sleep(conn.protocol.settleMs)
            }
            this.scheduleIdleDisconnect()
            return { address: conn.address, model: conn.protocol.name, sent, settleMs: conn.protocol.settleMs }
        })
    }

    /** Scan the air. */
    async scan(durationMs = 10_000): Promise<ScanResult[]> {
        return this.serialize(async () => {
            const adapter = await this.getAdapter()
            const cached = new Set(await adapter.devices())
            await this.ensureDiscovery(adapter)
            log(`скан ${Math.round(durationMs / 1000)} с...`)
            await sleep(durationMs)
            const target = resolveTarget(this.target)
            const results: ScanResult[] = []
            for (const address of await adapter.devices()) {
                const device = await adapter.getDevice(address)
                const name = await this.safeName(device)
                results.push({
                    address,
                    name,
                    rssi: await this.safeRssi(device),
                    addressType: await device.getAddressType().catch(() => undefined),
                    fresh: !cached.has(address),
                    matchesTarget: this.matchesName(name, target.name),
                })
            }
            results.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
            return results
        })
    }

    /** GATT profile of the connected device. */
    async info(): Promise<DeviceInfo> {
        return this.serialize(async () => {
            const conn = await this.connect()
            const services: ServiceInfo[] = []
            for (const serviceUuid of await conn.gatt.services()) {
                const service = await conn.gatt.getPrimaryService(serviceUuid)
                const characteristics: CharacteristicInfo[] = []
                for (const charUuid of await service.characteristics()) {
                    const characteristic = await service.getCharacteristic(charUuid)
                    characteristics.push({
                        uuid: charUuid,
                        flags: await characteristic.getFlags().catch(() => [] as string[]),
                    })
                }
                services.push({ uuid: serviceUuid, characteristics })
            }
            this.scheduleIdleDisconnect()
            return {
                address: conn.address,
                name: conn.deviceName,
                rssi: await this.safeRssi(conn.device),
                addressType: await conn.device.getAddressType().catch(() => undefined),
                model: conn.protocol.name,
                writeUuid: conn.protocol.writeUuid,
                notifyUuid: conn.protocol.notifyUuid,
                settleMs: conn.protocol.settleMs,
                services,
            }
        })
    }

    /**
     * Listen on the notify channel. The controller almost always answers with an
     * echo of our own command and never reports real state — packets are
     * returned as-is so they can be decoded outside (including a protocol
     * capture from the phone app).
     */
    async watch(
        durationMs = 20_000,
        onPacket?: (packet: DecodedPacket) => void,
    ): Promise<{ address: string; model: string; packets: DecodedPacket[]; notifyUuid: string }> {
        return this.serialize(async () => {
            const conn = await this.connect()
            if (!conn.notify) {
                throw new Error(`у модели ${conn.protocol.name} нет характеристики уведомлений — watch недоступен`)
            }
            const packets: DecodedPacket[] = []
            const listener = (data: Buffer): void => {
                const packet = decodePacket(data)
                packets.push(packet)
                onPacket?.(packet)
            }
            conn.notify.on("valuechanged", listener)
            await conn.notify.startNotifications()
            debug(`слушаю ${conn.protocol.notifyUuid} ${Math.round(durationMs / 1000)} с`)
            try {
                await sleep(durationMs)
            } finally {
                conn.notify.off("valuechanged", listener)
                await conn.notify.stopNotifications().catch(() => undefined)
            }
            this.scheduleIdleDisconnect()
            return { address: conn.address, model: conn.protocol.name, packets, notifyUuid: conn.protocol.notifyUuid }
        })
    }

    /** Current state: config + whether a live connection exists. */
    async status(): Promise<StatusInfo> {
        const target = resolveTarget(this.target)
        const connected = this.conn
            ? await this.conn.device
                  .isConnected()
                  .then(Boolean)
                  .catch(() => false)
            : false
        return {
            address: target.address,
            name: target.name,
            model: target.model,
            connected,
            deviceName: connected ? this.conn?.deviceName : undefined,
            protocol: connected ? this.conn?.protocol.name : undefined,
            settleMs: connected ? this.conn?.protocol.settleMs : undefined,
            lastSent: this.lastSent,
            configPath: configPath(),
        }
    }

    /** Keep the connection warm: the strip sleeps and reconnecting is not fast. */
    private scheduleIdleDisconnect(): void {
        const warmMs = this.options.warmMs ?? 0
        if (this.idleTimer) clearTimeout(this.idleTimer)
        if (warmMs <= 0) return
        this.idleTimer = setTimeout(() => {
            void this.close().catch(() => undefined)
        }, warmMs)
        this.idleTimer.unref()
    }

    /** Disconnect and close the D-Bus session. */
    async close(): Promise<void> {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer)
            this.idleTimer = undefined
        }
        const conn = this.conn
        this.conn = undefined
        if (conn) {
            await conn.device.disconnect().catch((error: unknown) => debug(`disconnect: ${errorText(error)}`))
        }
        if (this.destroySession) {
            try {
                this.destroySession()
            } catch (error) {
                debug(`destroy session: ${errorText(error)}`)
            }
            this.destroySession = undefined
        }
        this.bluetooth = undefined
        this.adapter = undefined
    }
}

export type { BleConfig }
