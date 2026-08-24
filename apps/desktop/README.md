# DeepSeek Harness — portable desktop app (PoC)

An Electron shell around the `dsh` web profile. It boots the real harness as a
child process and shows the localhost UI in a desktop window. The entire setup
— conversations, settings, API keys, plugin configuration, presets — lives in a
portable `data/` folder next to the app, so you can copy the whole app folder
to another computer and just open it. No installs, no configuration.

## How it works

| Concern | Choice |
| --- | --- |
| Harness | The real `dsh web` profile, spawned as a child process with `--no-open --port 0` (OS-assigned port, no collisions) |
| Window URL | Parsed from the `dsh web: http://127.0.0.1:PORT` line the harness prints once it listens |
| Data home | `DSH_HOME` is forced to `<app folder>/data` — everything the harness stores lands there |
| Electron's own state | `userData` is redirected into `<data>/desktop-userdata`, so cookies/localStorage travel too |
| Logs | Harness output is appended to `<data>/desktop-harness.log` |
| Dev mode | Spawns the checkout's CLI from source: `node --import tsx/esm apps/cli/src/bin.ts` |
| Packaged mode | Spawns the staged CLI bundle under `resources/cli` using Electron's own binary as Node (`ELECTRON_RUN_AS_NODE=1`) — no system Node needed |

## Prerequisites

- Node `^22.19.0 || >=24.0.0`, pnpm `11.x` (the repo standard).
- A built repository: `pnpm build` (builds every package's `lib/` and the web
  frontend `dist/`). Needed for packaged builds; dev mode runs from source.
- One-time `pnpm install` after adding this package (downloads Electron, ~100 MB).

## Run in dev (from the checkout)

```sh
pnpm --filter @deepseek-ai/dsh-desktop start
# or: pnpm desktop  (root alias)
```

The portable home is `apps/desktop/data` — created on first run, and the `web`
profile auto-initializes there on first boot. To try it with your existing
setup, copy your current harness home into it:

```sh
cp -r ~/.dsh/. apps/desktop/data/
```

or point the app elsewhere with `DSH_HOME=/path/to/home`.

## Build a portable package

```sh
# 1. Build the repo once (lib outputs + web dist)
pnpm build

# 2. Stage the CLI + its dependency tree into apps/desktop/resources/cli
pnpm --filter @deepseek-ai/dsh-desktop stage:cli

# 3. Package (portable folder)
pnpm --filter @deepseek-ai/dsh-desktop dist:dir
```

Output lands in `apps/desktop/release/`:

- Linux: `release/linux-unpacked/` plus an `AppImage` when using `dist`
- Windows: `release/win-unpacked/` (a folder you can copy as-is; the NSIS
  installer target is deliberately not used — the point is no install)
- macOS: `release/mac/`

### Using it on another computer

1. Copy the whole unpacked folder (e.g. `win-unpacked/`) to the target machine.
2. Double-click the executable.
3. The harness starts, creates/uses `data/` **next to the executable**, and the
   window opens. Copy the folder back the other way and your setup comes with
   it — conversations included.

First run on a fresh machine auto-initializes the `web` profile under `data/`,
so nothing needs configuring.

## Updating (manual, from the harness repo)

The app never stays stuck on its bundled version, but it never updates on its
own either — updating is a click you make. The button behaves by context:

- **Dev mode (this git checkout)** — the harness runs from source, so the
  update **is `git pull`**: the button runs `git pull --ff-only` in the
  checkout, then restarts the harness (the window reconnects to the fresh
  port). Nothing is changed if the pull fails or conflicts. UI changes may
  additionally need `pnpm build` to appear.
- **Packaged mode (portable copies)** — no git exists on those machines, so
  the button downloads the new portable build from this repository's GitHub
  Releases instead (`.github/workflows/desktop-release.yml` builds on every
  master push into a rolling "nightly" release, and on every `dsh-v*` tag).
  Asset names: `dsh-desktop-linux-x64.zip`, `dsh-desktop-win-x64.zip`,
  `dsh-desktop-mac-x64.zip`. The repo must stay **public** — the app queries
  the release API unauthenticated.

**Data safety**: both paths preserve `data/` (conversations, keys, settings)
— only the app + harness are replaced.

**Behavior while unreleased**: with no releases yet, packaged-mode checks
report up to date; the dev-mode button always pulls the latest repo state.

**Overrides**: `DSH_DESKTOP_DISABLE_UPDATES=1` turns the updater off;
`DSH_DESKTOP_UPDATER_URL=<url>` points the release check at another
repository/endpoint (for testing).

## Known caveats (PoC status)

- **macOS signing**: an unsigned app triggers Gatekeeper warnings. For real
  distribution, add `mac.identity` and sign/notarize.
- **Windows SmartScreen**: unsigned builds show "unknown publisher". Sign with
  a code-signing certificate for wide distribution; for personal use, "More
  info → Run anyway" is fine.
- **Bash-tool sandbox on the target OS**: the harness sandboxes `bash` with
  OS facilities (Linux: bubblewrap/Landlock; Windows: restricted-token ACL;
  macOS: `sandbox-exec`). If the target machine lacks them, the bash tool
  reports that its sandbox backend is unavailable — the app itself still runs.
- **Bundled Node version**: packaged mode runs the CLI on Electron's bundled
  Node. Keep Electron reasonably current (Electron ≥ 37) so its Node satisfies
  the repo's `engines` floor. If the harness refuses to start on an older
  Electron, bump `electron` in this package.
- **`pnpm deploy` staging**: `resources/cli` is produced by `pnpm deploy
  --filter @deepseek-ai/dsh`; if that command changes its layout in a future
  pnpm, check the staged entry path the script verifies
  (`resources/cli/node_modules/@deepseek-ai/dsh/lib/bin.js`).
- The shell is a PoC: no auto-update, no tray, no menu bar of its own.
