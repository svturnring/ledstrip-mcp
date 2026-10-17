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
    const server = new McpServer({ name: "ble-mcp-test", version: "0" })
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
