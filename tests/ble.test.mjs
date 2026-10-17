/**
 * Transport tests against a fake BLE session (no hardware).
 *
 * The invariant under test: a strip is single-client, so the connection must be
 * released as soon as an operation returns (warm 0), on every path — success,
 * failed write, exception and a dropped link — otherwise the strip stays
 * occupied and nothing else can reach it until the process dies.
 */

import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { test } from "node:test"

import { BleLed } from "../dist/ble.js"
import { createFakeBle } from "./fake-ble.mjs"

const ADDRESS = "AA:BB:CC:DD:EE:01"

function makeLed(fake, extra = {}) {
    return new BleLed({
        warmMs: 0,
        target: { address: ADDRESS, model: fake.modelName },
        createBluetooth: fake.createBluetooth,
        ...extra,
    })
}

test("a command releases the channel before it returns", async () => {
    const fake = createFakeBle()
    const led = makeLed(fake)

    const result = await led.send((protocol) => protocol.turnOn())

    assert.equal(result.sent.length, 1)
    assert.equal(fake.log.connects, 1)
    assert.equal(fake.log.disconnects, 1, "the strip must be released immediately")
    assert.equal(await fake.device.isConnected(), false)
    assert.deepEqual(await led.connections(), [], "nothing may stay in the connection pool")
    assert.equal(fake.log.discovered, false, "the scan started for the connection must be stopped")

    await led.close()
})

test("a batch is one connection and is released at the end", async () => {
    const fake = createFakeBle()
    const led = makeLed(fake)

    const result = await led.send((protocol) => [
        protocol.brightness(100),
        protocol.color({ r: 255, g: 0, b: 0 }),
        protocol.effect(3),
    ])

    assert.equal(result.sent.length, 3)
    assert.equal(fake.log.writes.length, 3)
    assert.equal(fake.log.connects, 1, "a batch must not reconnect per command")
    assert.equal(fake.log.disconnects, 1)
    assert.equal(await fake.device.isConnected(), false)

    await led.close()
})

test("a failed write still releases the channel", async () => {
    const fake = createFakeBle({ failWrites: () => true })
    const led = makeLed(fake)

    await assert.rejects(() => led.send((protocol) => protocol.turnOn()))

    assert.equal(fake.log.disconnects, 1, "a broken link must not be left connected")
    assert.equal(await fake.device.isConnected(), false)
    assert.deepEqual(await led.connections(), [])
    assert.equal(fake.log.discovered, false)

    await led.close()
})

test("a link dropped by the strip is not reused as a corpse", async () => {
    const fake = createFakeBle()
    const led = makeLed(fake)

    await led.send((protocol) => protocol.turnOn())
    assert.equal(fake.log.connects, 1)

    // The strip slept or the phone grabbed it: our pool still holds the connection.
    fake.device.dropLink()

    await led.send((protocol) => protocol.turnOn())

    assert.equal(fake.log.connects, 2, "a dead pooled connection must be rebuilt")
    assert.equal(await fake.device.isConnected(), false)

    await led.close()
})

test("a warm window delays the release instead of dropping it", async () => {
    const fake = createFakeBle()
    const led = makeLed(fake, { warmMs: 200 })

    await led.send((protocol) => protocol.turnOn())
    assert.equal(await fake.device.isConnected(), true, "warm > 0 keeps the connection")

    await sleep(320)
    assert.equal(await fake.device.isConnected(), false, "the warm connection must be released eventually")
    assert.equal(fake.log.disconnects, 1)

    await led.close()
})
