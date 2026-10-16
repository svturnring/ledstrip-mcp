/**
 * Configuration: device addresses/names/models and freely named devices.
 *
 * Stored in ~/.config/ble-mcp/config.json (overridable via BLE_MCP_CONFIG_DIR).
 * Values can also come from environment variables — handy for agent MCP configs
 * where writing a file is undesirable.
 *
 * Two shapes coexist for backward compatibility:
 *   - the legacy single-device fields (address/name/model);
 *   - a `devices` map of named devices (alias → address/name/model) plus an
 *     optional `default` alias. This is what enables multi-strip setups:
 *
 *       {
 *         "default": "спальня",
 *         "devices": {
 *           "гостиная": { "address": "AA:BB:CC:DD:EE:01", "name": "ELK-BLEDDM" },
 *           "спальня":  { "address": "AA:BB:CC:DD:EE:02", "name": "ELK-BLEDOM" }
 *         }
 *       }
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { DEFAULT_MODEL_NAME } from "./protocol.js"

/** A single named device entry. */
export interface BleDeviceEntry {
    /** Device MAC address, e.g. AA:BB:CC:DD:EE:01. */
    address?: string
    /** Name from the advertisement used for discovery, e.g. ELK-BLEDDM. */
    name?: string
    /** Forced model from the registry (if auto-detection gets it wrong). */
    model?: string
}

export interface BleConfig extends BleDeviceEntry {
    /** Alias of the default device (a key in `devices`). */
    default?: string
    /** Named devices: alias → entry. */
    devices?: Record<string, BleDeviceEntry>
}

export interface Target {
    address?: string
    name: string
    model?: string
    /** Alias of the device in the config (set when resolved via a named device). */
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

function writeConfig(config: BleConfig): void {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8")
    try {
        chmodSync(configPath(), 0o600)
    } catch {
        // not critical (e.g. on filesystems without permissions)
    }
}

/** Drop empty scalar/entry fields so the file stays tidy. */
function prune(config: BleConfig): BleConfig {
    for (const key of ["address", "name", "model", "default"] as const) {
        if (config[key] === undefined || config[key] === "") delete config[key]
    }
    if (config.devices) {
        for (const [alias, entry] of Object.entries(config.devices)) {
            for (const key of ["address", "name", "model"] as const) {
                if (entry[key] === undefined || entry[key] === "") delete entry[key]
            }
            if (Object.keys(entry).length === 0) delete config.devices[alias]
        }
        if (Object.keys(config.devices).length === 0) delete config.devices
    }
    return config
}

/** Merge fields into the config (the rest is preserved) and write it back. */
export function saveConfig(patch: BleConfig): BleConfig {
    const current = loadConfig()
    const merged: BleConfig = { ...current, ...patch }
    if (patch.devices) merged.devices = { ...current.devices, ...patch.devices }
    writeConfig(prune(merged))
    return merged
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
 * is merged over any existing one, so `attach "спальня" --default` alone just
 * makes it the default.
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

/** Remove legacy single-device fields from the config. */
export function unsetConfig(keys: (keyof BleConfig)[]): BleConfig {
    const current = loadConfig()
    for (const key of keys) delete current[key]
    writeConfig(prune(current))
    return current
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
 *   explicit arguments → named device (`device` alias) → environment →
 *   legacy single-device config → default.
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

    return {
        device: entry ? alias : undefined,
        address: overrides.address ?? entry?.address ?? env.BLE_MCP_ADDRESS ?? config.address,
        name: overrides.name ?? entry?.name ?? env.BLE_MCP_NAME ?? config.name ?? DEFAULT_MODEL_NAME,
        model: overrides.model ?? entry?.model ?? env.BLE_MCP_MODEL ?? config.model,
    }
}
