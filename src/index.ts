#!/usr/bin/env node
/**
 * `ble-mcp` entry point.
 *
 * One binary for two scenarios:
 *   ble-mcp <command>            — CLI for manual use;
 *   ble-mcp serve -t stdio|http  — MCP server for agents.
 */

import { runCli } from "./cli.js"
import { log } from "./log.js"

runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    log(`Error: ${message}`)
    if (error instanceof Error && error.stack && process.env.BLE_MCP_VERBOSE) {
        log(error.stack)
    }
    process.exitCode = 1
})
