'use strict'

/**
 * DeepSeek Harness — portable desktop shell.
 *
 * The desktop app is a thin wrapper: it boots the real `dsh` harness (the web
 * profile) as a child process and shows its localhost UI in a BrowserWindow.
 * All harness state — conversations, settings, credentials, profiles, presets —
 * lives under a portable `data/` directory next to the app, so copying the app
 * folder to another computer moves the entire setup with it. No installs, no
 * configuration on the target machine.
 *
 * Dev mode (`electron .` from apps/desktop): spawns the checkout's CLI from
 * source (`node --import tsx/esm apps/cli/src/bin.ts`) and uses
 * `apps/desktop/data` as the portable home.
 *
 * Packaged mode: spawns the staged CLI bundle at
 * `<resources>/cli/node_modules/@deepseek-ai/dsh/lib/bin.js` using Electron's
 * own binary as Node (ELECTRON_RUN_AS_NODE=1) and uses `<executable dir>/data`
 * as the portable home.
 */

const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const updater = require('./updater')

const APP_NAME = 'DeepSeek Harness'
const DEV_MODE = !app.isPackaged
const APP_ROOT = __dirname
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

/** The folder that travels with the app: next to the executable when packaged. */
function portableRoot() {
  if (DEV_MODE) return APP_ROOT
  // macOS: the executable sits inside <root>/DeepSeek Harness.app/Contents/MacOS;
  // the portable root is the folder that contains the .app bundle.
  if (process.platform === 'darwin') {
    return path.resolve(process.execPath, '..', '..', '..', '..')
  }
  return path.dirname(process.execPath)
}

/** Where the harness keeps everything. Overridable for manual testing. */
const DSH_HOME = process.env.DSH_HOME || path.join(portableRoot(), 'data')

/**
 * How to launch the harness CLI.
 * @returns {{ executable: string, args: string[], cwd: string, env?: Record<string, string> }}
 */
function cliLaunch() {
  if (DEV_MODE) {
    return {
      executable: process.env.DSH_DESKTOP_NODE || 'node',
      args: ['--import', 'tsx/esm', path.join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts')],
      cwd: REPO_ROOT,
    }
  }
  return {
    executable: process.execPath,
    args: [path.join(process.resourcesPath, 'cli', 'lib', 'bin.js')],
    cwd: path.join(process.resourcesPath, 'cli'),
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

// Keep Electron's own per-user state (cookies, localStorage, cache) inside the
// portable folder too, so nothing important is left behind on the host OS.
app.setPath('userData', path.join(DSH_HOME, 'desktop-userdata'))

// Escape hatch for Linux machines without a usable Chromium SUID/namespace
// sandbox (common in VMs and containers): Electron aborts at startup instead
// of running unsandboxed. This shell only loads localhost content, so running
// with the renderer sandbox disabled is acceptable there; prefer fixing the
// chrome-sandbox helper (chown root:root + chmod 4755) to keep it enabled.
if (process.env.DSH_DESKTOP_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox')
}

let harness = null // ChildProcess
let harnessStopped = false
let fatalError = false
let logStream = null
let mainWindow = null

function log(line) {
  try {
    if (logStream === null) {
      fs.mkdirSync(DSH_HOME, { recursive: true })
      logStream = fs.createWriteStream(path.join(DSH_HOME, 'desktop-harness.log'), { flags: 'a' })
    }
    logStream.write(line + '\n')
  } catch {
    // Logging must never break the app.
  }
}

function stopHarness() {
  if (harness === null || harnessStopped) return
  harnessStopped = true
  const child = harness
  harness = null
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  // Give the harness a moment to flush its log and close the server, then
  // force-kill if needed. The timer is disposable: it dies with the process.
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }, 3000)
  killer.unref()
}

/** Wait for the `dsh web: http://127.0.0.1:PORT` line the harness prints once it listens. */
function awaitHarnessUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for the harness to start'))
    }, timeoutMs)
    let buffer = ''
    const onData = (chunk) => {
      buffer = (buffer + String(chunk)).slice(-4096)
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        cleanup()
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`harness exited early (code=${code}, signal=${signal})`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.on('exit', onExit)
  })
}

