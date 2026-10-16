# ble-mcp

MCP server and CLI for BLE LED-strip controllers of the **ELK-BLEDDM / ELK-BLEDOM / ELK-BTC / LEDBLE / MELK** family.
Written in TypeScript, talks to BlueZ over D-Bus, **no native builds**.

The same functionality is exposed two ways:

- **MCP** — tools for agents (opencode, Claude Desktop, any MCP client) over `stdio` or **streamable HTTP**;
- **CLI** — the same operations from a terminal, outside an agent environment.

## Requirements

- **Linux** with BlueZ (tested on 5.85). Not macOS/Windows: `node-ble` talks to `org.bluez` over D-Bus, and on macOS BLE devices cannot be addressed by MAC at all.
- **Node.js >= 20** (tested on 24).
- A working Bluetooth adapter with `bluetoothd` running.

No extra privileges are needed: BlueZ allows regular users to call `org.bluez` by default, so `sudo` is not required.

## Installation

```sh
cd ~/dev/apps/ble-mcp
npm install
npm run build
```

A launcher is installed at `~/.local/bin/ble-mcp` and points to `dist/index.js`, so after building the command is available as `ble-mcp` from anywhere.

## Quick start

```sh
ble-mcp scan                    # what is in the air at all
ble-mcp config --set-address BE:27:CB:00:46:7A --set-name ELK-BLEDDM
ble-mcp on
ble-mcp color '#ff8800'
ble-mcp brightness 40
ble-mcp effect 3 128 70         # effect, speed, brightness — as one series
ble-mcp off
```

The first scan is needed to learn the MAC address. The address is stored in the config, and afterwards connections go straight to it — much faster than searching by name.

## CLI

| Command | Description |
| --- | --- |
| `scan [-d seconds]` | scan the air, show RSSI, freshness (live or from the BlueZ cache) and mark the configured target |
| `status` | show the config and whether a connection is alive (does not connect) |
| `info` | connect and show the GATT profile: services, characteristics, flags, detected model, settle delay |
| `on` / `off` | turn the strip on / off |
| `color <#rrggbb\|rrggbb\|r,g,b>` | set color |
| `white <0-100>` | white light at the given brightness |
| `brightness <0-100>` | set brightness |
| `kelvin <K>` | color temperature (1800 K warm … 7000 K cool) |
| `effect <n> [speed] [brightness]` | effect by index (0-127 standard, 128-135 mic modes) |
| `speed <v>` | speed of the current effect |
| `raw <hex>` | send an arbitrary packet, for debugging |
| `watch [-d seconds]` | listen to the notify channel |
| `models` | list supported controller models |
| `config [--set-address/--set-name/--set-model/--unset]` | show or change the saved config |
| `serve [-t stdio\|http]` | start the MCP server |

Global options: `-a/--address`, `-n/--name`, `-m/--model`, `--timeout <ms>` (how long to wait for the device), `--warm <ms>` (keep the connection alive for), `--json` (machine-readable output), `-v/--verbose`.

Examples:

```sh
ble-mcp scan -d 15 --json | jq '.devices[] | select(.matchesTarget)'
ble-mcp -a BE:27:CB:00:46:7A -n ELK-BLEDDM color '255,136,0'
ble-mcp --warm 60000 serve -t http --port 8765
```

## Connecting to MCP

### 1. stdio — local, the simplest option

opencode (`~/.config/opencode/opencode.json`):

```json
{
    "mcp": {
        "servers": {
            "ble": {
                "type": "local",
                "command": ["ble-mcp", "serve", "-t", "stdio"],
                "disabled": false
            }
        }
    }
}
```

If `ble-mcp` is not on the client's `PATH`, use an absolute path:

```json
"command": ["node", "/home/svtrn/dev/apps/ble-mcp/dist/index.js", "serve", "-t", "stdio"]
```

Claude Desktop and other clients using the `mcpServers` shape — the same:

```json
{ "mcpServers": { "ble": { "command": "ble-mcp", "args": ["serve", "-t", "stdio"] } } }
```

### 2. HTTP — when the agent runs elsewhere (container, another machine)

```sh
ble-mcp serve -t http --host 127.0.0.1 --port 8765 --path /mcp
```

- `POST /mcp` — JSON-RPC (streamable HTTP). The server replies with an `Mcp-Session-Id` header, and the client must send it on every following request;
- `GET /mcp` — SSE stream for server-initiated notifications;
- `DELETE /mcp` — close the session;
- `GET /health` — liveness probe: `{"status":"ok",...}`;
- `--stateless` — no sessions (convenient behind a proxy): every request is independent and answers are plain JSON.

Connecting from opencode:

```json
{
    "mcp": {
        "servers": {
            "ble": { "type": "remote", "url": "http://127.0.0.1:8765/mcp", "oauth": false }
        }
    }
}
```

**Security.** The server listens on `127.0.0.1` only, and that is deliberate: the endpoint has no authentication, so binding it to the network (`--host 0.0.0.0`) hands control of the strip — and BLE scanning, i.e. location-adjacent data — to anyone who can reach it. If it must be exposed, put an authenticating proxy in front.

### MCP tools

