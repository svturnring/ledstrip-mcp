/**
 * Configuration: the strip's address/name/model.
 *
 * Stored in ~/.config/ble-mcp/config.json (overridable via BLE_MCP_CONFIG_DIR).
 * Values can also come from environment variables — handy for agent MCP configs
 * where writing a file is undesirable.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { DEFAULT_MODEL_NAME } from "./protocol.js"

export interface BleConfig {
    /** Device MAC address, e.g. BE:27:CB:00:46:7A. */
    address?: string
    /** Name from the advertisement used for discovery, e.g. ELK-BLEDDM. */
    name?: string
    /** Forced model from the registry (if auto-detection gets it wrong). */
    model?: string
}

export interface Target {
    address?: string
    name: string
    model?: string
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

/** Merge fields into the config (the rest is preserved). */
export function saveConfig(patch: BleConfig): BleConfig {
    const merged = { ...loadConfig(), ...patch }
    for (const [key, value] of Object.entries(merged)) {
        if (value === undefined || value === "") delete merged[key as keyof BleConfig]
    }
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify(merged, null, 2)}\n`, "utf8")
    try {
        chmodSync(configPath(), 0o600)
    } catch {
        // not critical (e.g. on filesystems without permissions)
    }
    return merged
}

/** Remove fields from the config. */
export function unsetConfig(keys: (keyof BleConfig)[]): BleConfig {
    const current = loadConfig()
    for (const key of keys) delete current[key]
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify(current, null, 2)}\n`, "utf8")
    return current
}

/**
 * Effective target, in priority order:
 *   CLI arguments → environment variables → config → default.
 */
export function resolveTarget(overrides: Partial<Target> = {}): Target {
    const config = loadConfig()
    const env = process.env
    return {
        address: overrides.address ?? env.BLE_MCP_ADDRESS ?? config.address,
        name: overrides.name ?? env.BLE_MCP_NAME ?? config.name ?? DEFAULT_MODEL_NAME,
        model: overrides.model ?? env.BLE_MCP_MODEL ?? config.model,
    }
}
