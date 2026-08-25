'use strict'

/**
 * Manual updater for the portable desktop app.
 *
 * Update source: GitHub Releases of the owning repository (NRAPM/
 * DeepHarnessDesktop). The repo's desktop-release workflow builds the
 * portable app on every master push (nightly release) and on every `dsh-v*`
 * tag, attaching one zip per OS with a stable name
 * (`dsh-desktop-<os>-<arch>.zip`). This module queries the GitHub API for the
 * latest release, finds the asset for the running platform, downloads it, and
 * swaps the app folder on quit — preserving `data/`.
 *
 * Updating is strictly manual: the in-window Update button and the Help menu
 * entry both call checkNow(); nothing runs on its own. Every step is logged
 * through the injected `log` function (the same desktop-harness.log the main
 * process writes), so failures are always diagnosable.
 *
 * The swap is performed by a tiny detached helper script because the running
 * executable cannot replace itself: the helper waits for the main process to
 * exit, moves the old app aside, moves the new app in, restores `data/`, and
 * relaunches.
 */

const { app, dialog, Menu } = require('electron')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const extractZip = require('extract-zip')

const APP_NAME = 'DeepSeek Harness'
// The update source: releases published on this repo by .github/workflows/
// desktop-release.yml (nightly on every master push, tagged on dsh-v* tags).
const REPO = 'NRAPM/DeepHarnessDesktop'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

/** Stable asset naming shared with .github/workflows/desktop-release.yml. */
function assetName() {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return `dsh-desktop-${os}-${arch}.zip`
}

let appRoot = null // portable app folder; set by init() from main.js
let repoRoot = null // git checkout root (dev mode); set by init()
let restart = null // restart callback (dev mode); set by init()
let log = () => {} // wired to desktop-harness.log by init()

/** Register the portable root, the git checkout, the log sink, and the restart hook. */
function init({ appRoot: root, repoRoot: gitRoot, restart: restartFn, log: logFn }) {
  appRoot = root
  repoRoot = gitRoot ?? null
  restart = typeof restartFn === 'function' ? restartFn : null
  if (typeof logFn === 'function') log = logFn
}

/** https GET that resolves JSON, resolves null on 404, and follows no redirects. */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'dsh-desktop-updater',
        Accept: 'application/vnd.github+json',
      },
    }, (res) => {
      if (res.statusCode === 404) { res.resume(); return resolve(null) }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub responded ${res.statusCode} for ${url}`)) }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('update check timed out')))
  })
}

/** Parse "0.1.2" or "0.1.2-rc.1" into comparable numbers. */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

/** True when `latest` should replace `current`. */
function isNewer(latest, current) {
  if (latest === null || current === null) return false
  if (latest.major !== current.major) return latest.major > current.major
  if (latest.minor !== current.minor) return latest.minor > current.minor
  if (latest.patch !== current.patch) return latest.patch > current.patch
  // Same numbers: a stable release beats a prerelease of the same numbers.
  return latest.prerelease === undefined && current.prerelease !== undefined
}

/**
 * Ask GitHub for the newest release and decide whether an update applies.
 * @returns {Promise<null | { error: string } | { version, url, size, notes }>}
 *          null = no newer release for this platform; { error } = check failed.
 */
async function checkForUpdates({ silent = false } = {}) {
  if (process.env.DSH_DESKTOP_DISABLE_UPDATES === '1') {
    log('[updater] disabled by DSH_DESKTOP_DISABLE_UPDATES')
    return null
  }
  try {
    const base = process.env.DSH_DESKTOP_UPDATER_URL || API_URL
    log(`[updater] checking ${base}`)
    const release = await httpsGetJson(base)
    if (release === null) {
      log('[updater] no releases found — nothing to update from')
      return null
    }
    const tag = String(release.tag_name).replace(/^dsh-v/i, '')
    const latest = parseVersion(tag)
    const current = parseVersion(app.getVersion())
    log(`[updater] latest tag ${release.tag_name} (${tag}), running ${app.getVersion()}`)
    if (!isNewer(latest, current)) {
      log('[updater] no newer version')
      return null
    }
    const asset = (release.assets || []).find((entry) => entry.name === assetName())
    if (asset === undefined) {
      log(`[updater] newer version but no asset named ${assetName()} — release predates desktop builds`)
      return null
    }
    log(`[updater] update available: ${tag} (${asset.size || '?'} bytes)`)
    return {
      version: tag,
      url: asset.browser_download_url,
      size: asset.size || 0,
      notes: typeof release.body === 'string' ? release.body : '',
    }
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    log(`[updater] check failed: ${message}`)
    if (!silent) {
      dialog.showErrorBox(`${APP_NAME} — update check failed`, message)
    }
    return { error: message }
  }
}

/** Ask the user whether to download and install. */
async function promptForUpdate(info) {
  const detail = [`Current version: ${app.getVersion()}`, `New version: ${info.version}`]
    .concat(info.size > 0 ? [`Download size: ${(info.size / 1024 / 1024).toFixed(1)} MB`] : [])
    .concat(info.notes ? [`\n${info.notes.slice(0, 400)}`] : [])
    .join('\n')
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: `${APP_NAME} — update available`,
    message: `Version ${info.version} is available`,
    detail,
    buttons: ['Download & Install', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  return response === 0
}

/** Download `url` to `dest`, following redirects (GitHub asset URLs redirect). */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const get = (target, hops) => {
      if (hops > 5) { file.destroy(); return reject(new Error('too many redirects')) }
      const req = https.get(target, { headers: { 'User-Agent': 'dsh-desktop-updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location !== undefined) {
          res.resume()
          return get(res.headers.location, hops + 1)
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download failed with HTTP ${res.statusCode}`)) }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', reject)
        res.on('error', reject)
      })
      req.on('error', reject)
      // A stalled connection must not leave the button stuck on "Checking…".
      req.setTimeout(120000, () => req.destroy(new Error('download stalled (no data for 120s)')))
    }
    get(url, 0)
  })
}