function startHarness() {
  harnessStopped = false
  const launch = cliLaunch()
  fs.mkdirSync(DSH_HOME, { recursive: true })
  log(`starting harness: ${launch.executable} ${launch.args.join(' ')}`)
  log(`DSH_HOME=${DSH_HOME}`)

  const child = spawn(launch.executable, [...launch.args, 'web', '--no-open', '--port', '0'], {
    cwd: launch.cwd,
    env: {
      ...process.env,
      ...(launch.env || {}),
      DSH_HOME,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  harness = child

  child.stdout.on('data', (chunk) => log(`[harness] ${String(chunk).trimEnd()}`))
  child.stderr.on('data', (chunk) => log(`[harness:err] ${String(chunk).trimEnd()}`))
  child.on('exit', (code, signal) => {
    log(`harness exited (code=${code}, signal=${String(signal)})`)
    // Ignore exits of a replaced child (dev-mode update restarts the harness).
    if (harnessStopped || fatalError || harness !== child) return
    harnessStopped = true
    dialog.showErrorBox(
      `${APP_NAME} — harness stopped`,
      `The harness process exited unexpectedly (code=${code}, signal=${String(signal)}).\n\n` +
      `Log: ${path.join(DSH_HOME, 'desktop-harness.log')}`,
    )
    app.quit()
  })

  return child
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  let retries = 0
  win.loadURL(url)
  win.webContents.on('did-fail-load', (_event, code, description) => {
    // The server is already listening when we parse its URL; retries cover a
    // race between the URL line and the first byte of the page.
    if (retries >= 10) return
    retries += 1
    log(`page load failed (${code}: ${description}), retrying (${retries})`)
    setTimeout(() => {
      if (!win.isDestroyed()) win.loadURL(url)
    }, 500)
  })
  win.on('closed', () => { mainWindow = null })
  return win
}

// One instance per data folder: focus the existing window on second launch.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // Dev-mode update hook: after `git pull`, stop the harness, boot it again
  // (it runs from source, so the new code is picked up), and point the window
  // at the fresh port.
  const restartDesktop = async () => {
    log('restarting harness after update')
    stopHarness()
    const child = startHarness()
    try {
      const url = await awaitHarnessUrl(child, 30000)
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.loadURL(url)
    } catch (error) {
      dialog.showErrorBox(
        `${APP_NAME} — restart failed`,
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        `Log: ${path.join(DSH_HOME, 'desktop-harness.log')}`,
      )
    }
  }

  app.whenReady().then(async () => {
    updater.init({ appRoot: portableRoot(), repoRoot: REPO_ROOT, restart: restartDesktop, log })
    updater.installMenu()
    // Strictly manual updates: the in-window Update button and the Help menu
    // entry both land here; nothing runs on its own.
    // The fire-and-forget channel proves the preload→main bridge works, so a
    // missing line distinguishes "click never arrived" from "check failed".
    ipcMain.on('dsh-desktop:update-clicked', () => log('[updater] Update button clicked'))
    ipcMain.handle('dsh-desktop:update', () => updater.checkNow())
    const child = startHarness()
    try {
      const url = await awaitHarnessUrl(child, 30000)
      mainWindow = createWindow(url)
    } catch (error) {
      fatalError = true
      dialog.showErrorBox(
        `${APP_NAME} — startup failed`,
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        `Log: ${path.join(DSH_HOME, 'desktop-harness.log')}`,
      )
      app.quit()
    }
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  stopHarness()
})

app.on('will-quit', () => {
  if (logStream !== null) {
    try { logStream.end() } catch { /* closing best-effort */ }
    logStream = null
  }
})
