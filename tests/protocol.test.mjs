/**
 * Protocol-layer tests (no Bluetooth required).
 *
 * Run via the built-in node:test against the compiled dist/ — so `npm test`
 * builds the project first. No hardware is needed here: the tests cover the
 * packets (reference bytes captured from a real ELK-BLEDDM), the input parsers
 * and notification decoding.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
    Protocol,
    decodePacket,
    findModel,
    formatHex,
    listModels,
    pack,
    parseColor,
    parseHexPacket,
    pctToIntensity,
} from "../dist/protocol.js"

const hex = (buffer) => Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join(" ")

test("the model registry loads", () => {
    const models = listModels()
    assert.ok(models.length > 10, `expected many models, got ${models.length}`)
    assert.ok(models.some((model) => model.name === "ELK-BLEDDM"))
})

test("the model is detected from the device name", () => {
    assert.equal(findModel("ELK-BLEDDM")?.name, "ELK-BLEDDM")
    assert.equal(findModel("elk-bleddm")?.name, "ELK-BLEDDM")
    // Prefix: real names often carry suffixes like ELK-BLEDOM0E.
    assert.equal(findModel("ELK-BLEDOM0E")?.name, "ELK-BLEDOM0E")
    assert.equal(findModel("LEDBLE-ABCD")?.name, "LEDBLE")
    assert.equal(findModel("HUAWEI FreeBuds 4i"), undefined)
    assert.equal(findModel(undefined), undefined)
})

test("Protocol.forDevice: override and default", () => {
    assert.equal(Protocol.forDevice("ELK-BLEDDM").name, "ELK-BLEDDM")
    assert.equal(Protocol.forDevice("unknown-device").name, "ELK-BLEDDM")
    assert.equal(Protocol.forDevice("ELK-BLEDDM", "ELK-BTC").name, "ELK-BTC")
    assert.throws(() => Protocol.forDevice("ELK-BLEDDM", "no-such-model"), /is not in the registry/)
})

test("ELK-BLEDDM packets match the hardware reference", () => {
    const protocol = Protocol.forDevice("ELK-BLEDDM")
    assert.equal(hex(protocol.turnOn()), "7e 04 04 f0 00 01 ff 00 ef")
    assert.equal(hex(protocol.turnOff()), "7e 04 04 00 00 00 ff 00 ef")
    assert.equal(hex(protocol.color({ r: 255, g: 0, b: 0 })), "7e 00 05 03 ff 00 00 00 ef")
    assert.equal(hex(protocol.brightness(100)), "7e 04 01 64 ff 00 ff 00 ef")
    assert.equal(hex(protocol.brightness(50)), "7e 04 01 32 ff 00 ff 00 ef")
    assert.equal(protocol.settleMs, 300)
})

test("pack fills the placeholders and converts intensity", () => {
    // 'i' in models.json is on the 0-255 scale, while the controller expects percents 0-100.
    assert.equal(hex(pack([0x7e, 0x04, 0x01, "i", 0xff, 0, 0xff, 0, 0xef], { i: 255 })), "7e 04 01 64 ff 00 ff 00 ef")
    assert.equal(hex(pack([0x7e, 0x04, 0x01, "i", 0xff, 0, 0xff, 0, 0xef], { i: 0 })), "7e 04 01 00 ff 00 ff 00 ef")
    // Out-of-range values are clamped, not wrapped.
    assert.equal(hex(pack(["v"], { v: 999 })), "ff")
    assert.equal(hex(pack(["v"], { v: -5 })), "00")
    // A missing placeholder is an explicit error, not a zero byte.
    assert.throws(() => pack(["r"], {}), /has no placeholder/)
})

test("percent → intensity", () => {
    assert.equal(pctToIntensity(0), 0)
    assert.equal(pctToIntensity(100), 255)
    assert.equal(pctToIntensity(50), 128)
    assert.equal(pctToIntensity(150), 255)
    assert.equal(pctToIntensity(-10), 0)
})

test("color temperature: the edges clamp to the model range", () => {
    const protocol = Protocol.forDevice("ELK-BLEDDM")
    // 1800 K is fully warm (w=100, c=0), 7000 K is fully cool.
    assert.deepEqual(Array.from(protocol.colorTemp(1800)), [0x7e, 0x00, 0x05, 0x02, 100, 0, 0, 0, 0xef])
    assert.deepEqual(Array.from(protocol.colorTemp(7000)), [0x7e, 0x00, 0x05, 0x02, 0, 100, 0, 0, 0xef])
    // Out of range — without overflowing a byte.
    assert.equal(protocol.colorTemp(99999)[4], 0)
})

test("parseColor understands all three formats", () => {
    assert.deepEqual(parseColor("#ff8800"), { r: 255, g: 136, b: 0 })
    assert.deepEqual(parseColor("ff8800"), { r: 255, g: 136, b: 0 })
    assert.deepEqual(parseColor("f80"), { r: 255, g: 136, b: 0 })
    assert.deepEqual(parseColor("255,136,0"), { r: 255, g: 136, b: 0 })
    assert.deepEqual(parseColor("255 136 0"), { r: 255, g: 136, b: 0 })
    assert.throws(() => parseColor("#xyz"), /could not parse color/)
    assert.throws(() => parseColor("300,0,0"), /could not parse color/)
})

test("parseHexPacket accepts spaces, commas and 0x", () => {
    assert.equal(hex(parseHexPacket("7e 04 04 f0 00 01 ff 00 ef")), "7e 04 04 f0 00 01 ff 00 ef")
    assert.equal(hex(parseHexPacket("7e0404f000 01ff00ef")), "7e 04 04 f0 00 01 ff 00 ef")
    assert.equal(hex(parseHexPacket("0x7e, 0x04, 0xef")), "7e 04 ef")
    assert.equal(hex(parseHexPacket("7E0404F00001FF00EF")), "7e 04 04 f0 00 01 ff 00 ef")
    assert.throws(() => parseHexPacket("7e0"), /could not parse hex/)
    assert.throws(() => parseHexPacket("zz"), /could not parse hex/)
})

test("formatHex and notification decoding", () => {
    assert.equal(formatHex(Uint8Array.from([0x7e, 0x00, 0xef])), "7e 00 ef")

    // An echo of our own command — the most common case for BLEDDM.
    const echo = decodePacket(parseHexPacket("7e 04 04 f0 00 01 ff 00 ef"))
    assert.equal(echo.isPacket, true)
    assert.equal(echo.cmd, 0x04)
    assert.equal(echo.looksLikeEcho, true)
    assert.equal(echo.state, undefined)

    // Garbage, not a protocol packet.
    const garbage = decodePacket(Uint8Array.from([0x01, 0x02]))
    assert.equal(garbage.isPacket, false)
    assert.equal(garbage.looksLikeEcho, undefined)

    // A state reply (cmd = 0x01) — some variants support it.
    const state = decodePacket(parseHexPacket("7e 00 01 23 ff 00 00 64 00 ef"))
    assert.equal(state.cmd, 0x01)
    assert.equal(state.looksLikeEcho, undefined)
    assert.equal(state.state?.on, true)
    assert.deepEqual(state.state?.rgb, { r: 255, g: 0, b: 0 })
    assert.equal(state.state?.rgbHex, "#ff0000")
    assert.equal(state.state?.brightnessPct, 100)
})

test("a model without the command gives a clear error", () => {
    // ELK-BTCW only supports on/off/brightness — it has no effects.
    const protocol = Protocol.forDevice("ELK-BTCW")
    assert.throws(() => protocol.effect(1), /does not support the command|has no placeholder/)
})

test("the effect catalog is known in advance per model", () => {
    // The strip cannot report its effects over BLE (the controller is
    // write-only), so the name → index table is static data baked in at build
    // time — this is what spares the agent a trip to the internet.
    const bleddm = Protocol.forDevice("ELK-BLEDDM")
    assert.equal(bleddm.effectsClass, "EFFECTS")
    assert.equal(bleddm.supportsEffects, true)
    assert.equal(bleddm.supportsEffectSpeed, true)
    assert.ok(bleddm.effects.length >= 20, `expected many effects, got ${bleddm.effects.length}`)
    assert.ok(
        bleddm.effects.some((effect) => effect.name === "blink_red" && effect.index === 150),
        "blink_red must be 150 in the EFFECTS class",
    )

    // Another family, another catalog: MELK-OA21 is EFFECTS_STRIPX with 200+ effects.
    const stripx = Protocol.forDevice("MELK-OA21")
    assert.equal(stripx.effectsClass, "EFFECTS_STRIPX")
    assert.ok(stripx.effects.length > 200, `expected many effects, got ${stripx.effects.length}`)
    // Its music effects have indexes above 255 — they must not be clamped away.
    assert.ok(stripx.effectRange.max >= 391)
    assert.ok(stripx.effects.some((effect) => effect.name === "music_flow_flash" && effect.index === 384))
})

test("resolveEffect accepts numbers, numeric strings and names", () => {
    const protocol = Protocol.forDevice("ELK-BLEDDM")
    assert.equal(protocol.resolveEffect(3), 3)
    assert.equal(protocol.resolveEffect("3"), 3)
    assert.equal(protocol.resolveEffect("blink_red"), 150)
    // Case and separators do not matter: how a human types it vs how the app spells it.
    assert.equal(protocol.resolveEffect("Blink Red"), 150)
    assert.equal(protocol.resolveEffect("blink-red"), 150)
    // An unknown name is an explicit error listing what IS known.
    assert.throws(() => protocol.resolveEffect("disco"), /unknown effect "disco".*blink_red/s)
})

test("an effect by name builds the same packet as by number", () => {
    const protocol = Protocol.forDevice("ELK-BLEDDM")
    assert.equal(hex(protocol.effect(protocol.resolveEffect("blink_red"))), hex(protocol.effect(150)))
})

test("the speed range comes from the model", () => {
    // ELK-BLEDOB declares 0-183; the rest defaults to 0-255.
    assert.deepEqual(Protocol.forDevice("ELK-BLEDOB").effectSpeedRange, { min: 0, max: 183 })
    assert.deepEqual(Protocol.forDevice("ELK-BLEDDM").effectSpeedRange, { min: 0, max: 255 })
    const bleddm = Protocol.forDevice("ELK-BLEDDM")
    assert.equal(bleddm.speed(200)[3], 200)
    // Out-of-range speed is clamped, not wrapped.
    assert.equal(bleddm.speed(9999)[3], 255)
})
