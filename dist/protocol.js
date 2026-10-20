/**
 * Protocol of BLE LED-strip controllers of the
 * ELK-BLEDDM / ELK-BLEDOM / ELK-BTC / LEDBLE / MELK family and compatible ones.
 *
 * A packet is 9 bytes, written WITHOUT response (write without response):
 *
 *     7E | type/length | cmd | payload ... | EF
 *
 * Why this needs its own layer instead of just "write the bytes":
 *
 *  1. The controller SWALLOWS a command that arrives before the settle delay
 *     after the previous one (for ELK-BLEDDM that is ~300 ms, for ELK-BLEDOB
 *     ~100 ms), and it does so silently — no error, no reply. Hence the
 *     mandatory pause between writes.
 *  2. The controller is write-only: for any request it sends an ECHO of our own
 *     command on the notify channel instead of the real state. So "read
 *     on/color/brightness" is impossible and the state has to be remembered
 *     optimistically.
 *  3. Different models have different command bytes, different characteristic
 *     UUIDs and different versions of the same protocol (the registry lives in
 *     models.ts).
 */
import { effectsForClass } from "./effects.js";
import { MODELS, settleMsFor } from "./models.js";
/** Default service (some models use a different one, so the UUID comes from the model). */
export const DEFAULT_WRITE_UUID = "0000fff3-0000-1000-8000-00805f9b34fb";
export const DEFAULT_NOTIFY_UUID = "0000fff4-0000-1000-8000-00805f9b34fb";
export const HEADER = 0x7e;
export const FOOTER = 0xef;
/** The model the default is configured for (our strip). */
export const DEFAULT_MODEL_NAME = "ELK-BLEDDM";
export { settleMsFor, MODELS } from "./models.js";
export { effectsForClass, EFFECT_CLASS_NAMES } from "./effects.js";
export const MIC_EFFECT_MODES = [
    { name: "classic", index: 0x80, aliases: ["mic_energic"] },
    { name: "soft", index: 0x81, aliases: ["mic_rhythm"] },
    { name: "dynamic", index: 0x82, aliases: ["mic_spectrum"] },
    { name: "disco", index: 0x83, aliases: ["mic_rolling"] },
    { name: "mic_effect_4", index: 0x84 },
    { name: "mic_effect_5", index: 0x85 },
    { name: "mic_effect_6", index: 0x86 },
    { name: "mic_effect_7", index: 0x87 },
];
/** Range of microphone modes, inclusive. */
export const MIC_EFFECT_MIN = 0x80;
export const MIC_EFFECT_MAX = 0x87;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** Percents 0-100 → intensity 0-255. */
export const pctToIntensity = (pct) => Math.round((clamp(pct, 0, 100) / 100) * 255);
/** Intensity 0-255 → percents 0-100. */
export const intensityToPct = (intensity) => Math.round((clamp(intensity, 0, 255) / 255) * 100);
/**
 * Substitute values into a command template from the model registry.
 *
 * The only non-obvious detail: the `i` placeholder in models.json is defined on
 * the 0-255 scale, while the controller expects percents 0-100 — the same
 * conversion as in the HA integration (`int(intensity * 100 / 255)`).
 */
