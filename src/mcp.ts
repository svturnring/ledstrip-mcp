/**
 * MCP server: the same functionality as the CLI, but exposed as tools for
 * agents.
 *
 * Two transports:
 *   - stdio — how opencode / Claude Desktop / any local client launches it;
 *   - streamable HTTP — to connect over the network (`ble-mcp serve -t http`).
 *
 * IMPORTANT about stdio: stdout is taken by JSON-RPC, so all output goes to
 * stderr (see log.ts) and console.log is forcibly redirected to stderr.
 *
 * Multi-strip: every control tool takes an optional `device` argument — the
 * alias of a named device from ble_devices (e.g. "bedroom"). Without it, the
 * default device is used.
 *
 * Commands go through ONE aggregate tool (ble_apply) rather than one tool per
 * command: a batch needs one connection, and the connection is released as soon
 * as the call returns (a strip is single-client, so holding it locks the phone
 * out).
 */

import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

import { BleLed, type CommandResult } from "./ble.js"
import { addDevice, configPath, defaultDevice, listDevices, removeDevice, type Target } from "./config.js"
import { debug, log, protectStdout } from "./log.js"
import { effectsForClass, listModels, parseColor, parseHexPacket, Protocol, settleMsFor } from "./protocol.js"
import { VERSION } from "./version.js"