| Tool | Arguments | Description |
| --- | --- | --- |
| `ble_status` | — | config and connection state |
| `ble_scan` | `durationSeconds?` | scan the air |
| `ble_info` | — | GATT profile and detected model |
| `ble_power` | `state: on\|off` | turn on / off |
| `ble_set_color` | `color` | set color |
| `ble_set_brightness` | `percent` | brightness 0-100 |
| `ble_set_white` | `percent` | white 0-100 |
| `ble_set_color_temperature` | `kelvin` | warm / cool temperature |
| `ble_set_effect` | `index`, `speed?`, `brightness?` | effect, optionally with speed and brightness in one call |
| `ble_set_speed` | `value` | speed of the current effect |
| `ble_send_raw` | `packet` | arbitrary packet in hex |
| `ble_watch` | `durationSeconds?` | listen to the notify channel |
| `ble_configure` | `address?`, `name?`, `model?` | save device parameters |
| `ble_list_models` | — | model registry |

A typical agent flow: `ble_status` → (if the address is unknown) `ble_scan` → `ble_configure` → control commands.

## Configuration

Priority: **CLI arguments → environment variables → config file → default**.

File: `~/.config/ble-mcp/config.json` (the directory can be overridden with `BLE_MCP_CONFIG_DIR`):

```json
{ "address": "BE:27:CB:00:46:7A", "name": "ELK-BLEDDM" }
```

Environment variables: `BLE_MCP_ADDRESS`, `BLE_MCP_NAME`, `BLE_MCP_MODEL`, `BLE_MCP_VERBOSE=1`.

`address` speeds everything up: connection goes straight to the device instead of searching by name. `model` is only needed when auto-detection gets it wrong.

## How it works

### Layers

```
src/models.ts    — model registry (generated from models/models.json)
src/protocol.ts  — packet building/parsing, input parsers, model detection
src/config.ts    — config file and priority rules
src/log.ts       — logging, always to stderr
src/ble.ts       — transport: discovery, connect, write, notify, retries, warm connection
src/cli.ts       — CLI (commander)
src/mcp.ts       — MCP server (stdio + streamable HTTP)
src/index.ts     — entry point, dispatches CLI or MCP
```

### Protocol

9 bytes, written **without response** (`write without response`):

```
7E | type/length | cmd | payload ... | EF
```

| Action | Packet |
| --- | --- |
| turn on | `7e 04 04 f0 00 01 ff 00 ef` |
| turn off | `7e 04 04 00 00 00 ff 00 ef` |
| color | `7e 00 05 03 r g b 00 ef` |
| white | `7e 00 01 i 00 00 00 00 ef` |
| brightness | `7e 04 01 i ff 00 ff 00 ef` |
| speed | `7e 00 02 v 00 00 00 00 ef` |
| effect | `7e 00 03 v 03 00 00 00 ef` |
| color temperature | `7e 00 05 02 warm cold 00 00 ef` |

For ELK-BLEDDM the write characteristic is `0000fff3-…` and notify is `0000fff4-…`. Other models use different UUIDs, so the characteristic is located by walking the services instead of guessing the service UUID.

### Three reasons the code is more than "write 9 bytes"

1. **Settle delay.** The controller silently drops a command that arrives sooner than ~300 ms (ELK-BLEDOB ~100 ms) after the previous one. The delay is honoured after **every** command, including the last one in a series, and all strip operations are strictly serialized inside the process — otherwise parallel MCP calls would interleave the delays and some commands would be lost.
2. **The device is write-only.** For any request the controller echoes **our own command** back on the notify channel instead of reporting state. Reading "what color is it now" is impossible; `watch` exists to capture the phone app's protocol, not to poll state. Only a reply with `cmd = 0x01` carries real state (some variants support it) — that case is decoded in `decodePacket`.
3. **The strip sleeps and is occupied by the phone.** While the phone app holds a connection, the device does not advertise and cannot be connected to (hence the explicit error with a hint). BlueZ remembers devices from cache, so discovery is always started before connecting — that wakes the strip and puts it in the cache.

Plus the `warm` mode in the MCP server: the connection is kept for 2 minutes after the last command, otherwise every agent command pays for a full scan-and-connect cycle.

### Model registry

Data comes from `models.json` of the Home Assistant integration [dave-code-ruiz/elkbledom](https://github.com/dave-code-ruiz/elkbledom) (MIT) and is **baked into the code** by a generator, so no file is read at runtime:

```sh
npm run gen:models   # models/models.json → src/models.ts (+ prettier)
```

The model is detected from the device name (prefix match, longest match wins, the generic variant is preferred). It can also be forced: `-m ELK-BTC`.

## Development

```sh
npm run build       # tsc → dist/
npm run typecheck   # no emit
npm run dev         # tsc --watch (run with: node dist/index.js …)
npm test            # build + node:test over the protocol layer
npm run format      # prettier
npm run check       # typecheck + tests
```

Tests need no hardware: they cover packet building (reference bytes captured from a real ELK-BLEDDM), input parsers and notification decoding. Live verification is done with `ble-mcp on/off/color` — since the controller reports no state, "did it go through" can only be confirmed by looking at the strip.

## Gotchas

- **The phone.** The app holds the connection, so the strip does not advertise. Close the app.
- **A single connection.** A BLE peripheral accepts one client. A running MCP server with a warm connection occupies the strip: the CLI cannot connect at that moment (and vice versa).
- **BlueZ cache.** `adapter.devices()` also returns stale entries. In `scan` such devices have no RSSI and are marked as "from cache".
- **`--warm 0` (CLI default).** The CLI disconnects right after the command. For a series of fast commands use either `--warm 60000` or the MCP server.
- **App and MCP at the same time.** Capturing the app's protocol (`watch`) only works while our side is not writing: the controller echoes commands but never sends anything passively.

## License

MIT. The model registry and protocol design come from [elkbledom](https://github.com/dave-code-ruiz/elkbledom) (MIT).
