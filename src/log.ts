/**
 * Logging. IMPORTANT: everything goes to stderr.
 *
 * When the server runs over stdio, stdout is occupied by MCP JSON-RPC messages —
 * any console.log there corrupts the protocol. That is why the project avoids
 * console.log and everything here is written to stderr.
 */

let verboseEnabled = /^(1|true|yes)$/i.test(process.env.BLE_MCP_VERBOSE ?? "")

export function setVerbose(value: boolean): void {
    verboseEnabled = value
}

export function isVerbose(): boolean {
    return verboseEnabled
}

function write(prefix: string, message: string): void {
    process.stderr.write(`${prefix}${message}\n`)
}

/** A normal progress message. */
export function log(message: string): void {
    write("", message)
}

/** Details — only with --verbose / BLE_MCP_VERBOSE=1. */
export function debug(message: string): void {
    if (verboseEnabled) write("[debug] ", message)
}

export function warn(message: string): void {
    write("[warn] ", message)
}

/**
 * Guard against accidental stdout output in MCP server mode: console.log and
 * console.info are redirected to stderr so that foreign code cannot corrupt the
 * protocol.
 */
export function protectStdout(): void {
    const toStderr = (...args: unknown[]): void => {
        write("[stdout-guard] ", args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
    }
    console.log = toStderr
    console.info = toStderr
}