/** Response: both text for a human and structured data for the agent. */
interface ToolResponse {
    [key: string]: unknown
    content: { type: "text"; text: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
}

function ok(payload: Record<string, unknown>, summary: string): ToolResponse {
    return {
        content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(payload, null, 2)}` }],
        structuredContent: payload,
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function fail(error: unknown): ToolResponse {
    const message = errorText(error)
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        structuredContent: { error: message },
        isError: true,
    }
}

/** Wrapper: a BLE error must not break the MCP session — it becomes a response instead. */
function guard<Args>(handler: (args: Args) => Promise<ToolResponse>): (args: Args) => Promise<ToolResponse> {
    return async (args: Args) => {
        try {
            return await handler(args)
        } catch (error) {
            return fail(error)
        }
    }
}

/** Optional alias of a named device; omitted keys fall back to the default device. */
const deviceParam = z
    .string()
    .optional()
    .describe("Name of a strip from ble_devices (e.g. 'bedroom'). Without it the default device is used.")

/** Build a per-call target override, or undefined so the base target applies. */
function targetOf(device?: string): Partial<Target> | undefined {
    return device ? { device } : undefined
}

/**
 * One ordered action in a ble_apply batch. Every variant maps to exactly one
 * packet, so the order of the array is the order on the wire.
 */
const actionSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("power"),
        state: z.enum(["on", "off"]).describe("on — power on, off — power off"),
    }),
    z.object({ type: z.literal("color"), color: z.string().describe("#rrggbb, rrggbb or r,g,b") }),
    z.object({
        type: z.literal("brightness"),
        percent: z.number().min(0).max(100).describe("Brightness 0-100"),
    }),
    z.object({
        type: z.literal("white"),
        percent: z.number().min(0).max(100).describe("White brightness 0-100"),
    }),
    z.object({
        type: z.literal("color_temperature"),
        kelvin: z.number().min(1000).max(10000).describe("Temperature in kelvin"),
    }),
    z.object({
        type: z.literal("effect"),
        index: z.number().min(0).optional().describe("Effect number (see the ble_effects tool)"),
        name: z
            .string()
            .optional()
            .describe("Effect name from the catalog, e.g. 'blink_red' (see the ble_effects tool)"),
    }),
    z.object({ type: z.literal("speed"), value: z.number().min(0).describe("Effect speed (usually 0-255)") }),
    z.object({
        type: z.literal("raw"),
        hex: z.string().describe("Raw packet bytes in hex; spaces and 0x are allowed"),
    }),
])

type Action = z.infer<typeof actionSchema>

/**
 * One action → one packet. Values are parsed/built here, inside the connected
 * callback, so a bad value (or a command the model does not implement) fails
 * only its own action instead of the whole batch.
 */
function buildAction(protocol: Protocol, action: Action): Buffer {
    switch (action.type) {
        case "power":
            return action.state === "on" ? protocol.turnOn() : protocol.turnOff()
        case "color":
            return protocol.color(parseColor(action.color))
        case "brightness":
            return protocol.brightness(action.percent)
        case "white":
            return protocol.white(action.percent)
        case "color_temperature":
            return protocol.colorTemp(action.kelvin)
        case "effect": {
            const wanted = action.name ?? action.index
            if (wanted === undefined) {
                throw new Error("effect: pass either name (from ble_effects) or index")
            }
            return protocol.effect(protocol.resolveEffect(wanted))
        }
        case "speed":
            return protocol.speed(action.value)
        case "raw":
            return parseHexPacket(action.hex)
    }
}

/**
 * Register all tools.
 *
 * Writing to a strip goes through a single aggregate tool, ble_apply: it takes an
 * ordered array of actions and runs them over ONE connection. That is what makes
 * "release the channel right after the call" cheap — a batch of commands costs a
 * single connect, not one per command — and it keeps the mandatory settle delay
 * intact, because the order of the array is the order on the wire.
 *
 * Read-only and config tools (status, scan, info, watch, devices, models) stay
 * separate: they never write to the write characteristic.
 */
export function registerTools(server: McpServer, led: BleLed): void {
    server.registerTool(
        "ble_status",
        {
            title: "LED strip status",
            description:
                "Show the configuration (address, name, model) and whether a live BLE connection exists. Does not connect to the device.",
            inputSchema: { device: deviceParam },
        },
        guard(async ({ device }) => {
            const status = await led.status(targetOf(device))
            return ok(status as unknown as Record<string, unknown>, "Configuration status:")
        }),
    )

    server.registerTool(
        "ble_scan",
        {
            title: "Scan the BLE air",
            description:
                "Find BLE devices nearby. Run it when the strip is unreachable or when the MAC address needs to be known or confirmed. " +
                "Every device carries a hint whether it looks like an LED strip (names do NOT have to start with BLE). " +
                "A strip advertises only while the phone is not connected to it — close the app. " +
                "Devices marked fresh were seen just now; the rest come from the BlueZ cache.",
            inputSchema: {
                durationSeconds: z.number().min(1).max(60).optional().describe("Scan duration in seconds"),
            },
        },
        guard(async ({ durationSeconds }) => {
            const devices = await led.scan((durationSeconds ?? 10) * 1000)
            const target = devices.find((device) => device.matchesTarget) ?? null
            const likely = devices
                .filter((device) => device.likely)
                .map((device) => ({
                    address: device.address,
                    name: device.name ?? null,
                    rssi: device.rssi ?? null,
                    confidence: device.confidence,
                    model: device.model ?? null,
                    hint: device.hint,
                }))
            const summary = likely.length
                ? `Looks like an LED strip: ${likely.length}.`
                : "No obvious LED strips by name (check that the phone app is closed)."
            return ok({ found: devices.length, target, likely, devices }, `Scan result. ${summary}`)
        }),
    )

    server.registerTool(
        "ble_info",
        {
            title: "Strip GATT profile",
            description:
                "Connect and show the device services and characteristics, plus the detected protocol model and settle delay.",
            inputSchema: { device: deviceParam },
        },
        guard(async ({ device }) => {
            const info = await led.info(targetOf(device))
            return ok(info as unknown as Record<string, unknown>, "Device profile:")
        }),
    )

    server.registerTool(
        "ble_effects",
        {
            title: "Effect catalog of the strip",
            description:
                "List the effects the strip supports, by name and index, for the detected (or given) model. " +
                "The catalog is static data from the controller family — the strip itself cannot report it over BLE. " +
                "Read-only: does not connect. Use it before picking an effect for ble_apply " +
                "({'type':'effect','name':'blink_red'} or {'type':'effect','index':150}).",
            inputSchema: {
                device: deviceParam,
                model: z.string().optional().describe("Model from ble_list_models, to override detection"),
            },
        },
        guard(async ({ device, model }) => {
            let resolvedVia: string
            let protocol: Protocol
            if (model) {
                const spec = listModels().find((item) => item.name === model)
                if (!spec) throw new Error(`model "${model}" is not in the registry, see: ble_list_models`)
                protocol = new Protocol(spec)
                resolvedVia = "model argument"
            } else {
                // status() resolves the same target the control tools use
                // (serve flags / env / config) and does not connect.
                const status = await led.status(targetOf(device))
                protocol = Protocol.forDevice(status.name, status.model)
                resolvedVia = status.model ? "config (model)" : status.name ? "config (device name)" : "default model"
            }

            return ok(
                {
                    model: protocol.name,
                    resolvedVia,
                    effectsClass: protocol.effectsClass ?? null,
                    supportsEffects: protocol.supportsEffects,
                    supportsEffectSpeed: protocol.supportsEffectSpeed,
                    effectRange: protocol.effectRange,
                    effectSpeedRange: protocol.effectSpeedRange,
                    count: protocol.effects.length,
                    effects: protocol.effects.map((effect) => ({ index: effect.index, name: effect.name })),
                },
                `${protocol.name}: ${protocol.effects.length} named effects (class ${protocol.effectsClass ?? "?"}).`,
            )
        }),
    )

    server.registerTool(
        "ble_apply",
        {
            title: "Apply a batch of commands",
            description:
                "Send one or more strip commands in a SINGLE call, in the given order, over one BLE connection " +
                "(the mandatory settle pause is honoured after every packet). Put every command of one intent into " +
                "the same array — for example 'brightness 100% and red' is " +
                '[{"type":"brightness","percent":100},{"type":"color","color":"#ff0000"}] — rather than calling ' +
                "several tools: the connection is released the moment this call returns, so a separate call would " +
                "pay for a full reconnect. Order matters: for conflicting modes the last command wins, and a speed or " +
                "brightness that belongs to an effect must come before the effect itself. An action the detected " +
                "model does not support is skipped and reported, the rest are still sent.",
            inputSchema: {
                actions: z.array(actionSchema).min(1).describe("Ordered commands to run over one connection"),
                device: deviceParam,
            },
        },
        guard(async ({ actions, device }) => {
            const planned: { index: number; action: Action }[] = []
            const skipped: { index: number; action: Action; error: string }[] = []
            let model: string | undefined
            let result: CommandResult

            try {
                result = await led.run((protocol) => {
                    model = protocol.name
                    const packets: Buffer[] = []
                    actions.forEach((action, index) => {
                        try {
                            packets.push(buildAction(protocol, action))
                            planned.push({ index, action })
                        } catch (error) {
                            skipped.push({ index, action, error: errorText(error) })
                        }
                    })
                    return packets
                }, targetOf(device))
            } catch (error) {
                // Only a connection/transport failure reaches here: unsupported
                // actions are captured per action above.
                const message = errorText(error)
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${message}\n\nThe channel was released before this response.`,
                        },
                    ],
                    structuredContent: { error: message, model: model ?? null, skipped, released: true },
                    isError: true,
                }
            }

            // `sent` is in the same order as the packets that were built.
            const applied = planned.map((item, position) => ({ ...item, packet: result.sent[position] ?? null }))
            const payload = {
                model: result.model,
                settleMs: result.settleMs,
                requested: actions.length,
                applied,
                skipped,
                released: true,
            }
            const summary = skipped.length
                ? `Applied ${applied.length} of ${actions.length} commands; ${skipped.length} skipped.`
                : `Applied ${applied.length} commands.`
            return ok(payload, summary)
        }),
    )

    server.registerTool(
        "ble_watch",
        {
            title: "Listen to the notify channel",
            description:
                "Listen to strip notifications for a given time. The controller is write-only: it echoes our commands back " +
                "instead of reporting real state, which makes this tool useful for capturing the app protocol and debugging.",
            inputSchema: {
                durationSeconds: z.number().min(1).max(120).optional().describe("How long to listen, seconds"),
                device: deviceParam,
            },
        },
        guard(async ({ durationSeconds, device }) => {
            const result = await led.watch((durationSeconds ?? 10) * 1000, undefined, targetOf(device))
            return ok(result as unknown as Record<string, unknown>, `Packets collected: ${result.packets.length}.`)
        }),
    )

    server.registerTool(
        "ble_devices",
        {
            title: "List saved strips",
            description:
                "Show every saved strip (alias → address/name/model), which one is the default and which are connected right now. " +
                "Find the addresses with ble_scan first, then attach them with ble_add_device.",
            inputSchema: {},
        },
        guard(async () => {
            const devices = listDevices()
            const def = defaultDevice() ?? null
            const live = new Map((await led.connections()).map((item) => [item.address, item]))
            const view = Object.entries(devices)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([alias, entry]) => {
                    const connection = entry.address ? live.get(entry.address) : undefined
                    return {
                        device: alias,
                        address: entry.address ?? null,
                        name: entry.name ?? null,
                        model: entry.model ?? connection?.model ?? null,
                        default: alias === def,
                        connected: connection?.connected ?? false,
                    }
                })
            return ok(
                { default: def, count: view.length, devices: view },
                view.length
                    ? `Saved strips: ${view.length}.`
                    : "No saved strips — find devices (ble_scan) and attach them (ble_add_device).",
            )
        }),
    )

    server.registerTool(
        "ble_add_device",
        {
            title: "Attach a strip under a name",
            description:
                "Save a device under a readable name (alias), for example 'bedroom' or 'living-room'. " +
                "Take address from ble_scan. After that control the strip with the device argument in the other tools. " +
                "Set model only when auto-detection gets it wrong. setDefault=true makes this strip the default one.",
            inputSchema: {
                device: z.string().describe("Name (alias), e.g. 'bedroom'"),
                address: z.string().optional().describe("MAC address from ble_scan, e.g. AA:BB:CC:DD:EE:FF"),
                name: z.string().optional().describe("Advertising device name (if the address is not known yet)"),
                model: z.string().optional().describe("Model from ble_list_models"),
                setDefault: z.boolean().optional().describe("Make it the default device"),
            },
        },
        guard(async ({ device, address, name, model, setDefault }) => {
            const isNew = !(device in listDevices())
            if (isNew && !address && !name) {
                throw new Error("provide address (from ble_scan) or the device name")
            }
            const config = addDevice(device, { address, name, model }, { makeDefault: setDefault })
            return ok(
                {
                    path: configPath(),
                    device,
                    entry: config.devices?.[device] ?? null,
                    default: config.default ?? null,
                },
                `Strip "${device}" attached. Control it with the device argument.`,
            )
        }),
    )

    server.registerTool(
        "ble_remove_device",
        {
            title: "Detach a strip",
            description: "Remove a saved strip by name (alias).",
            inputSchema: { device: z.string().describe("Name (alias) to remove") },
        },
        guard(async ({ device }) => {
            const removed = listDevices()[device] ?? null
            const config = removeDevice(device)
            return ok(
                { path: configPath(), device, removed, default: config.default ?? null },
                `Strip "${device}" detached.`,
            )
        }),
    )

    server.registerTool(
        "ble_list_models",
        {
            title: "Supported models",
            description:
                "Known controller models with their UUIDs, the set of supported commands and the effect catalog " +
                "class (see the ble_effects tool). Taken from the Home Assistant elkbledom integration.",
            inputSchema: {},
        },
        guard(async () => {
            const models = listModels().map((model) => ({
                name: model.name,
                writeUuid: model.write_uuid,
                notifyUuid: model.read_uuid ?? null,
                settleMs: settleMsFor(model.name),
                commands: Object.keys(model.commands),
                effectsClass: model.effects_class ?? null,
                effects: effectsForClass(model.effects_class).length,
            }))
            return ok({ count: models.length, models }, `Models in the registry: ${models.length}.`)
        }),
    )

    debug(`tools registered, version ${VERSION}`)
}

