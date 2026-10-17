/**
 * Fake BLE session for the transport tests.
 *
 * `BleLed` reaches Bluetooth only through `createBluetooth()`, so injecting this
 * fake gives full control over connect/disconnect without any hardware. It
 * records what happened so the tests can assert on the real invariants: how many
 * times a connection was opened, whether the strip was released, and how many
 * packets were written.
 */

import { findModel } from "../dist/protocol.js"

const DEFAULT_WRITE_UUID = "0000fff3-0000-1000-8000-00805f9b34fb"
const DEFAULT_NOTIFY_UUID = "0000fff4-0000-1000-8000-00805f9b34fb"

/**
 * @param {{ modelName?: string, failWrites?: (written: number) => boolean }} [options]
 */
export function createFakeBle(options = {}) {
    const modelName = options.modelName ?? "ELK-BLEDOB"
    const model = findModel(modelName)
    const writeUuid = model?.write_uuid ?? DEFAULT_WRITE_UUID
    const notifyUuid = model?.read_uuid ?? DEFAULT_NOTIFY_UUID
    const failWrites = options.failWrites ?? (() => false)

    const log = {
        connects: 0,
        disconnects: 0,
        writes: [],
        discovered: false,
        discovers: 0,
        undiscover: 0,
        destroyed: 0,
    }

    let connected = false

    const write = {
        uuid: writeUuid,
        async getFlags() {
            return ["write"]
        },
        async writeValueWithResponse(buffer) {
            if (failWrites(log.writes.length)) throw new Error("fake write failure")
            log.writes.push(Buffer.from(buffer))
        },
        async writeValueWithoutResponse(buffer) {
            if (failWrites(log.writes.length)) throw new Error("fake write failure")
            log.writes.push(Buffer.from(buffer))
        },
    }

    const service = {
        async characteristics() {
            return [writeUuid, notifyUuid]
        },
        async getCharacteristic(uuid) {
            return { ...write, uuid }
        },
    }

    const gatt = {
        async services() {
            return ["0000fff0-0000-1000-8000-00805f9b34fb"]
        },
        async getPrimaryService() {
            return service
        },
    }

    const device = {
        address: "AA:BB:CC:DD:EE:01",
        async getName() {
            return modelName
        },
        async getAlias() {
            return modelName
        },
        async getRSSI() {
            return -55
        },
        async getAddressType() {
            return "public"
        },
        async isConnected() {
            return connected
        },
        async connect() {
            connected = true
            log.connects++
        },
        async disconnect() {
            connected = false
            log.disconnects++
        },
        async gatt() {
            return gatt
        },
        /** Simulate the strip dropping the link on its own (sleep, phone stole it). */
        dropLink() {
            connected = false
        },
    }

    const adapter = {
        async getAddress() {
            return "11:22:33:44:55:66"
        },
        async isDiscovering() {
            return log.discovered
        },
        async startDiscovery() {
            log.discovered = true
            log.discovers++
        },
        async stopDiscovery() {
            log.discovered = false
            log.undiscover++
        },
        async devices() {
            return [device.address]
        },
        async getDevice() {
            return device
        },
        async waitDevice() {
            return device
        },
    }

    const createBluetooth = () => ({
        bluetooth: {
            async defaultAdapter() {
                return adapter
            },
        },
        destroy() {
            log.destroyed++
        },
    })

    return { createBluetooth, log, device, modelName }
}
