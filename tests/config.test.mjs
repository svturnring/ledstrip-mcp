/**
 * Config-layer tests (no Bluetooth required).
 *
 * Cover the named-device registry that powers multi-strip control: aliases,
 * the default device, priority of explicit arguments over the config, and the
 * name-based device classifier. Each test points BLE_MCP_CONFIG_DIR at a fresh
 * temp directory, so nothing touches the real ~/.config/ble-mcp.
 */

import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

// Must be set before the first config call. configDir() reads the env on every
// call, so a per-process temp dir is enough. Ambient BLE_MCP_* is cleared so the
// tests only see what they seed.
process.env.BLE_MCP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ble-mcp-test-"))
for (const key of ["BLE_MCP_ADDRESS", "BLE_MCP_NAME", "BLE_MCP_MODEL", "BLE_MCP_DEVICE"]) {
    delete process.env[key]
}

const { addDevice, configPath, defaultDevice, listDevices, loadConfig, removeDevice, resolveTarget, setDefaultDevice } =
    await import("../dist/config.js")
const { classifyDeviceName } = await import("../dist/protocol.js")

/** Replace the whole config with the given object. */
function seed(config) {
    mkdirSync(process.env.BLE_MCP_CONFIG_DIR, { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

test("addDevice создаёт и обновляет именованные устройства", () => {
    seed({})
    addDevice("спальня", { address: "AA:BB:CC:DD:EE:01", name: "ELK-BLEDDM" })
    addDevice("гостиная", { address: "AA:BB:CC:DD:EE:02" }, { makeDefault: true })

    const devices = listDevices()
    assert.equal(devices["спальня"].address, "AA:BB:CC:DD:EE:01")
    assert.equal(devices["спальня"].name, "ELK-BLEDDM")
    assert.equal(devices["гостиная"].address, "AA:BB:CC:DD:EE:02")
    assert.equal(defaultDevice(), "гостиная")

    // Merging keeps untouched fields.
    addDevice("спальня", { model: "ELK-BLEDOM" })
    assert.equal(listDevices()["спальня"].address, "AA:BB:CC:DD:EE:01")
    assert.equal(listDevices()["спальня"].model, "ELK-BLEDOM")
})

test("removeDevice убирает устройство и сбрасывает default", () => {
    seed({})
    addDevice("спальня", { address: "AA:BB:CC:DD:EE:01" }, { makeDefault: true })
    removeDevice("спальня")
    assert.equal(listDevices()["спальня"], undefined)
    assert.equal(defaultDevice(), undefined)
    assert.throws(() => removeDevice("спальня"), /не найдено в конфиге/)
})

test("setDefaultDevice требует существующее устройство", () => {
    seed({})
    addDevice("спальня", { address: "AA:BB:CC:DD:EE:01" })
    addDevice("гостиная", { address: "AA:BB:CC:DD:EE:02" })
    setDefaultDevice("гостиная")
    assert.equal(defaultDevice(), "гостиная")
    assert.throws(() => setDefaultDevice("кухня"), /не найдено в конфиге/)
})

test("resolveTarget берёт адрес из алиаса устройства", () => {
    seed({
        default: "гостиная",
        devices: {
            гостиная: { address: "AA:BB:CC:DD:EE:02", name: "ELK-BLEDOM" },
            спальня: { address: "AA:BB:CC:DD:EE:01", name: "ELK-BLEDDM" },
        },
    })

    const byAlias = resolveTarget({ device: "спальня" })
    assert.equal(byAlias.address, "AA:BB:CC:DD:EE:01")
    assert.equal(byAlias.name, "ELK-BLEDDM")
    assert.equal(byAlias.device, "спальня")

    // No alias — the config default applies.
    const fallback = resolveTarget()
    assert.equal(fallback.address, "AA:BB:CC:DD:EE:02")
    assert.equal(fallback.device, "гостиная")
})

test("resolveTarget: явные аргументы важнее конфига", () => {
    seed({ devices: { спальня: { address: "AA:BB:CC:DD:EE:01" } } })
    const target = resolveTarget({ device: "спальня", address: "11:22:33:44:55:66" })
    assert.equal(target.address, "11:22:33:44:55:66")
})

test("resolveTarget ругается на неизвестный алиас", () => {
    seed({ devices: { спальня: { address: "AA:BB:CC:DD:EE:01" } } })
    assert.throws(() => resolveTarget({ device: "кухня" }), /не найдено в конфиге/)
})

test("resolveTarget без настроенных устройств даёт понятную ошибку", () => {
    seed({})
    assert.throws(() => resolveTarget(), /устройства ещё не привязаны/)
})

test("resolveTarget: ad-hoc аргументы работают без конфига", () => {
    seed({})
    const target = resolveTarget({ address: "AA:BB:CC:DD:EE:09", model: "ELK-BLEDOM" })
    assert.equal(target.address, "AA:BB:CC:DD:EE:09")
    assert.equal(target.model, "ELK-BLEDOM")
    assert.equal(target.device, undefined)
})

test("classifyDeviceName: реестр, эвристика и мусор", () => {
    const known = classifyDeviceName("ELK-BLEDDM")
    assert.equal(known.likely, true)
    assert.equal(known.confidence, "model")
    assert.equal(known.model, "ELK-BLEDDM")

    const heuristic = classifyDeviceName("Triones-ABCD")
    assert.equal(heuristic.likely, true)
    assert.equal(heuristic.confidence, "name")

    const unrelated = classifyDeviceName("HUAWEI FreeBuds 4i")
    assert.equal(unrelated.likely, false)
    assert.equal(unrelated.confidence, "unlikely")

    const anonymous = classifyDeviceName(undefined)
    assert.equal(anonymous.likely, false)
})

test("loadConfig возвращает объект даже без файла", () => {
    seed({})
    assert.deepEqual(loadConfig(), {})
})
