/**
 * Transport: discovery, connection and command writes to BLE LED strips via
 * BlueZ (the node-ble library, which talks to org.bluez over D-Bus).
 *
 * Real-world quirks handled here:
 *
 *  - A strip advertises ONLY while nothing is connected to it. If the phone
 *    keeps its app open, the device is not on air and cannot be connected to.
 *    Hence the explicit error with a hint.
 *  - BlueZ remembers devices from its cache, so before connecting by address we
 *    always start discovery: this "wakes" the strip and puts it into the cache
 *    (otherwise Connect fails with "not available").
 *  - Strips sleep and drop off, so there are retries and a "warm" connection:
 *    kept for N ms after the last command so a series of commands does not
 *    reconnect every time.
 *  - Several strips may be controlled at once. Connections are pooled and keyed
 *    by MAC address; each has its own idle timer. Named devices (see config.ts)
 *    are just a friendly alias over an address.
 *  - Every operation is strictly serialized: parallel writes would interleave
 *    the mandatory settle delay and some commands would be silently swallowed.
 */
import { createBluetooth } from "node-ble";
import { addDevice, configPath, resolveTarget } from "./config.js";
import { debug, log } from "./log.js";
import { Protocol, classifyDeviceName, decodePacket, formatHex, sleep } from "./protocol.js";
function errorText(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
export class BleLed {
    options;
    bluetooth;
    destroySession;
    adapter;
    /** Live connections, keyed by MAC address. */
    conns = new Map();
    /** Per-connection idle-close timers. */
    idleTimers = new Map();
    /** Whether discovery was started by us and may therefore be stopped by us. */
    startedDiscovery = false;
    /** Operation queue: guarantees that commands do not interleave. */
    queue = Promise.resolve();
    target;
    constructor(options = {}) {
        this.options = options;
        this.target = options.target ?? {};
    }
    resolve(extra) {
        return resolveTarget({ ...this.target, ...extra });
    }
    async serialize(operation) {
        const run = this.queue.then(operation, operation);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }
    async getAdapter() {
        if (this.adapter)
            return this.adapter;
        if (!this.bluetooth) {
            const session = (this.options.createBluetooth ?? createBluetooth)();
            this.bluetooth = session.bluetooth;
            this.destroySession = session.destroy;
        }
        this.adapter = await this.bluetooth.defaultAdapter();
        debug(`adapter: ${await this.adapter.getAddress()}`);
        return this.adapter;
    }
    async ensureDiscovery(adapter) {
        if (!(await adapter.isDiscovering())) {
            await adapter.startDiscovery();
            this.startedDiscovery = true;
        }
    }
    /**
     * Stop the scan we started once nobody needs it any more (no live
     * connections). Otherwise the adapter keeps scanning forever: the radio
     * stays busy and the adapter cannot be used for anything else.
     */
    async stopDiscoveryWhenIdle(adapter) {
        if (!this.startedDiscovery || this.conns.size > 0)
            return;
        this.startedDiscovery = false;
        await adapter.stopDiscovery().catch((error) => debug(`stop discovery: ${errorText(error)}`));
    }
    async safeName(device) {
        const name = await device
            .getName()
            .then((value) => value?.trim())
            .catch(() => undefined);
        if (name)
            return name;
        return device
            .getAlias()
            .then((value) => value?.trim())
            .catch(() => undefined);
    }
    async safeRssi(device) {
        const rssi = await device
            .getRSSI()
            .then((value) => Number(value))
            .catch(() => Number.NaN);
        return Number.isFinite(rssi) ? rssi : undefined;
    }
    /** Match an advertising name against a wanted name by prefix (trailing `*` ignored). */
    matchesName(name, wanted) {
        if (!name)
            return false;
        const clean = wanted.trim().replace(/\*+$/, "").toLowerCase();
        return name.trim().toLowerCase().startsWith(clean);
    }
    /** Wait until the device appears on air and return its address. */
    async waitForAddress(adapter, name, timeoutMs) {
        await this.ensureDiscovery(adapter);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            for (const address of await adapter.devices()) {
                const device = await adapter.getDevice(address);
                const deviceName = await this.safeName(device);
                if (this.matchesName(deviceName, name))
                    return address;
            }
            await sleep(1000);
        }
        throw new Error(`device "${name}" was not found within ${Math.round(timeoutMs / 1000)} s. ` +
            `Check that the strip is powered and the phone app is closed ` +
            `(the strip does not advertise while the phone holds the connection).`);
    }
    /** Find a characteristic by UUID by walking the services (the service UUID differs between models). */
    async locateCharacteristic(gatt, uuid) {
        const wanted = uuid.toLowerCase();
        for (const serviceUuid of await gatt.services()) {
            const service = await gatt.getPrimaryService(serviceUuid);
            const characteristics = await service.characteristics();
            const found = characteristics.find((characteristic) => characteristic.toLowerCase() === wanted);
            if (found)
                return service.getCharacteristic(found);
        }
        throw new Error(`characteristic ${uuid} is not in the device GATT profile`);
    }
    findConnection(target) {
        if (target.address)
            return this.conns.get(target.address);
        return [...this.conns.values()].find((conn) => this.matchesName(conn.deviceName, target.name));
    }
    async connect(target) {
        const adapter = await this.getAdapter();
        const timeoutMs = this.options.timeoutMs ?? 30_000;
        let address = target.address;
        if (!address) {
            // Already connected by name? Reuse it instead of rediscovering.
            const existing = this.findConnection(target);
            if (existing)
                return existing;
            address = await this.waitForAddress(adapter, target.name, timeoutMs).catch(async (error) => {
                // The scan started for this lookup has no caller any more.
                await this.stopDiscoveryWhenIdle(adapter);
                throw error;
            });
            debug(`found by name "${target.name}": ${address}`);
        }
        const cached = this.conns.get(address);
        if (cached) {
            // A connection kept in the pool may be a corpse (the strip slept, or
            // the phone stole it). Reusing it would fail the command and the
            // corpse would sit in the pool forever, blocking the strip.
            if (await cached.device.isConnected().catch(() => false))
                return cached;
            debug(`connection to ${address} is dead — reconnecting`);
            await this.closeConnection(address);
        }
        const tries = this.options.connectTries ?? 3;
        let lastError;
        for (let attempt = 1; attempt <= tries; attempt++) {
            let device;
            try {
                // Discovery is always needed: without a fresh entry in the BlueZ
                // cache, Connect by address fails with "not available".
                await this.ensureDiscovery(adapter);
                device = await adapter.waitDevice(address, Math.min(timeoutMs, 20_000));
                await device.connect();
                const discoveredName = (await this.safeName(device)) ?? target.name;
                const protocol = Protocol.forDevice(discoveredName, target.model);
                const gatt = await device.gatt();
                const write = await this.locateCharacteristic(gatt, protocol.writeUuid);
                const flags = await write.getFlags().catch(() => []);
                const notify = await this.locateCharacteristic(gatt, protocol.notifyUuid).catch(() => undefined);
                const conn = {
                    device,
                    gatt,
                    write,
                    notify,
                    protocol,
                    writeWithResponse: !flags.includes("write-without-response"),
                    deviceName: discoveredName,
                    address,
                };
                this.conns.set(address, conn);
                // Remember the discovered address on the named device so future
                // connections go straight to it (ad-hoc targets are not saved).
                if (target.device && target.address !== address) {
                    try {
                        addDevice(target.device, { address, name: discoveredName });
                    }
                    catch (error) {
                        debug(`could not save the address to the config: ${errorText(error)}`);
                    }
                }
                debug(`connected: ${discoveredName} [${address}], model ${protocol.name}, ` +
                    `settle ${protocol.settleMs} ms${conn.writeWithResponse ? ", write with response" : ""}`);
                return conn;
            }
            catch (error) {
                lastError = error;
                debug(`connect attempt ${attempt}/${tries}: ${errorText(error)}`);
                // Whatever got connected during this attempt must not be left
                // hanging: an untracked connection holds the strip (it stops
                // advertising) and close() would never see it.
                if (device)
                    await this.disconnectQuietly(device, address);
                if (attempt < tries)
                    await sleep(attempt * 500);
            }
        }
        // Nothing was connected: release the scan this attempt started.
        await this.stopDiscoveryWhenIdle(adapter);
        throw new Error(`could not connect to ${address}: ${errorText(lastError)}. ` +
            `If the phone holds the strip, close its app.`);
    }
    async write(conn, packet) {
        if (conn.writeWithResponse)
            await conn.write.writeValueWithResponse(packet);
        else
            await conn.write.writeValueWithoutResponse(packet);
    }
    /**
     * Best-effort teardown of a half-open connection: a device that was
     * `connect()`-ed but never made it into the pool. Never throws — the caller
     * is already on an error path.
     */
    async disconnectQuietly(device, address) {
        // If the property cannot be read, assume it is connected: trying to
        // disconnect an idle device is harmless, leaving it connected is not.
        const connected = await device.isConnected().catch(() => true);
        if (!connected)
            return;
        await device.disconnect().catch((error) => debug(`connect rollback ${address}: ${errorText(error)}`));
    }
    /**
     * Build and send commands.
     *
     * Building happens AFTER connecting and receives the actual Protocol: the
     * model is detected from the name that really came from the air, not from
     * what is written in the config. Otherwise auto-detection could easily send
     * another model's bytes.
     */
    async run(build, extra) {
        return this.send(build, extra);
    }
    /** Send one or more commands in sequence, with the mandatory pauses. */
    async send(packets, extra) {
        return this.serialize(async () => {
            const conn = await this.connect(this.resolve(extra));
            try {
                const built = typeof packets === "function" ? packets(conn.protocol) : packets;
                const list = Array.isArray(built) ? built : [built];
                const sent = [];
                for (const packet of list) {
                    await this.write(conn, packet);
                    sent.push(formatHex(packet));
                    conn.lastSent = formatHex(packet);
                    debug(`→ ${formatHex(packet)}`);
                    // The pause is always needed, including after the last command in
                    // a series: otherwise the next one (from another call) could land
                    // inside the window.
                    await sleep(conn.protocol.settleMs);
                }
                return { address: conn.address, model: conn.protocol.name, sent, settleMs: conn.protocol.settleMs };
            }
            catch (error) {
                // A failed write usually means the link is gone. Keeping such a
                // connection in the pool would make every next command fail too,
                // so it is released here and rebuilt on demand.
                await this.closeConnection(conn.address);
                throw error;
            }
            finally {
                // Release on every path — including a failed write. With warm 0
                // the strip is freed before this call returns, so the phone or
                // another agent can take it over immediately.
                await this.releaseConnection(conn);
            }
        });
    }
    /** Scan the air. */
    async scan(durationMs = 10_000) {
        return this.serialize(async () => {
            const adapter = await this.getAdapter();
            try {
                const cached = new Set(await adapter.devices());
                await this.ensureDiscovery(adapter);
                log(`scanning for ${Math.round(durationMs / 1000)} s...`);
                await sleep(durationMs);
                const target = this.resolve();
                const results = [];
                for (const address of await adapter.devices()) {
                    const device = await adapter.getDevice(address);
                    const name = await this.safeName(device);
                    const guess = classifyDeviceName(name);
                    results.push({
                        address,
                        name,
                        rssi: await this.safeRssi(device),
                        addressType: await device.getAddressType().catch(() => undefined),
                        fresh: !cached.has(address),
                        matchesTarget: this.matchesName(name, target.name),
                        likely: guess.likely,
                        confidence: guess.confidence,
                        model: guess.model,
                        hint: guess.hint,
                    });
                }
                results.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
                return results;
            }
            finally {
                // The scan is over — do not leave the adapter scanning forever.
                await this.stopDiscoveryWhenIdle(adapter);
            }
        });
    }
    /** GATT profile of the connected device. */
    async info(extra) {
        return this.serialize(async () => {
            const conn = await this.connect(this.resolve(extra));
            try {
                const services = [];
                for (const serviceUuid of await conn.gatt.services()) {
                    const service = await conn.gatt.getPrimaryService(serviceUuid);
                    const characteristics = [];
                    for (const charUuid of await service.characteristics()) {
                        const characteristic = await service.getCharacteristic(charUuid);
                        characteristics.push({
                            uuid: charUuid,
                            flags: await characteristic.getFlags().catch(() => []),
                        });
                    }
                    services.push({ uuid: serviceUuid, characteristics });
                }
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
                };
            }
            finally {
                await this.releaseConnection(conn);
            }
        });
    }
    /**
     * Listen on the notify channel. The controller almost always answers with an
     * echo of our own command and never reports real state — packets are
     * returned as-is so they can be decoded outside (including a protocol
     * capture from the phone app).
     */
    async watch(durationMs = 20_000, onPacket, extra) {
        return this.serialize(async () => {
            const conn = await this.connect(this.resolve(extra));
            try {
                if (!conn.notify) {
                    throw new Error(`model ${conn.protocol.name} has no notify characteristic — watch is unavailable`);
                }
                const packets = [];
                const listener = (data) => {
                    const packet = decodePacket(data);
                    packets.push(packet);
                    onPacket?.(packet);
                };
                conn.notify.on("valuechanged", listener);
                try {
                    await conn.notify.startNotifications();
                    debug(`listening on ${conn.protocol.notifyUuid} for ${Math.round(durationMs / 1000)} s`);
                    await sleep(durationMs);
                }
                finally {
                    conn.notify.off("valuechanged", listener);
                    await conn.notify.stopNotifications().catch(() => undefined);
                }
                return {
                    address: conn.address,
                    model: conn.protocol.name,
                    packets,
                    notifyUuid: conn.protocol.notifyUuid,
                };
            }
            finally {
                await this.releaseConnection(conn);
            }
        });
    }
    /** Current state of the resolved device: config + whether a live connection exists. */
    async status(extra) {
        const target = this.resolve(extra);
        const conn = this.findConnection(target);
        const connected = conn
            ? await conn.device
                .isConnected()
                .then(Boolean)
                .catch(() => false)
            : false;
        return {
            device: target.device,
            address: target.address,
            name: target.name,
            model: target.model,
            connected,
            deviceName: connected ? conn?.deviceName : undefined,
            protocol: connected ? conn?.protocol.name : undefined,
            settleMs: connected ? conn?.protocol.settleMs : undefined,
            lastSent: conn?.lastSent,
            configPath: configPath(),
        };
    }
    /** All live connections (used to show which named devices are currently connected). */
    async connections() {
        const list = [];
        for (const conn of this.conns.values()) {
            const connected = await conn.device
                .isConnected()
                .then(Boolean)
                .catch(() => false);
            list.push({ address: conn.address, name: conn.deviceName, model: conn.protocol.name, connected });
        }
        return list;
    }
    /**
     * Release the connection once the caller is done with it.
     *
     * A strip is single-client: while anything is connected it stops advertising,
     * so holding it locks the phone out. With warm 0 — the default — the strip is
     * therefore freed right here, before the operation returns. A positive warm
     * window only delays the release, which is an explicit opt-in for callers that
     * prefer reconnect latency over an always-free strip.
     */
    async releaseConnection(conn) {
        const warmMs = this.options.warmMs ?? 0;
        const existing = this.idleTimers.get(conn.address);
        if (existing)
            clearTimeout(existing);
        if (!this.conns.has(conn.address))
            return;
        if (warmMs <= 0) {
            await this.closeConnection(conn.address);
            return;
        }
        const timer = setTimeout(() => {
            void this.closeConnection(conn.address).catch(() => undefined);
        }, warmMs);
        timer.unref();
        this.idleTimers.set(conn.address, timer);
    }
    /**
     * Forget one connection: cancel its timer, disconnect the device and let the
     * adapter finish scanning if nothing else is being held.
     */
    async closeConnection(address) {
        const timer = this.idleTimers.get(address);
        if (timer) {
            clearTimeout(timer);
            this.idleTimers.delete(address);
        }
        const conn = this.conns.get(address);
        this.conns.delete(address);
        if (conn) {
            await conn.device
                .disconnect()
                .catch((error) => debug(`disconnect ${address}: ${errorText(error)}`));
        }
        if (this.adapter)
            await this.stopDiscoveryWhenIdle(this.adapter);
    }
    /** Disconnect everything and close the D-Bus session. */
    async close() {
        for (const timer of this.idleTimers.values())
            clearTimeout(timer);
        this.idleTimers.clear();
        for (const address of [...this.conns.keys()])
            await this.closeConnection(address);
        if (this.adapter && this.startedDiscovery) {
            await this.adapter.stopDiscovery().catch((error) => debug(`stop discovery: ${errorText(error)}`));
            this.startedDiscovery = false;
        }
        if (this.destroySession) {
            try {
                this.destroySession();
            }
            catch (error) {
                debug(`destroy session: ${errorText(error)}`);
            }
            this.destroySession = undefined;
        }
        this.bluetooth = undefined;
        this.adapter = undefined;
    }
}
//# sourceMappingURL=ble.js.map