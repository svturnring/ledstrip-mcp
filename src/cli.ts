/**
 * `ble-mcp` CLI interface.
 *
 * Works independently of any agent environment: the same operations available
 * as MCP tools can be invoked by hand from a terminal.
 *
 * Output convention:
 *   - human-readable text by default;
 *   - `--json` — machine-readable output (easy to grep and parse from scripts);
 *   - progress/diagnostics — on stderr, useful data — on stdout.
 */

import { Command } from "commander"

import { BleLed, type BleLedOptions } from "./ble.js"
import { addDevice, configPath, defaultDevice, listDevices, removeDevice, setDefaultDevice } from "./config.js"
import { log, setVerbose } from "./log.js"
import { listModels, parseColor, parseHexPacket, settleMsFor, type DecodedPacket } from "./protocol.js"
interface GlobalOptions {
    address?: string
    name?: string
    model?: string
    device?: string
    timeout: number
    warm: number
    json?: boolean
    verbose?: boolean
}

const VERSION = "0.1.0"

function toMilliseconds(value: string, flag: string): number {
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${flag}: expected a non-negative number of seconds`)
    return Math.round(seconds * 1000)
}

function toPercent(value: string, flag: string): number {
    const percent = Number(value)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new Error(`${flag}: expected 0-100`)
    }
    return Math.round(percent)
}

/**
 * Shared scaffolding: create the strip handle, run the operation, and always
 * disconnect at the end (otherwise a dangling BLE connection is left behind and
 * the strip stays occupied).
 */
async function withLed<T>(opts: GlobalOptions, operation: (led: BleLed) => Promise<T>): Promise<T> {
    const options: BleLedOptions = {
        target: { address: opts.address, name: opts.name, model: opts.model, device: opts.device },
        timeoutMs: opts.timeout,
        warmMs: opts.warm,
    }
    const led = new BleLed(options)
    try {
        return await operation(led)
    } finally {
        await led.close().catch(() => undefined)
    }
}

function print<T>(opts: GlobalOptions, data: T, human: (data: T) => string): void {
    if (opts.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
    else process.stdout.write(`${human(data)}\n`)
}

function signalText(value: number | undefined): string {
    return typeof value === "number" ? `${String(value).padStart(4)} dBm` : "   ? dBm"
}

export function createProgram(): Command {
    const program = new Command()

    program
        .name("ble-mcp")
        .description("Control BLE LED strips ELK-BLEDDM / ELK-BLEDOM / ELK-BTC / LEDBLE / MELK")
        .version(VERSION)
        .option("-a, --address <mac>", "MAC address of the strip (otherwise search by name)")
        .option("-n, --name <name>", "advertised device name")
        .option("-m, --model <model>", "forced model from the registry (see models)")
        .option("-D, --device <alias>", "saved strip by alias from the config (see devices)")
        .option("--timeout <ms>", "how long to wait for the device to appear, ms", "30000")
        .option("--warm <ms>", "keep the connection warm after a command, ms (0 = release immediately)", "0")
        .option("--json", "machine-readable output")
        .option("-v, --verbose", "verbose log to stderr")

    const globals = (): GlobalOptions => {
        const opts = program.opts<GlobalOptions & { timeout: string; warm: string }>()
        const result: GlobalOptions = {
            ...opts,
            timeout: Number(opts.timeout),
            warm: Number(opts.warm),
        }
        if (!Number.isFinite(result.timeout)) result.timeout = 30_000
        if (!Number.isFinite(result.warm)) result.warm = 0
        return result
    }

    // --- Diagnostics ------------------------------------------------------

    program
        .command("scan")
        .description("scan the air and show nearby BLE devices")
        .option("-d, --duration <seconds>", "scan duration", "10")
        .action(async (cmd: { duration: string }) => {
            const opts = globals()
            const durationMs = toMilliseconds(cmd.duration, "--duration")
            const results = await withLed(opts, (led) => led.scan(durationMs))
            const target = results.filter((item) => item.matchesTarget)
            print(opts, { found: results.length, target: target[0] ?? null, devices: results }, (data) => {
                const lines = [`Devices found: ${data.devices.length}`]
                if (data.devices.length === 0) {
                    lines.push("Nothing visible. Check that the strip is powered and the phone app is closed.")
                }
                for (const device of data.devices) {
                    const marks = [
                        device.matchesTarget ? "<- target" : "",
                        device.likely ? "looks like LED" : "",
                        device.fresh ? "fresh" : "from cache",
                        device.addressType ?? "",
                    ].filter(Boolean)
                    lines.push(
                        `  ${signalText(device.rssi)}  ${device.address}  ${(device.name ?? "(no name)").padEnd(24)} ${marks.join(", ")}  — ${device.hint}`,
                    )
                }
                if (target.length === 0) {
                    lines.push("Target not found by name — the phone may still hold the connection.")
                }
                return lines.join("\n")
            })
        })

    program
        .command("status")
        .description("show the config and the current connection state")
        .action(async () => {
            const opts = globals()
            const info = await withLed(opts, (led) => led.status())
            print(opts, info, (data) =>
                [
                    `Config:     ${data.configPath}`,
                    `Address:    ${data.address ?? "(not set — search by name)"}`,
                    `Name:       ${data.name}`,
                    `Model:      ${data.model ?? "(auto-detected)"}`,
                    `Connection: ${data.connected ? `active with ${data.deviceName ?? "?"}` : "none"}`,
                    `Protocol:   ${data.protocol ?? "—"}${data.settleMs ? `, settle ${data.settleMs} ms` : ""}`,
                    `Last:       ${data.lastSent ?? "—"}`,
                ].join("\n"),
            )
        })

    program
        .command("info")
        .description("connect and show the GATT profile (services and characteristics)")
        .action(async () => {
            const opts = globals()
            const info = await withLed(opts, (led) => led.info())
            print(opts, info, (data) => {
                const lines = [
                    `Device:     ${data.name ?? "(no name)"} [${data.address ?? "?"}] ${signalText(data.rssi)}`,
                    `Model:      ${data.model}`,
                    `Write:      ${data.writeUuid}`,
                    `Notify:     ${data.notifyUuid}`,
                    `Settle:     ${data.settleMs} ms between commands`,
                    "Services:",
                ]
                for (const service of data.services) {
                    lines.push(`  ${service.uuid}`)
                    for (const characteristic of service.characteristics) {
                        lines.push(`    ${characteristic.uuid}  [${characteristic.flags.join(", ") || "—"}]`)
                    }
                }
                return lines.join("\n")
            })
        })

    // --- Control ----------------------------------------------------------

    const sendCommand = (
        name: string,
        description: string,
        build: (args: string[]) => (protocol: import("./protocol.js").Protocol) => Buffer | Buffer[],
        human: (result: Awaited<ReturnType<BleLed["send"]>>) => string,
        args: { name: string; description: string; optional?: boolean; variadic?: boolean }[] = [],
    ): void => {
        const command = program.command(name).description(description)
        for (const arg of args) {
            if (arg.variadic) command.argument("<value...>", arg.description)
            else if (arg.optional) command.argument(`[${arg.name}]`, arg.description)
            else command.argument(`<${arg.name}>`, arg.description)
        }
        command.action(async (...collected: unknown[]) => {
            const opts = globals()
            // The last argument is commander's command object; drop it.
            const values = collected.slice(0, args.length).flat() as string[]
            const result = await withLed(opts, (led) => led.send(build(values)))
            print(opts, result, human)
        })
    }

    sendCommand(
        "on",
        "turn the strip on",
        () => (protocol) => protocol.turnOn(),
        (result) => `On. Sent: ${result.sent.join(" | ")}`,
    )

    sendCommand(
        "off",
        "turn the strip off",
        () => (protocol) => protocol.turnOff(),
        (result) => `Off. Sent: ${result.sent.join(" | ")}`,
    )

    sendCommand(
        "color",
        "set color: #ff8800, ff8800 or 255,136,0",
        ([value]) => {
            const rgb = parseColor(value ?? "")
            return (protocol) => protocol.color(rgb)
        },
        (result) => `Color set. Sent: ${result.sent.join(" | ")}`,
        [{ name: "value", description: "#rrggbb | rrggbb | r,g,b" }],
    )

    sendCommand(
        "white",
        "white light, brightness in percent (0-100)",
        ([value]) => {
            const percent = toPercent(value ?? "", "white")
            return (protocol) => protocol.white(percent)
        },
        (result) => `White ${result.sent.length ? "on" : "not sent"}. Sent: ${result.sent.join(" | ")}`,
        [{ name: "percent", description: "0-100" }],
    )

    sendCommand(
        "brightness",
        "brightness in percent (0-100)",
        ([value]) => {
            const percent = toPercent(value ?? "", "brightness")
            return (protocol) => protocol.brightness(percent)
        },
        (result) => `Brightness changed. Sent: ${result.sent.join(" | ")}`,
        [{ name: "percent", description: "0-100" }],
    )

    sendCommand(
        "kelvin",
        "color temperature, K (usually 1800-7000)",
        ([value]) => {
            const kelvin = Number(value)
            if (!Number.isFinite(kelvin)) throw new Error("kelvin: expected a number")
            return (protocol) => protocol.colorTemp(kelvin)
        },
        (result) => `Temperature set. Sent: ${result.sent.join(" | ")}`,
        [{ name: "kelvin", description: "e.g. 3000" }],
    )

    sendCommand(
        "effect",
        "turn on an effect by number (0-127, 128-135 — microphone modes)",
        ([value, speed, brightness]) => {
            const index = Number(value)
            if (!Number.isFinite(index)) throw new Error("effect: expected an effect number")
            const speedValue = speed === undefined ? undefined : Number(speed)
            const brightnessValue = brightness === undefined ? undefined : toPercent(brightness, "brightness")
            return (protocol) => {
                const packets: Buffer[] = []
                if (speedValue !== undefined) packets.push(protocol.speed(speedValue))
                if (brightnessValue !== undefined) packets.push(protocol.brightness(brightnessValue))
                packets.push(protocol.effect(index))
                return packets
            }
        },
        (result) => `Effect on (${result.model}). Sent: ${result.sent.join(" | ")}`,
        [
            { name: "index", description: "effect number" },
            { name: "speed", description: "speed, optional", optional: true },
            { name: "brightness", description: "brightness 0-100, optional", optional: true },
        ],
    )

    sendCommand(
        "speed",
        "speed of the current effect",
        ([value]) => {
            const speed = Number(value)
            if (!Number.isFinite(speed)) throw new Error("speed: expected a number")
            return (protocol) => protocol.speed(speed)
        },
        (result) => `Speed set. Sent: ${result.sent.join(" | ")}`,
        [{ name: "value", description: "0-255" }],
    )

    sendCommand(
        "raw",
        "send a raw hex packet (for protocol debugging)",
        ([value]) => {
            const packet = parseHexPacket(value ?? "")
            return () => packet
        },
        (result) => `Sent: ${result.sent.join(" | ")}`,
        [{ name: "hex", description: "e.g. '7e 04 04 f0 00 01 ff 00 ef'" }],
    )

    program
        .command("watch")
        .description("listen to the notify channel (the controller echoes our own commands)")
        .option("-d, --duration <seconds>", "how long to listen", "15")
        .action(async (cmd: { duration: string }) => {
            const opts = globals()
            const durationMs = toMilliseconds(cmd.duration, "--duration")
            const collected: DecodedPacket[] = []
            const result = await withLed(opts, (led) =>
                led.watch(durationMs, (packet) => {
                    collected.push(packet)
                    if (!opts.json) {
                        const note = packet.state ? "state" : packet.looksLikeEcho ? "echo" : "?"
                        process.stdout.write(`  ${packet.raw}   (${note})\n`)
                    }
                }),
            )
            print(opts, result, (data) =>
                data.packets.length === 0
                    ? `Silence on ${data.notifyUuid} for ${Math.round(durationMs / 1000)} s — the controller does not answer passive listening.`
                    : `Packets received: ${data.packets.length}`,
            )
        })

    // --- Model registry and config ----------------------------------------

    program
        .command("models")
        .description("list of supported controller models")
        .action(() => {
            const opts = globals()
            const models = listModels().map((model) => ({
                name: model.name,
                settleMs: settleMsFor(model.name),
                writeUuid: model.write_uuid,
                notifyUuid: model.read_uuid ?? null,
                commands: Object.keys(model.commands),
            }))
            print(opts, models, (data) =>
                data
                    .map(
                        (model) =>
                            `${model.name.padEnd(16)} ${String(model.settleMs).padStart(4)} ms  ${model.writeUuid}  [${model.commands.join(", ")}]`,
                    )
                    .join("\n"),
            )
        })

    program
        .command("devices")
        .description("list of saved strips (alias → address/name/model), * — the default one")
        .action(() => {
            const opts = globals()
            const devices = listDevices()
            const def = defaultDevice() ?? null
            print(opts, { path: configPath(), default: def, devices }, (data) => {
                const aliases = Object.keys(data.devices).sort()
                if (aliases.length === 0) {
                    return (
                        "No saved strips.\n" +
                        "Find the address first:  ble-mcp scan\n" +
                        "Then attach it:          ble-mcp attach <name> <MAC>   (for example: attach bedroom AA:BB:CC:DD:EE:FF)"
                    )
                }
                return aliases
                    .map((alias) => {
                        const entry = data.devices[alias]
                        const mark = alias === data.default ? "*" : " "
                        const where = entry?.address ?? (entry?.name ? `by name ${entry.name}` : "address unknown")
                        const model = entry?.model ? ` [${entry.model}]` : ""
                        return `${mark} ${alias.padEnd(16)} ${where}${model}`
                    })
                    .join("\n")
            })
        })

    program
        .command("attach")
        .description("attach a discovered device under a name (alias), e.g. 'bedroom'")
        .argument("<alias>", "strip name, e.g. 'bedroom' or 'living-room'")
        .argument("[mac]", "MAC address from scan (if still unknown, pass --dev-name)")
        .option("--dev-name <name>", "advertised device name (if the MAC is not known yet)")
        .option("--dev-model <model>", "forced model from the registry")
        .option("--default", "make it the default device")
        .action(
            (
                alias: string,
                mac: string | undefined,
                cmd: { devName?: string; devModel?: string; default?: boolean },
            ) => {
                const opts = globals()
                const isNew = !(alias in listDevices())
                if (isNew && !mac && !cmd.devName) {
                    throw new Error("pass the MAC (positionally) or --dev-name, otherwise there is nothing to attach")
                }
                const config = addDevice(
                    alias,
                    { address: mac, name: cmd.devName, model: cmd.devModel },
                    { makeDefault: Boolean(cmd.default) },
                )
                const entry = config.devices?.[alias]
                print(
                    opts,
                    { path: configPath(), alias, entry: entry ?? null, default: config.default ?? null },
                    () => `Attached: "${alias}" → ${entry?.address ?? (entry?.name ? `by name ${entry.name}` : "?")}`,
                )
            },
        )

    program
        .command("detach")
        .description("detach a strip by name (alias)")
        .argument("<alias>", "strip name")
        .action((alias: string) => {
            const opts = globals()
            const config = removeDevice(alias)
            print(opts, { path: configPath(), alias, default: config.default ?? null }, () => `Detached: "${alias}"`)
        })

    program
        .command("default")
        .description("make the strip the default device")
        .argument("<alias>", "strip name")
        .action((alias: string) => {
            const opts = globals()
            const config = setDefaultDevice(alias)
            print(opts, { path: configPath(), default: config.default ?? null }, () => `Default: "${alias}"`)
        })

    // --- MCP --------------------------------------------------------------

    program
        .command("serve")
        .description("start the MCP server (for agents: opencode, Claude Desktop, any MCP client)")
        .option("-t, --transport <kind>", "stdio | http", "stdio")
        .option("--host <host>", "HTTP server address", "127.0.0.1")
        .option("-p, --port <port>", "HTTP server port", "8765")
        .option("--path <path>", "HTTP endpoint path", "/mcp")
        .option("--stateless", "HTTP without sessions (simpler behind a proxy)")
        .action(async (cmd: { transport: string; host: string; port: string; path: string; stateless?: boolean }) => {
            const opts = globals()
            // The channel is released as soon as a tool call returns (warm 0 is the
            // default). A strip is single-client, so holding it between calls would
            // lock the phone out; batches go into ONE ble_apply call instead.
            // `--warm <ms>` stays as an explicit opt-in for a warm window.
            const led = new BleLed({
                target: { address: opts.address, name: opts.name, model: opts.model, device: opts.device },
                timeoutMs: opts.timeout,
                warmMs: opts.warm,
            })
            const { startStdioServer, startHttpServer } = await import("./mcp.js")

            if (cmd.transport === "stdio") {
                await startStdioServer(led)
                return
            }
            if (cmd.transport === "http") {
                const port = Number(cmd.port)
                if (!Number.isFinite(port) || port <= 0 || port > 65535) {
                    throw new Error(`--port: invalid port ${cmd.port}`)
                }
                const server = await startHttpServer(led, {
                    host: cmd.host,
                    port,
                    path: cmd.path.startsWith("/") ? cmd.path : `/${cmd.path}`,
                    stateless: Boolean(cmd.stateless),
                })
                log(`MCP (streamable HTTP) listening on http://${cmd.host}:${port}${server.path}`)
                log("For opencode: type=remote, url=http://host:port/path")
                return
            }
            throw new Error(`--transport accepts only stdio or http, got "${cmd.transport}"`)
        })

    return program
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
    const args = argv.slice(2)
    if (args.includes("-v") || args.includes("--verbose")) setVerbose(true)

    const program = createProgram()
    program.exitOverride()
    program.configureOutput({
        writeErr: (text) => process.stderr.write(text),
        writeOut: (text) => process.stdout.write(text),
    })

    if (args.length === 0) {
        // outputHelp() just prints and does not throw (help() throws).
        program.outputHelp()
        return
    }

    try {
        await program.parseAsync(argv)
    } catch (error) {
        // Commander reports parse errors via exceptions with a `code` field
        // (their `name` is always "CommanderError"). It has already printed the
        // message itself, so here we only need to set the exit code.
        const commanderError = error as { code?: string; exitCode?: number }
        if (typeof commanderError.code === "string" && commanderError.code.startsWith("commander.")) {
            if ((commanderError.exitCode ?? 1) !== 0) process.exitCode = commanderError.exitCode ?? 1
            return
        }
        throw error
    }
}
