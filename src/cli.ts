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
import {
    addDevice,
    configPath,
    listDevices,
    loadConfig,
    removeDevice,
    saveConfig,
    setDefaultDevice,
    unsetConfig,
    type BleConfig,
} from "./config.js"
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
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${flag}: ожидается неотрицательное число секунд`)
    return Math.round(seconds * 1000)
}

function toPercent(value: string, flag: string): number {
    const percent = Number(value)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new Error(`${flag}: ожидается 0-100`)
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
        .description("Управление BLE-лентами ELK-BLEDDM / ELK-BLEDOM / ELK-BTC / LEDBLE / MELK")
        .version(VERSION)
        .option("-a, --address <mac>", "MAC-адрес ленты (иначе ищем по имени)")
        .option("-n, --name <name>", "имя устройства в эфире")
        .option("-m, --model <model>", "принудительная модель из реестра (см. models)")
        .option("-D, --device <alias>", "сохранённая лента по имени из config (см. devices)")
        .option("--timeout <ms>", "сколько ждать появления устройства, мс", "30000")
        .option("--warm <ms>", "держать соединение тёплым после команды, мс", "0")
        .option("--json", "машиночитаемый вывод")
        .option("-v, --verbose", "подробный лог в stderr")

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
        .description("просканировать эфир и показать BLE-устройства рядом")
        .option("-d, --duration <seconds>", "длительность скана", "10")
        .action(async (cmd: { duration: string }) => {
            const opts = globals()
            const durationMs = toMilliseconds(cmd.duration, "--duration")
            const results = await withLed(opts, (led) => led.scan(durationMs))
            const target = results.filter((item) => item.matchesTarget)
            print(opts, { found: results.length, target: target[0] ?? null, devices: results }, (data) => {
                const lines = [`Найдено устройств: ${data.devices.length}`]
                if (data.devices.length === 0) {
                    lines.push("Ничего не видно. Проверь, что лента включена в розетку и приложение закрыто.")
                }
                for (const device of data.devices) {
                    const marks = [
                        device.matchesTarget ? "← цель" : "",
                        device.likely ? "похоже на LED" : "",
                        device.fresh ? "новое" : "из кэша",
                        device.addressType ?? "",
                    ].filter(Boolean)
                    lines.push(
                        `  ${signalText(device.rssi)}  ${device.address}  ${(device.name ?? "(без имени)").padEnd(24)} ${marks.join(", ")}  — ${device.hint}`,
                    )
                }
                if (target.length === 0) {
                    lines.push("Цель по имени не найдена — возможно, телефон всё ещё держит соединение.")
                }
                return lines.join("\n")
            })
        })

    program
        .command("status")
        .description("показать конфиг и текущее состояние соединения")
        .action(async () => {
            const opts = globals()
            const info = await withLed(opts, (led) => led.status())
            print(opts, info, (data) =>
                [
                    `Конфиг:     ${data.configPath}`,
                    `Адрес:      ${data.address ?? "(не задан — ищем по имени)"}`,
                    `Имя:        ${data.name}`,
                    `Модель:     ${data.model ?? "(автоопределение)"}`,
                    `Соединение: ${data.connected ? `активно с ${data.deviceName ?? "?"}` : "нет"}`,
                    `Протокол:   ${data.protocol ?? "—"}${data.settleMs ? `, пауза ${data.settleMs} мс` : ""}`,
                    `Последняя:  ${data.lastSent ?? "—"}`,
                ].join("\n"),
            )
        })

    program
        .command("info")
        .description("подключиться и показать GATT-профиль (сервисы и характеристики)")
        .action(async () => {
            const opts = globals()
            const info = await withLed(opts, (led) => led.info())
            print(opts, info, (data) => {
                const lines = [
                    `Устройство: ${data.name ?? "(без имени)"} [${data.address ?? "?"}] ${signalText(data.rssi)}`,
                    `Модель:     ${data.model}`,
                    `Запись:     ${data.writeUuid}`,
                    `Notify:     ${data.notifyUuid}`,
                    `Пауза:      ${data.settleMs} мс между командами`,
                    "Сервисы:",
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
        "включить ленту",
        () => (protocol) => protocol.turnOn(),
        (result) => `Включено. Отправлено: ${result.sent.join(" | ")}`,
    )

    sendCommand(
        "off",
        "выключить ленту",
        () => (protocol) => protocol.turnOff(),
        (result) => `Выключено. Отправлено: ${result.sent.join(" | ")}`,
    )

    sendCommand(
        "color",
        "задать цвет: #ff8800, ff8800, или 255,136,0",
        ([value]) => {
            const rgb = parseColor(value ?? "")
            return (protocol) => protocol.color(rgb)
        },
        (result) => `Цвет задан. Отправлено: ${result.sent.join(" | ")}`,
        [{ name: "value", description: "#rrggbb | rrggbb | r,g,b" }],
    )

    sendCommand(
        "white",
        "белый свет, яркость в процентах (0-100)",
        ([value]) => {
            const percent = toPercent(value ?? "", "white")
            return (protocol) => protocol.white(percent)
        },
        (result) => `Белый ${result.sent.length ? "включён" : "не отправлен"}. Отправлено: ${result.sent.join(" | ")}`,
        [{ name: "percent", description: "0-100" }],
    )

    sendCommand(
        "brightness",
        "яркость в процентах (0-100)",
        ([value]) => {
            const percent = toPercent(value ?? "", "brightness")
            return (protocol) => protocol.brightness(percent)
        },
        (result) => `Яркость изменена. Отправлено: ${result.sent.join(" | ")}`,
        [{ name: "percent", description: "0-100" }],
    )

    sendCommand(
        "kelvin",
        "цветовая температура, K (обычно 1800-7000)",
        ([value]) => {
            const kelvin = Number(value)
            if (!Number.isFinite(kelvin)) throw new Error("kelvin: ожидается число")
            return (protocol) => protocol.colorTemp(kelvin)
        },
        (result) => `Температура задана. Отправлено: ${result.sent.join(" | ")}`,
        [{ name: "kelvin", description: "например 3000" }],
    )

    sendCommand(
        "effect",
        "включить эффект по номеру (0-127, 128-135 — режимы с микрофоном)",
        ([value, speed, brightness]) => {
            const index = Number(value)
            if (!Number.isFinite(index)) throw new Error("effect: ожидается номер эффекта")
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
        (result) => `Эффект включён (${result.model}). Отправлено: ${result.sent.join(" | ")}`,
        [
            { name: "index", description: "номер эффекта" },
            { name: "speed", description: "скорость, необязательно", optional: true },
            { name: "brightness", description: "яркость 0-100, необязательно", optional: true },
        ],
    )

    sendCommand(
        "speed",
        "скорость текущего эффекта",
        ([value]) => {
            const speed = Number(value)
            if (!Number.isFinite(speed)) throw new Error("speed: ожидается число")
            return (protocol) => protocol.speed(speed)
        },
        (result) => `Скорость задана. Отправлено: ${result.sent.join(" | ")}`,
        [{ name: "value", description: "0-255" }],
    )

    sendCommand(
        "raw",
        "отправить произвольный пакет в hex (для отладки протокола)",
        ([value]) => {
            const packet = parseHexPacket(value ?? "")
            return () => packet
        },
        (result) => `Отправлено: ${result.sent.join(" | ")}`,
        [{ name: "hex", description: "например '7e 04 04 f0 00 01 ff 00 ef'" }],
    )

    program
        .command("watch")
        .description("слушать notify-канал (контроллер отвечает эхом наших же команд)")
        .option("-d, --duration <seconds>", "сколько слушать", "15")
        .action(async (cmd: { duration: string }) => {
            const opts = globals()
            const durationMs = toMilliseconds(cmd.duration, "--duration")
            const collected: DecodedPacket[] = []
            const result = await withLed(opts, (led) =>
                led.watch(durationMs, (packet) => {
                    collected.push(packet)
                    if (!opts.json) {
                        const note = packet.state ? "состояние" : packet.looksLikeEcho ? "эхо" : "?"
                        process.stdout.write(`  ${packet.raw}   (${note})\n`)
                    }
                }),
            )
            print(opts, result, (data) =>
                data.packets.length === 0
                    ? `Тишина в ${data.notifyUuid} за ${Math.round(durationMs / 1000)} с — контроллер не отвечает на пассивное слушание.`
                    : `Получено пакетов: ${data.packets.length}`,
            )
        })

    // --- Model registry and config ----------------------------------------

    program
        .command("models")
        .description("список поддерживаемых моделей контроллеров")
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
                            `${model.name.padEnd(16)} ${String(model.settleMs).padStart(4)} мс  ${model.writeUuid}  [${model.commands.join(", ")}]`,
                    )
                    .join("\n"),
            )
        })

    program
        .command("config")
        .description("показать или изменить сохранённую конфигурацию")
        .option("--set-address <mac>", "сохранить MAC-адрес")
        .option("--set-name <name>", "сохранить имя для поиска")
        .option("--set-model <model>", "сохранить модель")
        .option("--unset <fields...>", "убрать поля: address, name, model")
        .action((cmd: { setAddress?: string; setName?: string; setModel?: string; unset?: string[] }) => {
            const opts = globals()
            let config: BleConfig = loadConfig()

            if (cmd.unset && cmd.unset.length > 0) {
                const allowed: (keyof BleConfig)[] = ["address", "name", "model"]
                const keys = cmd.unset.filter((key): key is keyof BleConfig => (allowed as string[]).includes(key))
                if (keys.length !== cmd.unset.length) {
                    throw new Error(`--unset принимает только: ${allowed.join(", ")}`)
                }
                config = unsetConfig(keys)
            }

            if (cmd.setAddress || cmd.setName || cmd.setModel) {
                config = saveConfig({ address: cmd.setAddress, name: cmd.setName, model: cmd.setModel })
            }

            print(opts, { path: configPath(), config }, (data) =>
                Object.keys(data.config).length === 0
                    ? `${data.path}\n(пусто)`
                    : `${data.path}\n${JSON.stringify(data.config, null, 2)}`,
            )
        })

    program
        .command("devices")
        .description("список сохранённых лент (алиас → адрес/имя/модель), * — по умолчанию")
        .action(() => {
            const opts = globals()
            const config = loadConfig()
            const devices = config.devices ?? {}
            const def = config.default ?? null
            const fallback =
                !def && (config.address || config.name || config.model)
                    ? { address: config.address ?? null, name: config.name ?? null, model: config.model ?? null }
                    : null
            print(opts, { path: configPath(), default: def, fallback, devices }, (data) => {
                const aliases = Object.keys(data.devices).sort()
                if (aliases.length === 0 && !data.fallback) {
                    return (
                        "Сохранённых лент нет.\n" +
                        "Сначала найди адрес:  ble-mcp scan\n" +
                        "Затем привяжи:        ble-mcp attach <имя> <MAC>   (например: attach спальня AA:BB:CC:DD:EE:FF)"
                    )
                }
                const lines = aliases.map((alias) => {
                    const entry = data.devices[alias]
                    const mark = alias === data.default ? "*" : " "
                    const where = entry?.address ?? (entry?.name ? `по имени ${entry.name}` : "адрес неизвестен")
                    const model = entry?.model ? ` [${entry.model}]` : ""
                    return `${mark} ${alias.padEnd(16)} ${where}${model}`
                })
                if (data.fallback) {
                    const where =
                        data.fallback.address ??
                        (data.fallback.name ? `по имени ${data.fallback.name}` : "адрес неизвестен")
                    const model = data.fallback.model ? ` [${data.fallback.model}]` : ""
                    lines.unshift(`* (по умолчанию)  ${where}${model}`)
                }
                return lines.join("\n")
            })
        })

    program
        .command("attach")
        .description("привязать найденное устройство под именем (алиасом), например 'спальня'")
        .argument("<alias>", "имя ленты, например 'спальня' или 'гостиная'")
        .argument("[mac]", "MAC-адрес из scan (если ещё неизвестен — укажи --dev-name)")
        .option("--dev-name <name>", "имя устройства в эфире (если MAC пока неизвестен)")
        .option("--dev-model <model>", "принудительная модель из реестра")
        .option("--default", "сделать устройством по умолчанию")
        .action(
            (
                alias: string,
                mac: string | undefined,
                cmd: { devName?: string; devModel?: string; default?: boolean },
            ) => {
                const opts = globals()
                const isNew = !(alias in listDevices())
                if (isNew && !mac && !cmd.devName) {
                    throw new Error("укажи MAC (позиционно) или --dev-name, иначе нечего привязывать")
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
                    () => `Привязано: «${alias}» → ${entry?.address ?? (entry?.name ? `по имени ${entry.name}` : "?")}`,
                )
            },
        )

    program
        .command("detach")
        .description("отвязать ленту по имени (алиасу)")
        .argument("<alias>", "имя ленты")
        .action((alias: string) => {
            const opts = globals()
            const config = removeDevice(alias)
            print(opts, { path: configPath(), alias, default: config.default ?? null }, () => `Отвязано: «${alias}»`)
        })

    program
        .command("default")
        .description("сделать ленту устройством по умолчанию")
        .argument("<alias>", "имя ленты")
        .action((alias: string) => {
            const opts = globals()
            const config = setDefaultDevice(alias)
            print(opts, { path: configPath(), default: config.default ?? null }, () => `По умолчанию: «${alias}»`)
        })

    // --- MCP --------------------------------------------------------------

    program
        .command("serve")
        .description("запустить MCP-сервер (для агентов: opencode, Claude Desktop, любой MCP-клиент)")
        .option("-t, --transport <kind>", "stdio | http", "stdio")
        .option("--host <host>", "адрес HTTP-сервера", "127.0.0.1")
        .option("-p, --port <port>", "порт HTTP-сервера", "8765")
        .option("--path <path>", "путь HTTP-эндпоинта", "/mcp")
        .option("--stateless", "HTTP без сессий (проще для прокси)")
        .action(async (cmd: { transport: string; host: string; port: string; path: string; stateless?: boolean }) => {
            const opts = globals()
            // The server keeps the connection warm, otherwise every agent command
            // pays for a full scan-and-connect cycle.
            const warm = opts.warm > 0 ? opts.warm : 120_000
            const led = new BleLed({
                target: { address: opts.address, name: opts.name, model: opts.model, device: opts.device },
                timeoutMs: opts.timeout,
                warmMs: Number.isFinite(warm) ? warm : 120_000,
            })
            const { startStdioServer, startHttpServer } = await import("./mcp.js")

            if (cmd.transport === "stdio") {
                await startStdioServer(led)
                return
            }
            if (cmd.transport === "http") {
                const port = Number(cmd.port)
                if (!Number.isFinite(port) || port <= 0 || port > 65535) {
                    throw new Error(`--port: некорректный порт ${cmd.port}`)
                }
                const server = await startHttpServer(led, {
                    host: cmd.host,
                    port,
                    path: cmd.path.startsWith("/") ? cmd.path : `/${cmd.path}`,
                    stateless: Boolean(cmd.stateless),
                })
                log(`MCP (streamable HTTP) слушает http://${cmd.host}:${port}${server.path}`)
                log("Для opencode: type=remote, url=http://host:port/path")
                return
            }
            throw new Error(`--transport принимает только stdio или http, получено "${cmd.transport}"`)
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
