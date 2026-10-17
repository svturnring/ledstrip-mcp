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

test("addDevice creates and updates named devices", () => {
    seed({})
    addDevice("bedroom", { address: "AA:BB:CC:DD:EE:01", name: "ELK-BLEDDM" })
    addDevice("living-room", { address: "AA:BB:CC:DD:EE:02" }, { makeDefault: true })

    const devices = listDevices()
    assert.equal(devices["bedroom"].address, "AA:BB:CC:DD:EE:01")
    assert.equal(devices["bedroom"].name, "ELK-BLEDDM")
    assert.equal(devices["living-room"].address, "AA:BB:CC:DD:EE:02")
    assert.equal(defaultDevice(), "living-room")

    // Merging keeps untouched fields.
    addDevice("bedroom", { model: "ELK-BLEDOM" })
    assert.equal(listDevices()["bedroom"].address, "AA:BB:CC:DD:EE:01")
    assert.equal(listDevices()["bedroom"].model, "ELK-BLEDOM")
})

test("removeDevice removes a device and resets the default", () => {
    seed({})
    addDevice("bedroom", { address: "AA:BB:CC:DD:EE:01" }, { makeDefault: true })
    removeDevice("bedroom")
    assert.equal(listDevices()["bedroom"], undefined)
    assert.equal(defaultDevice(), undefined)
    assert.throws(() => removeDevice("bedroom"), /is not present in the config/)
})

test("setDefaultDevice requires an existing device", () => {
    seed({})
    addDevice("bedroom", { address: "AA:BB:CC:DD:EE:01" })
    addDevice("living-room", { address: "AA:BB:CC:DD:EE:02" })
    setDefaultDevice("living-room")
    assert.equal(defaultDevice(), "living-room")
    assert.throws(() => setDefaultDevice("kitchen"), /is not present in the config/)
})

test("resolveTarget takes the address from the device alias", () => {
    seed({
        default: "living-room",
        devices: {
            "living-room": { address: "AA:BB:CC:DD:EE:02", name: "ELK-BLEDOM" },
            bedroom: { address: "AA:BB:CC:DD:EE:01", name: "ELK-BLEDDM" },
        },
    })

    const byAlias = resolveTarget({ device: "bedroom" })
    assert.equal(byAlias.address, "AA:BB:CC:DD:EE:01")
    assert.equal(byAlias.name, "ELK-BLEDDM")
    assert.equal(byAlias.device, "bedroom")

    // No alias — the config default applies.
    const fallback = resolveTarget()
    assert.equal(fallback.address, "AA:BB:CC:DD:EE:02")
    assert.equal(fallback.device, "living-room")
})

test("resolveTarget: explicit arguments win over the config", () => {
    seed({ devices: { bedroom: { address: "AA:BB:CC:DD:EE:01" } } })
    const target = resolveTarget({ device: "bedroom", address: "11:22:33:44:55:66" })
    assert.equal(target.address, "11:22:33:44:55:66")
})

test("resolveTarget rejects an unknown alias", () => {
    seed({ devices: { bedroom: { address: "AA:BB:CC:DD:EE:01" } } })
    assert.throws(() => resolveTarget({ device: "kitchen" }), /is not present in the config/)
})

test("resolveTarget without configured devices gives a clear error", () => {
    seed({})
    assert.throws(() => resolveTarget(), /no devices attached yet/)
})

test("resolveTarget: ad-hoc arguments work without a config", () => {
    seed({})
    const target = resolveTarget({ address: "AA:BB:CC:DD:EE:09", model: "ELK-BLEDOM" })
    assert.equal(target.address, "AA:BB:CC:DD:EE:09")
    assert.equal(target.model, "ELK-BLEDOM")
    assert.equal(target.device, undefined)
})

test("classifyDeviceName: registry, heuristics and junk", () => {
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

test("loadConfig returns an object even without a file", () => {
    seed({})
    assert.deepEqual(loadConfig(), {})
})