/**
 * Download the update and schedule the swap.
 * In dev mode the app folder is a git checkout, so applying is refused.
 * @returns {'applied' | 'dev' | 'failed'}
 */
async function downloadAndInstall(info) {
  const zipPath = path.join(app.getPath('temp'), 'dsh-desktop-update.zip')
  log(`[updater] downloading ${info.url}`)
  try {
    await download(info.url, zipPath)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    log(`[updater] download failed: ${message}`)
    dialog.showErrorBox(`${APP_NAME} — download failed`, message)
    return 'failed'
  }
  log('[updater] download complete')

  if (!app.isPackaged) {
    log('[updater] dev mode — refusing to swap the checkout')
    dialog.showMessageBox({
      type: 'info',
      title: `${APP_NAME} — update downloaded`,
      message: `Version ${info.version} is ready, but this dev checkout cannot swap itself.`,
      detail: 'Run git pull and rebuild the repo to update this copy.',
    })
    return 'dev'
  }

  const nextDir = path.join(appRoot, 'dsh-update-next')
  const oldDir = path.join(appRoot, 'dsh-update-old')
  try {
    fs.rmSync(nextDir, { recursive: true, force: true })
    fs.rmSync(oldDir, { recursive: true, force: true })
  } catch (error) {
    log(`[updater] could not clean update dirs: ${String(error instanceof Error ? error.message : error)}`)
    return 'failed'
  }
  try {
    log(`[updater] unpacking into ${nextDir}`)
    await extractZip(zipPath, { dir: nextDir })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    log(`[updater] unpack failed: ${message}`)
    dialog.showErrorBox(`${APP_NAME} — update failed`, `Could not unpack the update:\n${message}`)
    return 'failed'
  }

  try {
    scheduleSwap(nextDir, oldDir)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    log(`[updater] swap scheduling failed: ${message}`)
    dialog.showErrorBox(`${APP_NAME} — update failed`, `Could not schedule the swap:\n${message}`)
    return 'failed'
  }
  log('[updater] swap scheduled — the app will restart itself')
  dialog.showMessageBox({
    type: 'info',
    title: `${APP_NAME} — updating`,
    message: `Version ${info.version} downloaded and unpacked.`,
    detail: 'The app will close, replace itself, and restart in a few seconds. Your data folder is preserved.',
  })
  return 'applied'
}

/** Write and detach the platform swap helper, then close the app. */
function scheduleSwap(nextDir, oldDir) {
  const scriptPath = path.join(appRoot, process.platform === 'win32' ? '.dsh-apply-update.cmd' : '.dsh-apply-update.sh')
  const content = process.platform === 'win32'
    ? [
        '@echo off',
        'timeout /t 2 /nobreak >nul',
        'set APP_ROOT=%~1',
        'set NEXT=%~2',
        'set OLD=%~3',
        'if exist "%OLD%" rmdir /s /q "%OLD%" >nul 2>&1',
        'if exist "%APP_ROOT%\\data" move "%APP_ROOT%\\data" "%APP_ROOT%\\data.bak" >nul',
        'move "%APP_ROOT%" "%OLD%" >nul',
        'move "%NEXT%" "%APP_ROOT%" >nul',
        'if exist "%OLD%\\data.bak" move "%OLD%\\data.bak" "%APP_ROOT%\\data" >nul',
        'rmdir /s /q "%OLD%" >nul 2>&1',
        'start "" /d "%APP_ROOT%" "dsh-desktop.exe"',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        'sleep 2',
        'APP_ROOT="$1"',
        'NEXT="$2"',
        'OLD="$3"',
        'rm -rf "$OLD"',
        'if [ -d "$APP_ROOT/data" ]; then mv "$APP_ROOT/data" "$APP_ROOT/data.bak"; fi',
        'mv "$APP_ROOT" "$OLD"',
        'mv "$NEXT" "$APP_ROOT"',
        'if [ -d "$OLD/data.bak" ]; then mv "$OLD/data.bak" "$APP_ROOT/data"; fi',
        'chmod +x "$APP_ROOT/dsh-desktop" 2>/dev/null || true',
        'if [ "$(uname)" = "Darwin" ]; then open "$APP_ROOT/DeepSeek Harness.app"; else nohup "$APP_ROOT/dsh-desktop" >/dev/null 2>&1 & fi',
      ].join('\n')
  fs.writeFileSync(scriptPath, content)
  if (process.platform !== 'win32') {
    try { fs.chmodSync(scriptPath, 0o755) } catch { /* Windows-only concerns */ }
  }
  const child = spawn(scriptPath, [appRoot, nextDir, oldDir], { detached: true, stdio: 'ignore' })
  child.unref()
  log(`[updater] detached helper: ${scriptPath}`)
}