export function pack(template, values) {
    const bytes = template.map((byte) => {
        if (typeof byte === "number")
            return byte;
        const raw = values[byte];
        if (raw === undefined)
            throw new Error(`command template has no placeholder for byte "${byte}"`);
        const value = byte === "i" ? (raw * 100) / 255 : raw;
        return clamp(Math.round(value), 0, 255);
    });
    return Buffer.from(bytes);
}
/** Find a model by device name (prefix, longest match, generic variant preferred). */
export function findModel(deviceName) {
    if (!deviceName)
        return undefined;
    const lower = deviceName.trim().toLowerCase();
    const matches = MODELS.filter((model) => lower.startsWith(model.name.toLowerCase()));
    if (matches.length === 0)
        return undefined;
    matches.sort((a, b) => b.name.length - a.name.length);
    return matches.find((model) => model.handle === undefined) ?? matches[0];
}
export function listModels() {
    return [...MODELS].sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * Name patterns of controllers from the same ecosystem that are not (yet) in the
 * registry. BLE device names are arbitrary — they do NOT have to contain "BLE" —
 * so this is only a hint, never a guarantee.
 */
const LED_NAME_PATTERNS = [
    { pattern: /^elk[-_ ]?ble/i, hint: "ELK prefix — an ELK-BLED* controller" },
    { pattern: /^melk/i, hint: "MELK prefix" },
    { pattern: /ledble/i, hint: "LEDBLE" },
    { pattern: /lednet/i, hint: "LEDnet" },
    { pattern: /triones/i, hint: "Triones app" },
    { pattern: /happy[-_ ]?light/i, hint: "HappyLighting" },
    { pattern: /magic[-_ ]?(home|light)/i, hint: "MagicHome/MagicLight" },
    { pattern: /qhm/i, hint: "QHM prefix" },
    { pattern: /(^|[-_ ])led([-_ ]|\d|$)/i, hint: "name contains LED" },
    { pattern: /light|strip|[\u0400-\u04FF]/i, hint: "name contains light/strip" },
];
/**
 * Guess whether an advertising name belongs to an LED-strip controller.
 *
 * A registry match is fairly reliable; the rest is a soft hint, because the same
 * hardware ships under many random names.
 */
export function classifyDeviceName(name) {
    const trimmed = name?.trim();
    if (!trimmed) {
        return {
            likely: false,
            confidence: "unlikely",
            hint: "the device advertises no name — it cannot be identified by eye; go by RSSI and address",
        };
    }
    const model = findModel(trimmed);
    if (model) {
        return {
            likely: true,
            confidence: "model",
            model: model.name,
            hint: `known model from the registry: ${model.name}`,
        };
    }
    for (const { pattern, hint } of LED_NAME_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { likely: true, confidence: "name", hint: `looks like an LED controller: ${hint}` };
        }
    }
    return {
        likely: false,
        confidence: "unlikely",
        hint: "the name does not look like an LED controller — possibly a different device",
    };
}
/**
 * A wrapper over a model: builds concrete packets for a concrete strip.
 */
