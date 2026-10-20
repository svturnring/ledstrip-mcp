/**
 * MCP-level test for ble_apply over an in-memory transport (no hardware).
 *
 * Ble_apply is the only write path: it must run an ordered batch over a single
 * connection, release the channel when the call returns, and — per the product
 * decision — skip the actions the detected model does not support while still
 * applying the rest.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { BleLed } from "../dist/ble.js"
import { registerTools } from "../dist/mcp.js"
import { createFakeBle } from "./fake-ble.mjs"

const ADDRESS = "AA:BB:CC:DD:EE:01"

/** Wire an McpServer with the real tool set to a real client over an in-memory pair. */
async function connectClient(led) {
    const server = new McpServer({ name: "ledstrip-mcp-test", version: "0" })
    registerTools(server, led)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test-client", version: "0" })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return client
}

test("ble_apply runs a batch over one connection and releases the channel", async () => {
    const fake = createFakeBle()
    const led = new BleLed({
        warmMs: 0,
        target: { address: ADDRESS, model: fake.modelName },
        createBluetooth: fake.createBluetooth,
    })
    const client = await connectClient(led)

    const response = await client.callTool({
        name: "ble_apply",
        arguments: {
            actions: [
                { type: "brightness", percent: 100 },
                { type: "color", color: "#ff0000" },
            ],
        },
    })

    const payload = response.structuredContent
    assert.equal(payload.applied.length, 2)
    assert.equal(payload.skipped.length, 0)
    assert.equal(payload.released, true)
    assert.equal(fake.log.writes.length, 2)
    assert.equal(fake.log.connects, 1, "the whole batch must share one connection")
    assert.equal(fake.log.disconnects, 1, "the channel must be released when the call returns")
    assert.deepEqual(await led.connections(), [])

    await client.close()
    await led.close()
})

test("ble_apply skips an unsupported action and still applies the rest", async () => {
    // ELK-BTCW has no color/effect commands, so those actions must be reported
    // as skipped while brightness still goes through.
    const fake = createFakeBle({ modelName: "ELK-BTCW" })
    const led = new BleLed({
        warmMs: 0,
        target: { address: ADDRESS, model: "ELK-BTCW" },
        createBluetooth: fake.createBluetooth,
    })
    const client = await connectClient(led)

    const response = await client.callTool({
        name: "ble_apply",
        arguments: {
            actions: [
                { type: "brightness", percent: 50 },
                { type: "color", color: "#00ff00" },
                { type: "effect", index: 2 },
            ],
        },
    })

    const payload = response.structuredContent
    assert.equal(payload.applied.length, 1, "brightness must still be applied")
    assert.equal(payload.applied[0].index, 0)
    assert.equal(payload.skipped.length, 2, "color and effect are unsupported by ELK-BTCW")
    assert.deepEqual(
        payload.skipped.map((item) => item.action.type),
        ["color", "effect"],
    )
    for (const item of payload.skipped) {
        assert.match(item.error, /does not support the command/)
    }
    assert.equal(fake.log.writes.length, 1)
    assert.equal(fake.log.connects, 1)
    assert.equal(fake.log.disconnects, 1)

    await client.close()
    await led.close()
})

test("ble_apply sets an effect by name and reports an unknown one", async () => {
    const fake = createFakeBle({ modelName: "ELK-BLEDDM" })
    const led = new BleLed({
        warmMs: 0,
        target: { address: ADDRESS, model: "ELK-BLEDDM" },
        createBluetooth: fake.createBluetooth,
    })
    const client = await connectClient(led)

    const response = await client.callTool({
        name: "ble_apply",
        arguments: {
            actions: [
                { type: "effect", name: "blink_red" },
                { type: "effect", name: "no-such-effect" },
            ],
        },
    })

    const payload = response.structuredContent
    assert.equal(payload.applied.length, 1, "blink_red must go through")
    // blink_red is index 150 in the EFFECTS class; the effect byte is at offset 3.
    assert.equal(fake.log.writes[0][3], 150)
    assert.equal(payload.skipped.length, 1, "an unknown name must be skipped and reported, not sent")
    assert.match(payload.skipped[0].error, /unknown effect "no-such-effect"/)
    assert.equal(fake.log.writes.length, 1)

    await client.close()
    await led.close()
})

