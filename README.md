# ledstrip-mcp

MCP server and CLI for BLE LED-strip controllers of the **ELK-BLEDDM / ELK-BLEDOM / ELK-BTC / LEDBLE / MELK** family. Written in TypeScript, talks to BlueZ over D-Bus, **no native builds**.

The same functionality is exposed two ways:

- **MCP** — tools for agents (opencode, Claude Desktop, any MCP client) over `stdio` or **streamable HTTP**;
- **CLI** — the same operations from a terminal, outside an agent environment.

## Requirements

- **Linux** with BlueZ (tested on 5.85). Not macOS/Windows: `node-ble` talks to `org.bluez` over D-Bus, and on macOS BLE devices cannot be addressed by MAC at all.
- **Node.js >= 20** (tested on 24).
- A working Bluetooth adapter with `bluetoothd` running.

No extra privileges are needed: BlueZ allows regular users to call `org.bluez` by default, so `sudo` is not required.

## Installation

Install from a GitHub Release with `npm` (Linux only — the tool talks to BlueZ over D-Bus):

```sh
npm install -g https://github.com/svturnring/ledstrip-mcp/releases/download/v0.5.0/ledstrip-mcp-0.5.0.tgz
```

Verify:

```sh
ledstrip-mcp --version
```

To upgrade, run the same command with a newer release tag. The latest release is always linked from the repo's front page.

> **Why a release tarball and not `npm install -g github:...`?** npm's global install of a git dependency leaves a symlink into a temporary cache clone that it then deletes, so that install is always broken. A release tarball is copied for real.

<details>
<summary>Development install (from a local clone)</summary>

```sh
git clone https://github.com/svturnring/ledstrip-mcp.git
cd ledstrip-mcp
npm install          # installs dependencies (dist/ is already committed)
npm run build        # recompile after editing src/
npm link             # or: npm install -g .
```

To cut a release: bump `version` in `package.json`, commit, then `scripts/release.sh` — it builds, packs and uploads the tarball to a new GitHub Release.

</details>

## Quick start

```sh
ledstrip-mcp scan                                              # what is in the air at all
ledstrip-mcp attach living-room AA:BB:CC:DD:EE:01 --default    # bind a found strip under a name
ledstrip-mcp on                                                # the default strip
ledstrip-mcp color '#ff8800'
ledstrip-mcp brightness 40
ledstrip-mcp effects                                           # what this strip can do, by name
ledstrip-mcp effect blink_red 128 70                           # effect by name, speed, brightness — as one series
ledstrip-mcp off
```

The first scan is needed to learn the MAC address. The address is stored in the config, and afterwards connections go straight to it — much faster than searching by name.

## Multiple strips

Several strips can be kept side by side. A strip is identified by a **name (alias)** — for example by room — which is just a pointer to a MAC address in the config. Discover the devices, then attach them:

```sh
ledstrip-mcp scan
ledstrip-mcp attach living-room AA:BB:CC:DD:EE:01 --default
ledstrip-mcp attach bedroom     AA:BB:CC:DD:EE:02
ledstrip-mcp devices
```

```text
* living-room      AA:BB:CC:DD:EE:01
  bedroom          AA:BB:CC:DD:EE:02
```

Now any command takes `-D/--device <alias>`; without it the default strip is used:

```sh
ledstrip-mcp -D bedroom color red
ledstrip-mcp -D bedroom brightness 20
ledstrip-mcp -D living-room white 80
```

Registry management:

| Command                | Description                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `devices`              | list saved strips, `*` marks the default                                   |
| `attach <alias> [mac]` | bind a found strip under a name (`--dev-name`, `--dev-model`, `--default`) |
| `detach <alias>`       | unbind                                                                     |
| `default <alias>`      | switch the default strip                                                   |

If the MAC is not known yet, bind by advertising name and the address is learned and saved on first use:

```sh
ledstrip-mcp attach bedroom --dev-name ELK-BLEDOM
```