/**
 * Manual update wired to the Help menu and the in-window Update button.
 * Never rejects: the button always receives a status.
 *
 * Dev mode (a git checkout runs the harness from source): the update IS
 * `git pull` — new code lands on disk, then the app restarts the harness.
 * Packaged mode: download the new portable build from the repo's Releases.
 */
async function checkNow() {
  try {
    if (!app.isPackaged) return await devPullUpdate()
    const info = await checkForUpdates({ silent: false })
    if (info === null) {
      dialog.showMessageBox({
        type: 'info',
        title: `${APP_NAME} — update check`,
        message: 'You are up to date.',
        detail: `Running version: ${app.getVersion()}`,
      })
      return { status: 'up-to-date' }
    }
    if (info.error !== undefined) {
      // The failure dialog was already shown by checkForUpdates.
      return { status: 'check-failed' }
    }
    const yes = await promptForUpdate(info)
    if (!yes) return { status: 'later' }
    const outcome = await downloadAndInstall(info)
    if (outcome === 'applied') return { status: 'restarting' }
    if (outcome === 'dev') return { status: 'downloaded' }
    return { status: 'error' }
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    log(`[updater] unexpected failure: ${message}`)
    dialog.showErrorBox(`${APP_NAME} — update failed`, `Unexpected error:\n${message}`)
    return { status: 'error' }
  }
}

/** Dev mode: pull the latest official harness, then restart. */
async function devPullUpdate() {
  if (repoRoot === null || restart === null) {
    log('[updater] dev mode but no git checkout/restart hook — falling back to release check')
    return { status: 'up-to-date' }
  }
  log(`[updater] dev mode: git pull in ${repoRoot}`)
  try {
    // Prefer the OFFICIAL harness repo (the "upstream" remote) so the dev
    // machine tracks the latest real releases; fall back to origin (the
    // user's own repo) when no upstream remote is configured.
    let remotes = ''
    try {
      remotes = await new Promise((resolve, reject) => {
        execFile('git', ['remote'], { cwd: repoRoot, shell: process.platform === 'win32' }, (error, out) => {
          if (error !== null) reject(error)
          else resolve(out)
        })
      })
    } catch { /* remotes stays empty */ }
    const hasUpstream = remotes.split(/\r?\n/).includes('upstream')
    const args = hasUpstream
      ? ['pull', 'upstream', 'master', '--no-edit']
      : ['pull', '--ff-only']
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd: repoRoot,
        timeout: 120000,
        // shell on Windows: git resolves through git.cmd.
        shell: process.platform === 'win32',
      }, (error, out, err) => {
        if (error !== null) reject(error)
        else resolve({ stdout: out, stderr: err })
      })
    })
    const output = `${stdout}${stderr}`.trim()
    log(`[updater] git pull ok (${hasUpstream ? 'upstream' : 'origin'}): ${output}`)
    dialog.showMessageBox({
      type: 'info',
      title: `${APP_NAME} — updated`,
      message: `Pulled the latest harness from ${hasUpstream ? 'the official repo' : 'origin'}.`,
      detail: `${output}\n\nThe app will restart to load the new code.` +
        '\nNote: interface changes may need a rebuild (pnpm build) to appear.',
    })
    await restart()
    return { status: 'restarting' }
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    log(`[updater] git pull failed: ${message}`)
    dialog.showErrorBox(
      `${APP_NAME} — update failed`,
      `git pull failed. Nothing was changed.\n\n${message}` +
      (repoRoot !== null ? `\n\nCheckout: ${repoRoot}` : ''),
    )
    return { status: 'error' }
  }
}

/** Help menu with the manual update entry (app menu on macOS). */
function installMenu() {
  const template = []
  if (process.platform === 'darwin') template.push({ role: 'appMenu' })
  template.push(
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => { checkNow() } },
      ],
    },
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

module.exports = { init, installMenu, checkNow, checkForUpdates }