test("ble_apply drives the microphone: on, sensitivity, mode", async () => {
    const fake = createFakeBle({ modelName: "ELK-BLEDDM" })
    const led = new BleLed({
        warmMs: 0,
        target: { address: ADDRESS, model: "ELK-BLEDDM" },
        createBluetooth: fake.createBluetooth,
    })
    const client = await connectClient(led)

    const response = await client.callTool({
        name: "ble_apply",
        arguments: {
            actions: [
                { type: "power", state: "on" },
                { type: "mic", state: "on" },
                { type: "mic_sensitivity", percent: 80 },
                { type: "mic_effect", name: "soft" },
            ],
        },
    })

    const payload = response.structuredContent
    assert.equal(payload.applied.length, 4)
    assert.equal(payload.skipped.length, 0)
    assert.equal(payload.applied[1].packet, "7e 04 07 01 ff ff ff 00 ef", "enable_mic")
    assert.equal(payload.applied[2].packet, "7e 04 06 50 ff ff ff 00 ef", "mic_sensitivity 80")
    assert.equal(payload.applied[3].packet, "7e 05 03 81 04 ff ff 00 ef", "soft = 0x81")

    await client.close()
    await led.close()
})

test("ble_apply an effect in the mic range uses the mic packet automatically", async () => {
    const fake = createFakeBle({ modelName: "ELK-BLEDDM" })
    const led = new BleLed({
        warmMs: 0,
        target: { address: ADDRESS, model: "ELK-BLEDDM" },
        createBluetooth: fake.createBluetooth,
    })
    const client = await connectClient(led)

    const response = await client.callTool({
        name: "ble_apply",
        arguments: { actions: [{ type: "effect", index: 128 }] },
    })

    const payload = response.structuredContent
    assert.equal(payload.applied.length, 1)
    // byte1=05/byte4=04 mic shape, NOT the generic effect template.
    assert.equal(payload.applied[0].packet, "7e 05 03 80 04 ff ff 00 ef")

    // An out-of-range mic mode is rejected by the schema (128-135): the call
    // fails as a whole, nothing reaches the strip.
    const bad = await client.callTool({
        name: "ble_apply",
        arguments: { actions: [{ type: "mic_effect", index: 140 }] },
    })
    assert.equal(bad.isError, true, "index 140 must fail schema validation")

    await client.close()
    await led.close()
})

test("ble_effects lists the catalog of the detected model without connecting", async () => {
    const fake = createFakeBle({ modelName: "ELK-BLEDDM" })
    const led = new BleLed({
        warmMs: 0,
        target: { address: ADDRESS, model: "ELK-BLEDDM" },
        createBluetooth: fake.createBluetooth,
    })
    const client = await connectClient(led)

    const response = await client.callTool({ name: "ble_effects", arguments: {} })

    const payload = response.structuredContent
    assert.equal(payload.model, "ELK-BLEDDM")
    assert.equal(payload.effectsClass, "EFFECTS")
    assert.equal(payload.supportsEffects, true)
    assert.equal(payload.supportsEffectSpeed, true)
    assert.ok(
        payload.effects.some((effect) => effect.name === "blink_red" && effect.index === 150),
        "the catalog must contain blink_red=150",
    )
    assert.ok(
        payload.micModes.some((mode) => mode.name === "soft" && mode.index === 129),
        "micModes must list the controller-mic reaction modes",
    )
    assert.deepEqual(payload.micSensitivityRange, { min: 0, max: 100 })
    assert.equal(fake.log.connects, 0, "browsing the catalog must not touch the device")

    await client.close()
    await led.close()
})

test("ble_effects with an explicit model shows that model's catalog", async () => {
    const fake = createFakeBle()
    const led = new BleLed({ warmMs: 0, createBluetooth: fake.createBluetooth })
    const client = await connectClient(led)

    const response = await client.callTool({ name: "ble_effects", arguments: { model: "MELK-OA21" } })

    const payload = response.structuredContent
    assert.equal(payload.model, "MELK-OA21")
    assert.equal(payload.effectsClass, "EFFECTS_STRIPX")
    assert.ok(payload.effects.length > 200, `expected many effects, got ${payload.effects.length}`)
    assert.ok(payload.effects.some((effect) => effect.name === "music_flow_flash"))

    // An unknown model is an error, not a silent default.
    const bad = await client.callTool({ name: "ble_effects", arguments: { model: "no-such-model" } })
    assert.equal(bad.isError, true)
    assert.match(bad.structuredContent.error, /is not in the registry/)

    await client.close()
    await led.close()
})