The same works from an agent: `ble_scan` → `ble_add_device` → the control tools take a `device` argument (see [MCP tools](#mcp-tools)). Each strip has its own connection, so a warm MCP server can hold several strips open at once.

## CLI

| Command | Description |
| --- | --- |
| `scan [-d seconds]` | scan the air: show RSSI, freshness (live or from the BlueZ cache) and a hint on whether each device looks like an LED strip; the configured target is marked |
| `status` | show the config and whether a connection is alive (does not connect) |
| `info` | connect and show the GATT profile: services, characteristics, flags, detected model, settle delay |
| `on` / `off` | turn the strip on / off |
| `color <#rrggbb\|rrggbb\|r,g,b>` | set color |
| `white <0-100>` | white light at the given brightness |
| `brightness <0-100>` | set brightness |
| `kelvin <K>` | color temperature (1800 K warm … 7000 K cool) |
| `effect <name\|n> [speed] [brightness]` | effect by name (`blink_red`) or index (`150`) |
| `speed <v>` | speed of the current effect |
| `mic <on\|off>` | the controller's own microphone (music reaction runs on the strip) |
| `mic-sensitivity <0-100>` | microphone sensitivity |
| `mic-effect <name\|n>` | microphone reaction mode (`soft`, `129`, …) |
| `effects` | list the strip's effects by name and index (no connection needed) |
| `raw <hex>` | send an arbitrary packet, for debugging |
| `watch [-d seconds]` | listen to the notify channel |
| `models` | list supported controller models |
| `devices` | list saved strips (* — default) |
| `attach <alias> [mac]` | bind a strip under a name (`--dev-name`, `--dev-model`, `--default`) |
| `detach <alias>` | unbind a strip |
| `default <alias>` | switch the default strip |
| `serve [-t stdio\|http]` | start the MCP server |

Global options: `-a/--address`, `-n/--name`, `-m/--model`, `-D/--device <alias>`, `--timeout <ms>` (how long to wait for the device), `--warm <ms>` (keep the connection warm after a command; `0`, the default, releases it immediately), `--json` (machine-readable output), `-v/--verbose`.

Examples:

```sh
ledstrip-mcp scan -d 15 --json | jq '.devices[] | select(.likely)'
ledstrip-mcp -D bedroom color '255,136,0'
ledstrip-mcp -a AA:BB:CC:DD:EE:01 -n ELK-BLEDDM color red
ledstrip-mcp --warm 60000 serve -t http --port 8765
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
                "command": ["ledstrip-mcp", "serve", "-t", "stdio"],
                "disabled": false
            }
        }
    }
}
```

If `ledstrip-mcp` is not on the client's `PATH`, use an absolute path:

```json
"command": ["node", "/home/svtrn/dev/apps/ledstrip-mcp/dist/index.js", "serve", "-t", "stdio"]
```

Claude Desktop and other clients using the `mcpServers` shape — the same:

```json
{ "mcpServers": { "ble": { "command": "ledstrip-mcp", "args": ["serve", "-t", "stdio"] } } }
```

### 2. HTTP — when the agent runs elsewhere (container, another machine)

```sh
ledstrip-mcp serve -t http --host 127.0.0.1 --port 8765 --path /mcp
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
| `ble_status` | `device?` | config and connection state |
| `ble_scan` | `durationSeconds?` | scan the air and hint which devices look like LED strips |
| `ble_info` | `device?` | GATT profile and detected model |
| `ble_effects` | `device?`, `model?` | the strip's effects by name and index, plus the effect-speed range (static catalog, no connection) |
| `ble_apply` | `actions[]`, `device?` | **one ordered batch of commands over one connection** (see below) |
| `ble_watch` | `durationSeconds?`, `device?` | listen to the notify channel |
| `ble_devices` | — | list saved strips, which is the default and which are connected |
| `ble_add_device` | `device`, `address?`, `name?`, `model?`, `setDefault?` | bind a strip under a name |
| `ble_remove_device` | `device` | unbind a strip |
| `ble_list_models` | — | model registry |

Every control tool accepts an optional **`device`** argument — the alias of a saved strip (e.g. `"bedroom"`). Without it, the default strip is used.

### `ble_apply` — all writing goes through one tool

The connection is released the moment the call returns, so a second tool call would pay for a full reconnect (2-5 s). That is why **all commands belonging to one intent go into a single `ble_apply` call as an ordered array**, instead of being spread over several tools:

```json
{
    "device": "bedroom",
    "actions": [
        { "type": "power", "state": "on" },
        { "type": "brightness", "percent": 100 },
        { "type": "color", "color": "#ff0000" },
        { "type": "effect", "index": 3 }
    ]
}
```

One `actions[]` entry — one packet. Action types: `power` (`state: on|off`), `color` (`color: "#rrggbb"`), `brightness` (`percent`), `white` (`percent`), `color_temperature` (`kelvin`), `effect` (`index` **or** `name` from the ble_effects catalog), `speed` (`value`), `mic` (`state: on|off`), `mic_sensitivity` (`percent` 0-100), `mic_effect` (`index` 128-135 **or** `name` from `micModes`), `raw` (`hex: "7e 04 04 f0 00 01 ff 00 ef"`). Order matters: for conflicting modes the last one wins, and a `speed`/`brightness` that belongs to an effect must come **before** the effect itself. The mandatory settle delay is honoured after every packet, in order.

An action the detected model does not support is **skipped and reported** while the rest are still applied — the answer lists `applied` and `skipped` per index. The same applies to an effect name the catalog does not know: it is skipped with an error listing the known names, never sent blindly.

A typical agent flow: `ble_status` → (if the address is unknown) `ble_scan` → `ble_add_device` per strip → `ble_effects` to see what the strip can do → `ble_apply` with `device`, e.g. `{"device":"bedroom","actions":[{"type":"speed","value":128},{"type":"effect","name":"blink_red"}]}`.

## Configuration

Priority: **explicit arguments (CLI flags / tool args) → named device alias → environment variables → error**.

File: `~/.config/ledstrip-mcp/config.json` (the directory can be overridden with `LEDSTRIP_MCP_CONFIG_DIR`). There is a single format: a map of named devices plus an optional default. This is exactly what `attach` / `ble_add_device` write:

```json
{
    "default": "bedroom",
    "devices": {
        "living-room": { "address": "AA:BB:CC:DD:EE:01", "name": "ELK-BLEDDM" },
        "bedroom": { "address": "AA:BB:CC:DD:EE:02", "model": "ELK-BLEDOM" }
    }
}
```

Environment variables: `LEDSTRIP_MCP_ADDRESS`, `LEDSTRIP_MCP_NAME`, `LEDSTRIP_MCP_MODEL`, `LEDSTRIP_MCP_DEVICE` (alias of the default strip), `LEDSTRIP_MCP_VERBOSE=1`.

`address` speeds everything up: connection goes straight to the device instead of searching by name. `model` is only needed when auto-detection gets it wrong.

## How it works

### Layers

```
src/models.ts    — model registry (generated from models/models.json)
src/effects.ts   — effect catalogs per controller family (generated from models/definitions.json)
src/protocol.ts  — packet building/parsing, input parsers, model detection, device-name classifier
src/config.ts    — config: named devices, priority rules
src/log.ts       — logging, always to stderr
src/version.ts   — the package version, read from package.json at runtime
src/ble.ts       — transport: discovery, connection pool (one per strip), write, notify, retries, release after a command (optional warm window)
src/cli.ts       — CLI (commander)
src/mcp.ts       — MCP server (stdio + streamable HTTP)
src/index.ts     — entry point, dispatches CLI or MCP
```

### Protocol

9 bytes, written **without response** (`write without response`):

```
7E | type/length | cmd | payload ... | EF
```

| Action            | Packet                           |
| ----------------- | -------------------------------- |
| turn on           | `7e 04 04 f0 00 01 ff 00 ef`     |
| turn off          | `7e 04 04 00 00 00 ff 00 ef`     |
| color             | `7e 00 05 03 r g b 00 ef`        |
| white             | `7e 00 01 i 00 00 00 00 ef`      |
| brightness        | `7e 04 01 i ff 00 ff 00 ef`      |
| speed             | `7e 00 02 v 00 00 00 00 ef`      |
| effect            | `7e 00 03 v 03 00 00 00 ef`      |
| color temperature | `7e 00 05 02 warm cold 00 00 ef` |

For ELK-BLEDDM the write characteristic is `0000fff3-…` and notify is `0000fff4-…`. Other models use different UUIDs, so the characteristic is located by walking the services instead of guessing the service UUID.

### Three reasons the code is more than "write 9 bytes"

1. **Settle delay.** The controller silently drops a command that arrives sooner than ~300 ms (ELK-BLEDOB ~100 ms) after the previous one. The delay is honoured after **every** command, including the last one in a series, and all strip operations are strictly serialized inside the process — otherwise parallel MCP calls would interleave the delays and some commands would be lost.
2. **The device is write-only.** For any request the controller echoes **our own command** back on the notify channel instead of reporting state. Reading "what color is it now" is impossible; `watch` exists to capture the phone app's protocol, not to poll state. Only a reply with `cmd = 0x01` carries real state (some variants support it) — that case is decoded in `decodePacket`.
3. **The strip sleeps and is occupied by the phone.** While the phone app holds a connection, the device does not advertise and cannot be connected to (hence the explicit error with a hint). BlueZ remembers devices from cache, so discovery is always started before connecting — that wakes the strip and puts it in the cache.

**Plus: the channel is released immediately after a command.** A strip is single-client and stops advertising while anything is connected to it, so holding the connection locks the phone (and any other client) out. The default `warm 0` therefore frees the strip as soon as the call returns, and `try/finally` guarantees that on every path — success, failed write, exception and a dropped link. The reconnect cost (2-5 s) is not hidden by holding the connection, but paid once per **batch**: commands that belong together go into a single `ble_apply` call, which is exactly why the MCP surface is one aggregating tool instead of one tool per command. `--warm <ms>` remains as an explicit opt-in for callers that prefer a warm window over a free strip.

### Model registry

Data comes from `models.json` of the Home Assistant integration [dave-code-ruiz/elkbledom](https://github.com/dave-code-ruiz/elkbledom) (MIT) and is **baked into the code** by a generator, so no file is read at runtime:

```sh
npm run gen:models   # models/models.json → src/models.ts, models/definitions.json → src/effects.ts (+ prettier)
```

The model is detected from the device name (prefix match, longest match wins, the generic variant is preferred). It can also be forced: `-m ELK-BTC`.

### Effects

The controller is **write-only**: over Bluetooth it never reports which effects it supports — the effect is just a number in the packet, and nothing on the air explains what the numbers mean. So the name → index table is **static data, known in advance**, reverse-engineered from the phone apps and pinned from `definitions.json` of the same elkbledom integration (MIT). Each controller family has its own catalog, referenced by the model's `effects_class`:

| Class | Models (examples) | Effects |
| --- | --- | --- |
| `EFFECTS` | ELK-BLEDDM, ELK-BLEDOM, LEDBLE | 22: jump / crossfade / blink |
| `EFFECTS_STRIPX` | MELK-OA21 | 228, including music modes (indexes up to 391) |
| `EFFECTS_MELK_Ox` | MELK-O*10 | 13 |
| `EFFECTS_MELK` | MELK | 16 |
| `EFFECTS_DMRRBA` | DMRRBA-007 | 9 |

An agent (or a human) browses the catalog with the `ble_effects` tool / `effects` command — no internet needed — and then sets an effect **by name** (`{"type":"effect","name":"blink_red"}`) or by index. A name the catalog does not know is skipped and reported, never sent blindly. Effect **speed** is a separate command with its own per-model range (0–255 by default, 0–183 for ELK-BLEDOB), applied by the `speed` action / `speed` command — and, like brightness, it must come **before** the effect in the same batch.

#### Microphone (music) modes

The controller has its own microphone and analyzes sound **on the strip itself** — no audio is streamed over Bluetooth, so switching a music mode is a one-shot command and it keeps running after the connection is released (same "release after every command" design as everywhere else).

The modes are numbered `0x80-0x87` (128-135) and live in `micModes` of `ble_effects` / in the `effects` command output. The four named modes are the English names of the phone app (LotusLanternX), mapped empirically on a physical strip: `classic` (0x80), `soft` (0x81), `dynamic` (0x82), `disco` (0x83); `mic_effect_4..7` (0x84-0x87) are additional modes with no fixed name. The elkbledom upstream names (`mic_energic`, `mic_rhythm`, …) are kept as aliases. A music session is one batch:

```json
{"actions": [
  {"type": "mic", "state": "on"},
  {"type": "mic_sensitivity", "percent": 60},
  {"type": "mic_effect", "name": "soft"}
]}
```

Details worth knowing:

- Indexes 128-135 passed to `effect` are **routed to the microphone packet automatically**: the controller ignores them in the generic effect packet (verified live on ELK-BLEDDM — it kept the previous color) and only accepts the dedicated mic packet shape (`7e 05 03 .. 04 ..`).
- Sensitivity matters: too high and the mic reacts to ambient noise (the "random flickering" symptom); too low and it does not react at all. Range 0-100, default in the phone app is 50.
- Mic commands (`mic`, `mic_sensitivity`, `mic_effect`) are sent as the hardcoded packets of the upstream integration — independent of the model registry.
- Not supported: the second mode of the phone apps — "phone microphone" (the phone streams its own mic audio to the strip). That is a continuous BLE stream, not this protocol's one-shot commands.

## Development

```sh
npm run build       # tsc → dist/
npm run typecheck   # no emit
npm run dev         # tsc --watch (run with: node dist/index.js …)
npm test            # build + node:test (protocol, config, transport, MCP tools)
npm run format      # prettier
npm run check       # typecheck + tests
```

Tests need no hardware: packet building is checked against reference bytes captured from a real ELK-BLEDDM, plus input parsers, notification decoding, and the transport/MCP layers against a fake BLE session — the invariants there are that a batch of commands shares one connection and that the channel is released when the call returns. Live verification is done with `ledstrip-mcp on/off/color` — since the controller reports no state, "did it go through" can only be confirmed by looking at the strip.

## Gotchas

- **The phone.** The app holds the connection, so the strip does not advertise. Close the app.
- **One client per strip.** A BLE peripheral accepts a single client. Between calls the strip is free (the connection is released right after each command), but while a command or a batch is in flight nobody else can reach it. With an explicit `--warm <ms>` window the strip is held for that whole window, so the CLI or the phone cannot connect to it in the meantime. Different strips are independent and can be connected at the same time.
- **Names are not reliable.** BLE device names are arbitrary and do **not** have to start with "BLE" (e.g. `ELK-BLEDDM`, `LEDBLE-…`, `Triones-…`, or a random string). Use the hint in `ble_scan` / `ble_add_device` to tell strips apart, and prefer the MAC address as the durable key.
- **BlueZ cache.** `adapter.devices()` also returns stale entries. In `scan` such devices have no RSSI and are marked as "from cache".
- **`warm 0` is the default everywhere.** The connection is released right after the command. For a fast series of commands: in MCP it is one `ble_apply` call with an ordered `actions[]`; in the CLI it is `--warm 60000`, which holds the connection between the commands you type.
- **App and MCP at the same time.** Capturing the app's protocol (`watch`) only works while our side is not writing: the controller echoes commands but never sends anything passively.

## License

MIT. The model registry, effect catalogs and protocol design come from [elkbledom](https://github.com/dave-code-ruiz/elkbledom) (MIT).
