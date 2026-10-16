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
 */

import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

import { BleLed } from "./ble.js"
import { configPath, saveConfig } from "./config.js"
import { debug, log, protectStdout } from "./log.js"
import { listModels, parseColor, parseHexPacket, settleMsFor } from "./protocol.js"

const VERSION = "0.1.0"

/** Tool response: both text for a human and structured data for the agent. */
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

function fail(error: unknown): ToolResponse {
    const message = error instanceof Error ? error.message : String(error)
    return {
        content: [{ type: "text", text: `Ошибка: ${message}` }],
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

/**
 * Register all tools.
 *
 * The tools are deliberately "flat" and explicit: it is easier for an agent to
 * pick ble_set_color than to assemble an action string. Commands that must go
 * together (an effect plus its speed, for example) are combined into a single
 * call — otherwise the settle delay between them could be violated under
 * parallel calls.
 */
export function registerTools(server: McpServer, led: BleLed): void {
    server.registerTool(
        "ble_status",
        {
            title: "Состояние BLE-ленты",
            description:
                "Показать конфигурацию (адрес, имя, модель) и наличие живого BLE-соединения. Не подключается к устройству.",
            inputSchema: {},
        },
        guard(async () => {
            const status = await led.status()
            return ok(status as unknown as Record<string, unknown>, "Состояние конфигурации:")
        }),
    )

    server.registerTool(
        "ble_scan",
        {
            title: "Сканировать BLE-эфир",
            description:
                "Найти BLE-устройства рядом. Запускай, если лента недоступна или нужно узнать/подтвердить MAC-адрес. " +
                "Лента рекламируется только когда с ней не соединён телефон — закрой приложение. " +
                "Устройства с пометкой fresh найдены именно сейчас, остальные — из кэша BlueZ.",
            inputSchema: {
                durationSeconds: z.number().min(1).max(60).optional().describe("Длительность скана в секундах"),
            },
        },
        guard(async ({ durationSeconds }) => {
            const devices = await led.scan((durationSeconds ?? 10) * 1000)
            const target = devices.find((device) => device.matchesTarget) ?? null
            return ok({ found: devices.length, target, devices }, "Результат сканирования:")
        }),
    )

    server.registerTool(
        "ble_info",
        {
            title: "GATT-профиль ленты",
            description:
                "Подключиться и показать сервисы и характеристики устройства, а также определённую модель протокола и settle-паузу.",
            inputSchema: {},
        },
        guard(async () => {
            const info = await led.info()
            return ok(info as unknown as Record<string, unknown>, "Профиль устройства:")
        }),
    )

    server.registerTool(
        "ble_power",
        {
            title: "Включить/выключить ленту",
            description: "Подать питание на ленту или погасить её.",
            inputSchema: { state: z.enum(["on", "off"]).describe("on — включить, off — выключить") },
        },
        guard(async ({ state }) => {
            const result = await led.run((protocol) => (state === "on" ? protocol.turnOn() : protocol.turnOff()))
            return ok({ ...result, state }, state === "on" ? "Лента включена." : "Лента выключена.")
        }),
    )

    server.registerTool(
        "ble_set_color",
        {
            title: "Задать цвет",
            description: "Установить цвет ленты. Форматы: '#ff8800', 'ff8800', '255,136,0'.",
            inputSchema: { color: z.string().describe("#rrggbb, rrggbb или r,g,b") },
        },
        guard(async ({ color }) => {
            const rgb = parseColor(color)
            const result = await led.run((protocol) => protocol.color(rgb))
            return ok({ ...result, color: rgb }, `Цвет установлен: ${color}.`)
        }),
    )

    server.registerTool(
        "ble_set_brightness",
        {
            title: "Яркость",
            description: "Установить яркость в процентах (0-100).",
            inputSchema: { percent: z.number().min(0).max(100).describe("Яркость 0-100") },
        },
        guard(async ({ percent }) => {
            const result = await led.run((protocol) => protocol.brightness(percent))
            return ok({ ...result, percent }, `Яркость: ${percent}%.`)
        }),
    )

    server.registerTool(
        "ble_set_white",
        {
            title: "Белый свет",
            description: "Включить белый свет с заданной яркостью (0-100%).",
            inputSchema: { percent: z.number().min(0).max(100).describe("Яркость белого 0-100") },
        },
        guard(async ({ percent }) => {
            const result = await led.run((protocol) => protocol.white(percent))
            return ok({ ...result, percent }, `Белый свет: ${percent}%.`)
        }),
    )

    server.registerTool(
        "ble_set_color_temperature",
        {
            title: "Цветовая температура",
            description: "Тёплый/холодный белый. Обычный диапазон 1800 K (тёплый) … 7000 K (холодный).",
            inputSchema: { kelvin: z.number().min(1000).max(10000).describe("Температура в кельвинах") },
        },
        guard(async ({ kelvin }) => {
            const result = await led.run((protocol) => protocol.colorTemp(kelvin))
            return ok({ ...result, kelvin }, `Температура: ${kelvin} K.`)
        }),
    )

    server.registerTool(
        "ble_set_effect",
        {
            title: "Эффект",
            description:
                "Включить эффект по номеру. 0-127 — обычные эффекты, 128-135 — режимы с микрофоном " +
                "(у некоторых моделей нумерация отличается). Скорость и яркость можно задать сразу, " +
                "тогда они уйдут в одном вызове с соблюдением паузы.",
            inputSchema: {
                index: z.number().min(0).describe("Номер эффекта"),
                speed: z.number().min(0).optional().describe("Скорость эффекта (обычно 0-255)"),
                brightness: z.number().min(0).max(100).optional().describe("Яркость 0-100"),
            },
        },
        guard(async ({ index, speed, brightness }) => {
            const result = await led.run((protocol) => {
                const packets: Buffer[] = []
                if (speed !== undefined) packets.push(protocol.speed(speed))
                if (brightness !== undefined) packets.push(protocol.brightness(brightness))
                packets.push(protocol.effect(index))
                return packets
            })
            return ok({ ...result, index }, `Эффект ${index} включён.`)
        }),
    )

    server.registerTool(
        "ble_set_speed",
        {
            title: "Скорость эффекта",
            description: "Изменить скорость текущего эффекта (обычно 0-255).",
            inputSchema: { value: z.number().min(0).describe("Скорость") },
        },
        guard(async ({ value }) => {
            const result = await led.run((protocol) => protocol.speed(value))
            return ok({ ...result, value }, `Скорость: ${value}.`)
        }),
    )

    server.registerTool(
        "ble_send_raw",
        {
            title: "Произвольный пакет",
            description:
                "Отправить в характеристику записи произвольный пакет в hex (например '7e 04 04 f0 00 01 ff 00 ef'). " +
                "Нужно для отладки и для команд, которых нет среди готовых инструментов.",
            inputSchema: { packet: z.string().describe("Байты в hex, пробелы и 0x допустимы") },
        },
        guard(async ({ packet }) => {
            const bytes = parseHexPacket(packet)
            const result = await led.run(() => bytes)
            return ok({ ...result, requested: packet }, "Пакет отправлен.")
        }),
    )

    server.registerTool(
        "ble_watch",
        {
            title: "Слушать notify-канал",
            description:
                "Слушать уведомления ленты заданное время. Контроллер write-only: он возвращает ЭХО наших команд, " +
                "а не реальное состояние, поэтому инструмент полезен для снятия протокола приложения и отладки.",
            inputSchema: {
                durationSeconds: z.number().min(1).max(120).optional().describe("Сколько слушать, секунды"),
            },
        },
        guard(async ({ durationSeconds }) => {
            const result = await led.watch((durationSeconds ?? 10) * 1000)
            return ok(result as unknown as Record<string, unknown>, `Собрано пакетов: ${result.packets.length}.`)
        }),
    )

    server.registerTool(
        "ble_configure",
        {
            title: "Настроить адрес/имя/модель",
            description:
                `Сохранить параметры устройства в ${configPath()}. Указывай address после успешного ble_scan, ` +
                "чтобы дальше подключение было быстрым (без поиска по имени). Модель задавай вручную только если автоопределение ошибается.",
            inputSchema: {
                address: z.string().optional().describe("MAC-адрес, например BE:27:CB:00:46:7A"),
                name: z.string().optional().describe("Имя устройства в эфире, например ELK-BLEDDM"),
                model: z.string().optional().describe("Модель из ble_list_models"),
            },
        },
        guard(async ({ address, name, model }) => {
            const config = saveConfig({ address, name, model })
            await led.configure({ address, name, model })
            return ok(
                { path: configPath(), config },
                "Конфигурация сохранена. Следующее подключение применит её автоматически.",
            )
        }),
    )

    server.registerTool(
        "ble_list_models",
        {
            title: "Поддерживаемые модели",
            description:
                "Список известных моделей контроллеров с их UUID и набором поддерживаемых команд. " +
                "Данные из интеграции Home Assistant elkbledom.",
            inputSchema: {},
        },
        guard(async () => {
            const models = listModels().map((model) => ({
                name: model.name,
                writeUuid: model.write_uuid,
                notifyUuid: model.read_uuid ?? null,
                settleMs: settleMsFor(model.name),
                commands: Object.keys(model.commands),
            }))
            return ok({ count: models.length, models }, `Моделей в реестре: ${models.length}.`)
        }),
    )

    debug(`инструменты зарегистрированы, версия ${VERSION}`)
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
    debug("MCP-сервер запущен по stdio")

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
                sendJson(res, 404, { error: "not found", hint: `MCP-эндпоинт: ${options.path}` })
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
                        error: { code: -32000, message: "Требуется POST с initialize или заголовок Mcp-Session-Id" },
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
                        debug(`HTTP-сессия открыта: ${id}`)
                    },
                })
                transport.onclose = () => {
                    if (transport.sessionId) {
                        transports.delete(transport.sessionId)
                        debug(`HTTP-сессия закрыта: ${transport.sessionId}`)
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
