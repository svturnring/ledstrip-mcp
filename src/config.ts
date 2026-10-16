/**
 * Configuration: named devices.
 *
 * Stored in ~/.config/ble-mcp/config.json (the directory can be overridden with
 * BLE_MCP_CONFIG_DIR). There is exactly one format — a map of named devices plus
 * an optional default:
 *
 *       {
 *         "default": "спальня",
 *         "devices": {
 *           "гостиная": { "address": "AA:BB:CC:DD:EE:01", "name": "ELK-BLEDDM" },
 *           "спальня":  { "address": "AA:BB:CC:DD:EE:02", "name": "ELK-BLEDOM" }
 *         }
 *       }
 *
 * Every strip is addressed by its alias ("спальня"): commands take a `device`,
 * and per-call address/name/model arguments exist only for one-off runs and are
 * never persisted.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** A single named device entry. */
export interface BleDeviceEntry {
    /** Device MAC address, e.g. AA:BB:CC:DD:EE:01. */
    address?: string
    /** Advertising name used for discovery, e.g. ELK-BLEDDM. */
    name?: string
    /** Forced model from the registry (if auto-detection gets it wrong). */
    model?: string
}

export interface BleConfig {
    /** Alias of the default device (a key in `devices`). */
    default?: string
    /** Named devices: alias → entry. */
    devices?: Record<string, BleDeviceEntry>
}

export interface Target {
    address?: string
    name: string
    model?: string
    /** Alias of the resolved named device (set when resolved via a named device). */
    device?: string
}

export function configDir(): string {
    if (process.env.BLE_MCP_CONFIG_DIR) return process.env.BLE_MCP_CONFIG_DIR
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
    return join(base, "ble-mcp")
}

export function configPath(): string {
    return join(configDir(), "config.json")
}

export function loadConfig(): BleConfig {
    try {
        const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"))
        if (parsed && typeof parsed === "object") return parsed as BleConfig
        return {}
    } catch {
        return {}
    }
}

/** Write only the known keys so the file always has exactly one shape. */
function writeConfig(config: BleConfig): void {
    const out: BleConfig = {}
    if (config.default) out.default = config.default
    if (config.devices) out.devices = config.devices
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify(out, null, 2)}\n`, "utf8")
    try {
        chmodSync(configPath(), 0o600)
    } catch {
        // not critical (e.g. on filesystems without permissions)
    }
}

/** Drop empty entry fields and a dangling default so the file stays tidy. */
function prune(config: BleConfig): BleConfig {
    if (config.devices) {
        for (const [alias, entry] of Object.entries(config.devices)) {
            for (const key of ["address", "name", "model"] as const) {
                if (entry[key] === undefined || entry[key] === "") delete entry[key]
            }
            if (Object.keys(entry).length === 0) delete config.devices[alias]
        }
        if (Object.keys(config.devices).length === 0) delete config.devices
    }
    if (config.default && !config.devices?.[config.default]) delete config.default
    return config
}

/** All named devices (alias → entry). */
export function listDevices(): Record<string, BleDeviceEntry> {
    return loadConfig().devices ?? {}
}

/** The alias of the default device, if any. */
export function defaultDevice(): string | undefined {
    return loadConfig().default
}

/**
 * Attach (or update) a named device. A non-empty alias is required; the entry
 * is merged over any existing one, so `attach "спальня"` alone only ensures the
 * device exists.
 */
export function addDevice(alias: string, entry: BleDeviceEntry, options: { makeDefault?: boolean } = {}): BleConfig {
    const name = alias.trim()
    if (!name) throw new Error("имя устройства (алиас) не может быть пустым")
    const config = loadConfig()
    const devices = { ...(config.devices ?? {}) }
    devices[name] = { ...(devices[name] ?? {}), ...entry }
    config.devices = devices
    if (options.makeDefault) config.default = name
    writeConfig(prune(config))
    return config
}

/** Detach a named device. */
export function removeDevice(alias: string): BleConfig {
    const config = loadConfig()
    if (!config.devices || !(alias in config.devices)) {
        throw new Error(`устройство «${alias}» не найдено в конфиге`)
    }
    delete config.devices[alias]
    if (config.default === alias) delete config.default
    writeConfig(prune(config))
    return config
}

/** Make an existing named device the default. */
export function setDefaultDevice(alias: string): BleConfig {
    const config = loadConfig()
    if (!config.devices || !(alias in config.devices)) {
        throw new Error(`устройство «${alias}» не найдено в конфиге`)
    }
    config.default = alias
    writeConfig(prune(config))
    return config
}

/**
 * Effective target, in priority order:
 *   explicit arguments → named device (`device` alias) → environment → error.
 *
 * A `device` alias can come from the caller, from BLE_MCP_DEVICE, or from the
 * config's `default`. An unknown alias is an error, so a typo never silently
 * controls the wrong strip.
 */
export function resolveTarget(overrides: Partial<Target> = {}): Target {
    const config = loadConfig()
    const env = process.env
    const alias = overrides.device ?? env.BLE_MCP_DEVICE ?? config.default
    const entry = alias ? config.devices?.[alias] : undefined

    if (alias && !entry) {
        const known = Object.keys(config.devices ?? {})
        throw new Error(
            `устройство «${alias}» не найдено в конфиге` +
                (known.length ? `. Известные: ${known.join(", ")}` : ". Добавь его через attach / ble_add_device."),
        )
    }

    const address = overrides.address ?? entry?.address ?? env.BLE_MCP_ADDRESS
    const name = overrides.name ?? entry?.name ?? env.BLE_MCP_NAME ?? ""
    const model = overrides.model ?? entry?.model ?? env.BLE_MCP_MODEL

    if (!address && !name) {
        const known = Object.keys(config.devices ?? {})
        throw new Error(
            known.length
                ? `устройство не задано. Укажи device (-D / аргумент device) или настрой default (сейчас: ${known.join(", ")}).`
                : "устройства ещё не привязаны: сделай scan, затем attach / ble_add_device.",
        )
    }

    return { device: entry ? alias : undefined, address, name, model }
}
