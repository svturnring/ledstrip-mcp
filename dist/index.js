#!/usr/bin/env node
/**
 * `ledstrip-mcp` entry point.
 *
 * One binary for two scenarios:
 *   ledstrip-mcp <command>            — CLI for manual use;
 *   ledstrip-mcp serve -t stdio|http  — MCP server for agents.
 */
import { runCli } from "./cli.js";
import { log } from "./log.js";
runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error: ${message}`);
    if (error instanceof Error && error.stack && process.env.LEDSTRIP_MCP_VERBOSE) {
        log(error.stack);
    }
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map