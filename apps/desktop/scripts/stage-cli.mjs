#!/usr/bin/env node
/**
 * Stage the built dsh CLI (and its whole dependency tree, including the web
 * frontend dist) for packaging.
 *
 * Prerequisite: `pnpm build` at the repository root (builds every package's
 * lib/ output and the web frontend dist/).
 *
 * Pipeline:
 *   1. `pnpm --filter @deepseek-ai/dsh deploy --legacy <target>` — copies the
 *      CLI package plus its production dependencies into a self-contained
 *      node_modules tree (workspace packages are packed fresh, so the staged
 *      lib/bin.js is the freshly built bundle).
 *   2. Flatten: replace every symlink under node_modules with a real copy and
 *      drop .pnpm — the packaged app extracts this tree with extract-zip
 *      (yauzl), which does not follow symlinks.
 *   3. Zip the flattened tree into resources/cli.zip — a SINGLE file, because
 *      electron-builder prunes node_modules from any directory it copies as
 *      extraResources, but copies plain files untouched. The desktop app
 *      extracts cli.zip next to itself on first run.
 *
 * --legacy: pnpm 10+ refuses `deploy` unless the workspace sets
 * inject-workspace-packages; this workspace uses classic non-injected links.
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const target = resolve(root, 'apps', 'desktop', 'resources', 'cli')
const zipPath = resolve(root, 'apps', 'desktop', 'resources', 'cli.zip')

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
// shell on Windows: pnpm resolves through pnpm.cmd, which Node cannot spawn
// directly without a shell.
execFileSync('pnpm', ['--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', target], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

// The deployed package itself lives at the TARGET ROOT (its own lib/,
// package.json, config/), while its dependencies sit under node_modules/.
const stagedEntry = join(target, 'lib', 'bin.js')
if (!existsSync(stagedEntry)) {
  console.error(`[stage-cli] expected ${stagedEntry} after deploy — inspect the output above.`)
  process.exit(1)
}
console.log(`[stage-cli] staged entry ready: ${stagedEntry}`)

// The web profile loads packages beyond the CLI's PROD dependency closure
// (devDependencies and peer-reached runtime imports), so pnpm deploy's tree
// is incomplete by design. Complete the closure: for every workspace package
// (packages/*/* and vendor/*) absent from the stage, copy its published
// surface (package.json + built lib, + dist for client packages).
function copyWorkspacePackage(src, manifest) {
  const dest = join(target, 'node_modules', ...String(manifest.name).split('/'))
  if (existsSync(dest)) return false
  mkdirSync(dest, { recursive: true })
  // Copy the whole package surface (package.json, lib/, dist/, root entry
  // scripts, prebuilds...) except source and the workspace's own node_modules.
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'src' || entry.name === 'tests') continue
    cpSync(join(src, entry.name), join(dest, entry.name), { recursive: true })
  }
  console.log(`[stage-cli] copied workspace package ${manifest.name} into the stage`)
  return true
}

const vendorDir = join(root, 'vendor')
if (existsSync(vendorDir)) {
  for (const vendored of readdirSync(vendorDir)) {
    const src = join(vendorDir, vendored)
    if (!lstatSync(src).isDirectory()) continue
    const manifestPath = join(src, 'package.json')
    if (!existsSync(manifestPath) || !existsSync(join(src, 'lib'))) continue
    copyWorkspacePackage(src, JSON.parse(readFileSync(manifestPath, 'utf8')))
  }
}
const packagesRoot = join(root, 'packages')
if (existsSync(packagesRoot)) {
  for (const group of readdirSync(packagesRoot)) {
    const groupDir = join(packagesRoot, group)
    if (!lstatSync(groupDir).isDirectory()) continue
    for (const pkg of readdirSync(groupDir)) {
      const src = join(groupDir, pkg)
      if (!lstatSync(src).isDirectory()) continue
      const manifestPath = join(src, 'package.json')
      if (!existsSync(manifestPath) || !existsSync(join(src, 'lib'))) continue
      copyWorkspacePackage(src, JSON.parse(readFileSync(manifestPath, 'utf8')))
    }
  }
}
// Native workspace packages live under native/landlock-run/packages/*.
const landlockPackages = join(root, 'native', 'landlock-run', 'packages')
if (existsSync(landlockPackages)) {
  for (const pkg of readdirSync(landlockPackages)) {
    const src = join(landlockPackages, pkg)
    if (!lstatSync(src).isDirectory()) continue
    const manifestPath = join(src, 'package.json')
    if (!existsSync(manifestPath)) continue
    copyWorkspacePackage(src, JSON.parse(readFileSync(manifestPath, 'utf8')))
  }
}
// Apps are workspace members too (@deepseek-ai/dsh-web-frontend ships the
// built web UI under apps/web/dist).
const appsRoot = join(root, 'apps')
if (existsSync(appsRoot)) {
  for (const app of readdirSync(appsRoot)) {
    // The desktop shell itself must not be copied into its own stage.
    if (app === 'desktop') continue
    const src = join(appsRoot, app)
    if (!lstatSync(src).isDirectory()) continue
    const manifestPath = join(src, 'package.json')
    if (!existsSync(manifestPath)) continue
    copyWorkspacePackage(src, JSON.parse(readFileSync(manifestPath, 'utf8')))
  }
}

// Dev-reached packages can also need plain npm dependencies that pnpm deploy
// never installed (e.g. zod). Resolve every missing dependency from the
// workspace's own store (.pnpm virtual store, then hoisted root) and copy it
// into the stage, so the staged tree is a complete runtime closure.
function ensureNpmDeps() {
  const stagedModules = join(target, 'node_modules')
  const rootPnpm = join(root, 'node_modules', '.pnpm')
  const rootModules = join(root, 'node_modules')
  const manifests = []
  ;(function collect(dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const abs = join(dir, entry.name)
      const pj = join(abs, 'package.json')
      if (existsSync(pj)) manifests.push(pj)
      collect(abs)
    }
  })(stagedModules)
  const seen = new Set()
  let copied = 0
  for (const pj of manifests) {
    let manifest
    try { manifest = JSON.parse(readFileSync(pj, 'utf8')) } catch { continue }
    const deps = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }
    for (const name of Object.keys(deps)) {
      if (seen.has(name)) continue
      seen.add(name)
      const rel = name.split('/')
      const dest = join(stagedModules, ...rel)
      if (existsSync(dest)) continue
      let found = null
      if (existsSync(rootPnpm)) {
        const pattern = rel.length === 2 ? `${rel[0]}+${rel[1]}@` : `${name}@`
        for (const dir of readdirSync(rootPnpm)) {
          if (!dir.startsWith(pattern)) continue
          const candidate = join(rootPnpm, dir, 'node_modules', ...rel)
          if (existsSync(candidate)) { found = candidate; break }
        }
      }
      if (found === null) {
        const hoisted = join(rootModules, ...rel)
        if (existsSync(hoisted)) found = hoisted
      }
      if (found !== null) {
        mkdirSync(dirname(dest), { recursive: true })
        cpSync(found, dest, { recursive: true, dereference: true })
        copied += 1
        console.log(`[stage-cli] copied npm dep ${name} into the stage`)
      } else {
        console.warn(`[stage-cli] WARNING: npm dep ${name} (required by ${pj}) not found in the workspace store`)
      }
    }
  }
  console.log(`[stage-cli] npm deps completed (${copied} copied)`)
}
ensureNpmDeps()

// The store pack of a package never contains postinstall-built artifacts
// (koffi, node-pty, ...). Copy missing native pieces (build/, bin/, *.node)
// from the workspace's own built store copy into the stage.
function ensureNativeBuilds() {
  const stagedModules = join(target, 'node_modules')
  const rootPnpm = join(root, 'node_modules', '.pnpm')
  const targets = []
  for (const entry of readdirSync(stagedModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(stagedModules, entry.name)
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.isDirectory()) targets.push({ name: `${entry.name}/${sub.name}`, dir: join(scopeDir, sub.name) })
      }
    } else {
      targets.push({ name: entry.name, dir: join(stagedModules, entry.name) })
    }
  }
  let copied = 0
  if (existsSync(rootPnpm)) {
    for (const { name, dir } of targets) {
      const rel = name.split('/')
      const pattern = rel.length === 2 ? `${rel[0]}+${rel[1]}@` : `${name}@`
      for (const store of readdirSync(rootPnpm)) {
        if (!store.startsWith(pattern)) continue
        const src = join(rootPnpm, store, 'node_modules', ...rel)
        if (!existsSync(src)) break
        for (const sub of ['build', 'bin']) {
          const s = join(src, sub)
          const d = join(dir, sub)
          if (existsSync(s) && !existsSync(d)) {
            cpSync(s, d, { recursive: true })
            copied += 1
          }
        }
        for (const file of readdirSync(src)) {
          if (file.endsWith('.node')) {
            const d = join(dir, file)
            if (!existsSync(d)) { cpSync(join(src, file), d); copied += 1 }
          }
        }
        break
      }
    }
  }
  console.log(`[stage-cli] native artifacts synced (${copied} copied)`)
}
ensureNativeBuilds()

// ---- Flatten symlinks ------------------------------------------------------
// pnpm deploys node_modules as symlinks into node_modules/.pnpm. The packaged
// app extracts with extract-zip (yauzl), which does not support symlinks, so
// replace every symlink with a real copy of its target, then drop .pnpm.
function flatten(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.pnpm') continue
    const abs = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const targetPath = resolve(dir, readlinkSync(abs))
      rmSync(abs, { force: true })
      if (existsSync(targetPath)) {
        if (lstatSync(targetPath).isDirectory()) {
          cpSync(targetPath, abs, { recursive: true, dereference: true })
        } else {
          cpSync(targetPath, abs, { dereference: true })
        }
      }
    } else if (entry.isDirectory()) {
      flatten(abs)
    }
  }
}
console.log('[stage-cli] flattening node_modules symlinks')
flatten(join(target, 'node_modules'))
rmSync(join(target, 'node_modules', '.pnpm'), { recursive: true, force: true })
rmSync(join(target, 'node_modules', '.bin'), { recursive: true, force: true })

// ---- Minimal deflate ZIP writer (no external tools needed) -----------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeZip(srcDir, outFile) {
  const files = []
  ;(function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else files.push(abs)
    }
  })(srcDir)

  const chunks = []
  const central = []
  let offset = 0
  const DOS_TIME = 0
  for (const abs of files) {
    const data = readFileSync(abs)
    const name = Buffer.from(relative(srcDir, abs).split(sep()).join('/'), 'utf8')
    const crc = crc32(data)
    const deflated = deflateRawSync(data, { level: 9 })
    const use = deflated.length < data.length ? deflated : data
    const method = use === deflated ? 8 : 0

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0) // signature
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt32LE(DOS_TIME, 10) // time + date (2+2)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(use.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(name.length, 26)
    lfh.writeUInt16LE(0, 28) // extra length
    chunks.push(lfh, name, use)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0) // signature
    ch.writeUInt16LE(20, 4) // version made by
    ch.writeUInt16LE(20, 6) // version needed
    ch.writeUInt16LE(0x0800, 8) // flags
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(DOS_TIME, 12) // time + date
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(use.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30) // extra length
    ch.writeUInt16LE(0, 32) // comment length
    ch.writeUInt16LE(0, 34) // disk number
    ch.writeUInt16LE(0, 36) // internal attrs
    const mode = (statSync(abs).mode & 0o777) | 0o100000
    ch.writeUInt32LE((mode << 16) >>> 0, 38) // external attrs
    ch.writeUInt32LE(offset, 42) // local header offset
    central.push(ch, name)
    offset += lfh.length + name.length + use.length
  }

  const centralStart = offset
  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  writeFileSync(outFile, Buffer.concat([...chunks, ...central, eocd]))
  console.log(`[stage-cli] wrote ${outFile} (${files.length} files)`)

  function sep() { return process.platform === 'win32' ? '\\' : '/' }
}

console.log('[stage-cli] zipping the flattened tree')
writeZip(target, zipPath)
console.log(`[stage-cli] ready: ${zipPath}`)