export class Protocol {
    model;
    constructor(model) {
        this.model = model;
    }
    /**
     * Pick a model: explicit override → device name → default.
     */
    static forDevice(deviceName, override) {
        const byOverride = findModel(override);
        if (override && !byOverride) {
            throw new Error(`model "${override}" is not in the registry, see: ledstrip-mcp models`);
        }
        return new Protocol(byOverride ?? findModel(deviceName) ?? findModel(DEFAULT_MODEL_NAME));
    }
    get name() {
        return this.model.name;
    }
    get writeUuid() {
        return this.model.write_uuid || DEFAULT_WRITE_UUID;
    }
    get notifyUuid() {
        return this.model.read_uuid ?? DEFAULT_NOTIFY_UUID;
    }
    /** Mandatory pause between commands. */
    get settleMs() {
        return this.model.settle_ms ?? settleMsFor(this.model.name);
    }
    get colorTempRange() {
        return {
            minKelvin: this.model.color_temp_range?.min_kelvin ?? 1800,
            maxKelvin: this.model.color_temp_range?.max_kelvin ?? 7000,
        };
    }
    build(kind, values, label) {
        const template = this.model.commands[kind];
        if (!template || template.length === 0) {
            throw new Error(`model ${this.name} does not support the command "${label}"`);
        }
        return pack(template, values);
    }
    turnOn() {
        return this.build("turn_on", {}, "turn on");
    }
    turnOff() {
        return this.build("turn_off", {}, "turn off");
    }
    color({ r, g, b }) {
        return this.build("color", { r, g, b }, "color");
    }
    /** White light, percents 0-100. */
    white(pct) {
        return this.build("white", { i: pctToIntensity(pct) }, "white");
    }
    /** Brightness, percents 0-100. */
    brightness(pct) {
        return this.build("brightness", { i: pctToIntensity(pct) }, "brightness");
    }
    /** Effect index (0-127 on most models, 128-135 are mic modes). */
    effect(value) {
        const index = Math.round(value);
        // 128-135 are microphone modes, not entries of the animation table:
        // the controller ignores them in the generic effect packet (verified
        // on ELK-BLEDDM — the strip stayed on the previous color) and only
        // reacts to the dedicated mic-effect packet shape (byte1=05, byte4=04).
        if (index >= MIC_EFFECT_MIN && index <= MIC_EFFECT_MAX && this.supportsEffects) {
            return this.micEffect(index);
        }
        return this.build("effect", { v: clamp(index, 0, this.effectRange.max) }, "effect");
    }
    /**
     * Switch the microphone reaction mode (0x80-0x87 / name): the controller
     * analyzes sound with its OWN microphone — one-shot, no audio streaming.
     * Packet shape is hardcoded in the upstream integration for all models.
     */
    micEffect(value) {
        if (!this.supportsEffects) {
            throw new Error(`model ${this.name} does not support the command "effect"`);
        }
        const index = typeof value === "number" ? Math.round(value) : this.resolveMicEffect(value);
        if (index < MIC_EFFECT_MIN || index > MIC_EFFECT_MAX) {
            const known = MIC_EFFECT_MODES.map((mode) => mode.name).join(", ");
            throw new Error(`mic effect must be ${MIC_EFFECT_MIN}-${MIC_EFFECT_MAX} (0x80-0x87), got ${index}. Known modes: ${known}`);
        }
        return Buffer.from([HEADER, 0x05, 0x03, index, 0x04, 0xff, 0xff, 0x00, FOOTER]);
    }
    /**
     * Turn the controller's microphone on/off. Upstream sends these packets
     * hardcoded for every model (the regular registry has no mic commands).
     */
    mic(state) {
        return Buffer.from([HEADER, 0x04, 0x07, state === "on" ? 0x01 : 0x00, 0xff, 0xff, 0xff, 0x00, FOOTER]);
    }
    /** Microphone sensitivity, 0-100 (the controller's own scale, not percents of anything else). */
    micSensitivity(value) {
        const level = clamp(Math.round(value), 0, 100);
        return Buffer.from([HEADER, 0x04, 0x06, level, 0xff, 0xff, 0xff, 0x00, FOOTER]);
    }
    /** Effect speed. */
    speed(value) {
        const { min, max } = this.effectSpeedRange;
        return this.build("effect_speed", { v: clamp(Math.round(value), min, max) }, "effect speed");
    }
    /** Named effects of this model's class, in the phone-app order. */
    get effects() {
        return effectsForClass(this.model.effects_class);
    }
    /** Microphone reaction modes (0x80-0x87), with upstream aliases. */
    get micModes() {
        return MIC_EFFECT_MODES;
    }
    /** The effects class of the model ("EFFECTS", "EFFECTS_STRIPX", ...). */
    get effectsClass() {
        return this.model.effects_class;
    }
    /** Whether the model has an effect command at all. */
    get supportsEffects() {
        return Boolean(this.model.commands.effect?.length);
    }
    /** Whether the model has an effect-speed command. */
    get supportsEffectSpeed() {
        return Boolean(this.model.commands.effect_speed?.length);
    }
    /** Range of effect indexes this model accepts. */
    get effectRange() {
        if (this.model.effect_range)
            return this.model.effect_range;
        // No declared range: 0-255 covers the classic indexes (and the 128-135
        // mic modes), but a catalog may know higher ones (EFFECTS_STRIPX goes
        // up to 391) — they must not be silently clamped away.
        const catalogMax = this.effects.reduce((max, effect) => Math.max(max, effect.index), 0);
        return { min: 0, max: Math.max(255, catalogMax) };
    }
    /** Range of effect speed this model accepts. */
    get effectSpeedRange() {
        return this.model.effect_speed_range ?? { min: 0, max: 255 };
    }
    /**
     * Turn an effect reference into an index: a number stays a number, a string
     * is either a number ("3") or a catalog name ("blink_red", matched
     * case-insensitively and ignoring `_`/`-`/spaces).
     */
    resolveEffect(value) {
        const { min, max } = this.effectRange;
        if (typeof value === "number")
            return clamp(Math.round(value), min, max);
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed))
            return clamp(Number(trimmed), min, max);
        const wanted = normalizeEffectName(trimmed);
        const found = this.effects.find((effect) => normalizeEffectName(effect.name) === wanted);
        if (found)
            return found.index;
        // Mic modes are not in the effect catalogs but are addressable by name
        // too — by canonical name and by upstream alias.
        const micMode = MIC_EFFECT_MODES.find((mode) => normalizeEffectName(mode.name) === wanted ||
            (mode.aliases ?? []).some((alias) => normalizeEffectName(alias) === wanted));
        if (micMode)
            return micMode.index;
        const known = [...this.effects.map((effect) => effect.name), ...MIC_EFFECT_MODES.map((mode) => mode.name)].join(", ");
        throw new Error(`unknown effect "${value}" for ${this.name}` +
            (known ? `. Known effects: ${known}` : " (this model has no effect catalog)"));
    }
    /**
     * Turn a microphone-mode reference into 0x80-0x87: a number (also accepted
     * as "128"-style decimal), a canonical app name ("soft") or an upstream
     * alias ("mic_rhythm"), matched the same tolerant way as effect names.
     */
    resolveMicEffect(value) {
        if (typeof value === "number")
            return Math.round(value);
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed))
            return Number(trimmed);
        const wanted = normalizeEffectName(trimmed);
        const found = MIC_EFFECT_MODES.find((mode) => normalizeEffectName(mode.name) === wanted ||
            (mode.aliases ?? []).some((alias) => normalizeEffectName(alias) === wanted));
        if (found)
            return found.index;
        const known = MIC_EFFECT_MODES.map((mode) => mode.name).join(", ");
        throw new Error(`unknown mic mode "${value}". Known modes: ${known}`);
    }
    /** Color temperature: 1800K (warm) … 7000K (cool). */
    colorTemp(kelvin) {
        const { minKelvin, maxKelvin } = this.colorTempRange;
        const t = maxKelvin > minKelvin ? (clamp(kelvin, minKelvin, maxKelvin) - minKelvin) / (maxKelvin - minKelvin) : 1;
        return this.build("color_temp", { w: Math.round((1 - t) * 100), c: Math.round(t * 100) }, "color temperature");
    }
    /** Arbitrary packet (whatever the user gave in hex). */
    raw(bytes) {
        return Buffer.from(bytes);
    }
}
// --- Parsing user input ---------------------------------------------------
/** Effect-name matching ignores case and `_`/`-`/spaces: "Blink Red" == "blink_red". */
export function normalizeEffectName(name) {
    return name.toLowerCase().replace(/[\s_-]+/g, "");
}
/** `#ff8800` | `ff8800` | `255,136,0` | `255 136 0` → RGB. */
export function parseColor(value) {
    const cleaned = value.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
        return {
            r: parseInt(cleaned.slice(0, 2), 16),
            g: parseInt(cleaned.slice(2, 4), 16),
            b: parseInt(cleaned.slice(4, 6), 16),
        };
    }
    if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
        const [r, g, b] = cleaned.split("");
        return {
            r: parseInt(`${r}${r}`, 16),
            g: parseInt(`${g}${g}`, 16),
            b: parseInt(`${b}${b}`, 16),
        };
    }
    const parts = cleaned.split(/[,\s]+/).filter(Boolean);
    if (parts.length === 3 && parts.every((part) => /^\d{1,3}$/.test(part))) {
        const rgb = parts.map(Number);
        if (rgb.every((v) => v >= 0 && v <= 255))
            return { r: rgb[0], g: rgb[1], b: rgb[2] };
    }
    throw new Error(`could not parse color "${value}": expected #rrggbb, rrggbb or 255,136,0`);
}
/** `7e 04 04 f0 00 01 ff 00 ef` | `0x7e,0x04,...` | `7e0404f000 01ff00ef` → bytes. */
export function parseHexPacket(value) {
    const cleaned = value
        .trim()
        .replace(/0x/gi, "")
        .replace(/[,\s]+/g, " ")
        .trim();
    let hex;
    if (cleaned.includes(" ")) {
        // Bytes separated by spaces/commas: concatenate as-is.
        hex = cleaned.split(" ").join("");
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
            throw new Error(`could not parse hex "${value}": every byte needs two hex digits`);
        }
    }
    else {
        // A solid string: pairs without separators are allowed.
        if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
            throw new Error(`could not parse hex "${value}": length must be even`);
        }
        hex = cleaned;
    }
    const bytes = hex.match(/../g) ?? [];
    if (bytes.length === 0)
        throw new Error(`could not parse hex "${value}"`);
    return Buffer.from(bytes.map((byte) => parseInt(byte, 16)));
}
export function formatHex(data) {
    return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
/**
 * Decode whatever arrived on the notify channel.
 *
 * The controller reports real state only in a packet with cmd = 0x01; everything
 * else is an echo of the command we sent (normal for BLEDDM/BLEDOM).
 */
export function decodePacket(data) {
    const bytes = Array.from(data);
    const packet = {
        at: new Date().toISOString(),
        raw: formatHex(data),
        isPacket: bytes.length >= 9 && bytes[0] === HEADER && bytes[bytes.length - 1] === FOOTER,
    };
    if (!packet.isPacket)
        return packet;
    packet.cmd = bytes[2];
    if (bytes[2] === 0x01) {
        const state = { on: [0x23, 0xf0, 0x01].includes(bytes[3] ?? 0xff) };
        const [r, g, b, brightness] = [bytes[4], bytes[5], bytes[6], bytes[7]];
        if (!(r === 0xff && g === 0xff && b === 0xff) && r !== undefined && g !== undefined && b !== undefined) {
            state.rgb = { r, g, b };
            state.rgbHex = `#${formatHex(Uint8Array.from([r, g, b])).replace(/ /g, "")}`;
        }
        if (brightness !== undefined && brightness !== 0xff)
            state.brightnessPct = brightness;
        packet.state = state;
    }
    else {
        packet.looksLikeEcho = true;
    }
    return packet;
}
// --- Misc -----------------------------------------------------------------
export function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/**
 * Read the manufacturer name from the device name — not needed, but useful for
 * error messages: it shows exactly what was searched for.
 */
export function describeTarget(address, name) {
    return address ? `${name} (${address})` : name;
}
//# sourceMappingURL=protocol.js.map