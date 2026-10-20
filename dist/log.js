/**
 * Logging. IMPORTANT: everything goes to stderr.
 *
 * When the server runs over stdio, stdout is occupied by MCP JSON-RPC messages —
 * any console.log there corrupts the protocol. That is why the project avoids
 * console.log and everything here is written to stderr.
 */
let verboseEnabled = /^(1|true|yes)$/i.test(process.env.LEDSTRIP_MCP_VERBOSE ?? "");
export function setVerbose(value) {
    verboseEnabled = value;
}
export function isVerbose() {
    return verboseEnabled;
}
function write(prefix, message) {
    process.stderr.write(`${prefix}${message}\n`);
}
/** A normal progress message. */
export function log(message) {
    write("", message);
}
/** Details — only with --verbose / LEDSTRIP_MCP_VERBOSE=1. */
export function debug(message) {
    if (verboseEnabled)
        write("[debug] ", message);
}
export function warn(message) {
    write("[warn] ", message);
}
/**
 * Guard against accidental stdout output in MCP server mode: console.log and
 * console.info are redirected to stderr so that foreign code cannot corrupt the
 * protocol.
 */
export function protectStdout() {
    const toStderr = (...args) => {
        write("[stdout-guard] ", args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    console.log = toStderr;
    console.info = toStderr;
}
//# sourceMappingURL=log.js.map