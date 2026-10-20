/**
 * Configuration: named devices.
 *
 * Stored in ~/.config/ledstrip-mcp/config.json (the directory can be overridden with
 * LEDSTRIP_MCP_CONFIG_DIR). There is exactly one format — a map of named devices plus
 * an optional default:
 *
 *       {
 *         "default": "bedroom",
 *         "devices": {
 *           "living-room": { "address": "AA:BB:CC:DD:EE:01", "name": "ELK-BLEDDM" },
 *           "bedroom":     { "address": "AA:BB:CC:DD:EE:02", "name": "ELK-BLEDOM" }
 *         }
 *       }
 *
 * Every strip is addressed by its alias ("bedroom"): commands take a `device`,
 * and per-call address/name/model arguments exist only for one-off runs and are
 * never persisted.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export function configDir() {
    if (process.env.LEDSTRIP_MCP_CONFIG_DIR)
        return process.env.LEDSTRIP_MCP_CONFIG_DIR;
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(base, "ledstrip-mcp");
}
export function configPath() {
    return join(configDir(), "config.json");
}
export function loadConfig() {
    try {
        const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
        if (parsed && typeof parsed === "object")
            return parsed;
        return {};
    }
    catch {
        return {};
    }
}
/** Write only the known keys so the file always has exactly one shape. */
function writeConfig(config) {
    const out = {};
    if (config.default)
        out.default = config.default;
    if (config.devices)
        out.devices = config.devices;
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(out, null, 2)}\n`, "utf8");
    try {
        chmodSync(configPath(), 0o600);
    }
    catch {
        // not critical (e.g. on filesystems without permissions)
    }
}
/** Drop empty entry fields and a dangling default so the file stays tidy. */
function prune(config) {
    if (config.devices) {
        for (const [alias, entry] of Object.entries(config.devices)) {
            for (const key of ["address", "name", "model"]) {
                if (entry[key] === undefined || entry[key] === "")
                    delete entry[key];
            }
            if (Object.keys(entry).length === 0)
                delete config.devices[alias];
        }
        if (Object.keys(config.devices).length === 0)
            delete config.devices;
    }
    if (config.default && !config.devices?.[config.default])
        delete config.default;
    return config;
}
/** All named devices (alias → entry). */
export function listDevices() {
    return loadConfig().devices ?? {};
}
/** The alias of the default device, if any. */
export function defaultDevice() {
    return loadConfig().default;
}
/**
 * Attach (or update) a named device. A non-empty alias is required; the entry
 * is merged over any existing one, so `attach "bedroom"` alone only ensures the
 * device exists.
 */
export function addDevice(alias, entry, options = {}) {
    const name = alias.trim();
    if (!name)
        throw new Error("device alias cannot be empty");
    const config = loadConfig();
    const devices = { ...(config.devices ?? {}) };
    devices[name] = { ...(devices[name] ?? {}), ...entry };
    config.devices = devices;
    if (options.makeDefault)
        config.default = name;
    writeConfig(prune(config));
    return config;
}
/** Detach a named device. */
export function removeDevice(alias) {
    const config = loadConfig();
    if (!config.devices || !(alias in config.devices)) {
        throw new Error(`device "${alias}" is not present in the config`);
    }
    delete config.devices[alias];
    if (config.default === alias)
        delete config.default;
    writeConfig(prune(config));
    return config;
}
/** Make an existing named device the default. */
export function setDefaultDevice(alias) {
    const config = loadConfig();
    if (!config.devices || !(alias in config.devices)) {
        throw new Error(`device "${alias}" is not present in the config`);
    }
    config.default = alias;
    writeConfig(prune(config));
    return config;
}
/**
 * Effective target, in priority order:
 *   explicit arguments → named device (`device` alias) → environment → error.
 *
 * A `device` alias can come from the caller, from LEDSTRIP_MCP_DEVICE, or from the
 * config's `default`. An unknown alias is an error, so a typo never silently
 * controls the wrong strip.
 */
export function resolveTarget(overrides = {}) {
    const config = loadConfig();
    const env = process.env;
    const alias = overrides.device ?? env.LEDSTRIP_MCP_DEVICE ?? config.default;
    const entry = alias ? config.devices?.[alias] : undefined;
    if (alias && !entry) {
        const known = Object.keys(config.devices ?? {});
        throw new Error(`device "${alias}" is not present in the config` +
            (known.length ? `. Known: ${known.join(", ")}` : ". Add it with attach / ble_add_device."));
    }
    const address = overrides.address ?? entry?.address ?? env.LEDSTRIP_MCP_ADDRESS;
    const name = overrides.name ?? entry?.name ?? env.LEDSTRIP_MCP_NAME ?? "";
    const model = overrides.model ?? entry?.model ?? env.LEDSTRIP_MCP_MODEL;
    if (!address && !name) {
        const known = Object.keys(config.devices ?? {});
        throw new Error(known.length
            ? `no device configured. Pass device (-D / the device argument) or set a default (current: ${known.join(", ")}).`
            : "no devices attached yet: run scan, then attach / ble_add_device.");
    }
    return { device: entry ? alias : undefined, address, name, model };
}
//# sourceMappingURL=config.js.map