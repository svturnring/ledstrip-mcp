/**
 * The package version, in one place: package.json.
 *
 * It used to be copied by hand into cli.ts and mcp.ts and drifted there, so it
 * is now read from the manifest at runtime. The relative path is valid both
 * from the repo (dist/cli.js) and from an installed package, since npm always
 * ships package.json at the package root.
 */
import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
export const VERSION = load("../package.json").version;
//# sourceMappingURL=version.js.map