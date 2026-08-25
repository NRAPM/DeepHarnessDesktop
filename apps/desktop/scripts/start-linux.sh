#!/bin/sh
# Portable launcher for the DeepSeek Harness desktop app (Linux).
#
# Chromium aborts at startup unless its SUID sandbox helper (chrome-sandbox)
# is owned by root with mode 4755 — which many machines (VMs, containers,
# distros without SUID support) cannot provide. This launcher checks the
# helper and falls back to --no-sandbox when it is not configured, so the app
# "just opens" everywhere. The page only ever loads http://127.0.0.1 (the
# local harness), so the fallback is safe for this app.
#
# Prefer fixing the helper when possible:
#   sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SB="$DIR/chrome-sandbox"

if [ -u "$SB" ] && [ "$(stat -c %U "$SB" 2>/dev/null)" = "root" ]; then
  exec "$DIR/dsh-desktop" "$@"
else
  echo "[dsh-desktop] chrome-sandbox is not setuid-root; launching with --no-sandbox"
  exec "$DIR/dsh-desktop" --no-sandbox "$@"
fi
