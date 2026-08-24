#!/usr/bin/env node
/**
 * Stage the built dsh CLI (and its whole dependency tree, including the web
 * frontend dist) into apps/desktop/resources/cli for packaging.
 *
 * Prerequisite: `pnpm build` at the repository root (builds every package's
 * lib/ output and the web frontend dist/). This script then runs
 * `pnpm --filter @deepseek-ai/dsh deploy <target>`, which copies the CLI
 * package plus its production dependencies into a self-contained node_modules
 * tree. The packaged Electron app spawns that staged entry with
 * ELECTRON_RUN_AS_NODE=1.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const target = resolve(root, 'apps', 'desktop', 'resources', 'cli')

const builtEntry = join(root, 'apps', 'cli', 'lib', 'bin.js')
if (!existsSync(builtEntry)) {
  console.error(
    `[stage-cli] ${builtEntry} not found.\n` +
    '[stage-cli] Run `pnpm build` at the repository root first (it builds all lib/ outputs and the web dist).',
  )
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
console.log(`[stage-cli] deploying @deepseek-ai/dsh into ${target}`)
// --legacy: pnpm 10+ refuses `deploy` unless the workspace sets
// inject-workspace-packages; this workspace uses classic non-injected links.
execFileSync('pnpm', ['--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', target], {
  cwd: root,
  stdio: 'inherit',
})

const stagedEntry = join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(stagedEntry)) {
  console.error(`[stage-cli] expected ${stagedEntry} after deploy — inspect the output above.`)
  process.exit(1)
}
console.log(`[stage-cli] staged entry ready: ${stagedEntry}`)
