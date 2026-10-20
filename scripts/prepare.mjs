#!/usr/bin/env node
/**
 * Build step that runs when the package is installed from git.
 *
 * npm prepares a git dependency by cloning it into a temp directory and
 * running `npm install` there, inheriting its own config as npm_config_*
 * environment variables. During `npm install -g` that includes
 * npm_config_global=true, which makes the child npm skip installing the
 * clone's own dependencies — so `tsc` from devDependencies is missing and a
 * plain "tsc" prepare script fails with "tsc: command not found".
 *
 * This script strips the inherited npm config, fetches the dev dependencies
 * if the compiler is not there yet (--ignore-scripts avoids recursing into
 * prepare) and runs the local TypeScript compiler.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const tsc = join(root, "node_modules", ".bin", "tsc")

// Drop npm_config_* leaked from the parent npm so the child install behaves
// like a normal local install of the clone.
const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
)

if (!existsSync(tsc)) {
    const install = spawnSync(
        "npm",
        ["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save"],
        { cwd: root, env, stdio: "inherit" },
    )
    if (install.status !== 0) process.exit(install.status ?? 1)
}

const build = spawnSync(tsc, [], { cwd: root, env, stdio: "inherit" })
process.exit(build.status ?? 1)
