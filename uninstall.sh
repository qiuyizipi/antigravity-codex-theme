#!/usr/bin/env bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
NODE_BIN="$(command -v node || true)"
for cand in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/current/bin/node"; do
    if [ -z "$NODE_BIN" ] && [ -x "$cand" ]; then
        NODE_BIN="$cand"
    fi
done
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] Node.js not found. Please install Node.js LTS from https://nodejs.org/"
    exit 1
fi
"$NODE_BIN" "$DIR/patch_theme.js" --uninstall "$@"