/** A fresh server instance per HTTP session. */
function createMcpServer(led: BleLed): McpServer {
    const server = new McpServer({ name: "ble-mcp", version: VERSION })
    registerTools(server, led)
    return server
}

/** MCP over stdin/stdout — how local clients launch it. */
export async function startStdioServer(led: BleLed): Promise<void> {
    protectStdout()
    const server = createMcpServer(led)
    const transport = new StdioServerTransport()
    await server.connect(transport)
    debug("MCP server started over stdio")

    const shutdown = async (): Promise<void> => {
        await server.close().catch(() => undefined)
        await led.close().catch(() => undefined)
        process.exit(0)
    }
    process.on("SIGINT", () => void shutdown())
    process.on("SIGTERM", () => void shutdown())
}

export interface HttpServerOptions {
    host: string
    port: number
    path: string
    /** Without sessions: every request is independent (simpler behind a proxy). */
    stateless?: boolean
}

export interface HttpServerHandle {
    path: string
    close: () => Promise<void>
}

/**
 * MCP over streamable HTTP.
 *
 * POST creates a session and returns an Mcp-Session-Id header; subsequent
 * requests must carry that header. GET opens the SSE stream, DELETE closes the
 * session. Plus /health for a liveness probe.
 */
export async function startHttpServer(led: BleLed, options: HttpServerOptions): Promise<HttpServerHandle> {
    const transports = new Map<string, StreamableHTTPServerTransport>()

    const readBody = async (req: IncomingMessage): Promise<unknown> => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        if (chunks.length === 0) return undefined
        const text = Buffer.concat(chunks).toString("utf8")
        try {
            return JSON.parse(text)
        } catch {
            return undefined
        }
    }

    const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
        const body = JSON.stringify(payload)
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
        res.end(body)
    }

    const httpServer = createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${options.host}:${options.port}`}`)

            if (url.pathname === "/health") {
                sendJson(res, 200, { status: "ok", name: "ble-mcp", version: VERSION, transport: "http" })
                return
            }
            if (url.pathname !== options.path) {
                sendJson(res, 404, { error: "not found", hint: `MCP endpoint: ${options.path}` })
                return
            }

            try {
                const sessionId = req.headers["mcp-session-id"]
                const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined

                if (existing) {
                    await existing.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined)
                    return
                }

                if (req.method !== "POST") {
                    sendJson(res, 400, {
                        jsonrpc: "2.0",
                        error: {
                            code: -32000,
                            message: "A POST with initialize or an Mcp-Session-Id header is required",
                        },
                        id: null,
                    })
                    return
                }

                const body = await readBody(req)
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: options.stateless ? undefined : () => randomUUID(),
                    enableJsonResponse: options.stateless === true,
                    onsessioninitialized: (id) => {
                        transports.set(id, transport)
                        debug(`HTTP session opened: ${id}`)
                    },
                })
                transport.onclose = () => {
                    if (transport.sessionId) {
                        transports.delete(transport.sessionId)
                        debug(`HTTP session closed: ${transport.sessionId}`)
                    }
                }

                const server = createMcpServer(led)
                await server.connect(transport)
                await transport.handleRequest(req, res, body)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                log(`HTTP: ${message}`)
                if (!res.headersSent) {
                    sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message }, id: null })
                } else {
                    res.end()
                }
            }
        })()
    })

    await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject)
        httpServer.listen(options.port, options.host, () => resolve())
    })

    const shutdown = async (): Promise<void> => {
        for (const transport of transports.values()) await transport.close().catch(() => undefined)
        transports.clear()
        await new Promise<void>((resolve) => httpServer.close(() => resolve()))
        await led.close().catch(() => undefined)
    }
    process.on("SIGINT", () => void shutdown().then(() => process.exit(0)))
    process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)))

    return { path: options.path, close: shutdown }
}
