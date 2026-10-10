#!/usr/bin/env bash
# Adds LiveSample to the application launcher (KDE Plasma, GNOME, anything
# that reads ~/.local/share/applications). Runs the app from this checkout, so
# `git pull && npm run build` is all an update needs.
#
#   npm run install:desktop            install
#   npm run install:desktop -- --remove
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET="$APPS/livesample.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$TARGET"
  echo "Removed $TARGET"
else
  if [[ ! -f "$DIR/dist/index.html" || ! -f "$DIR/dist-host/host.cjs" ]]; then
    echo "Build first: npm run build" >&2
    exit 1
  fi
  mkdir -p "$APPS"
  sed -e "s|@EXEC@|\"$DIR/node_modules/.bin/electron\" \"$DIR\"|" \
      -e "s|@DIR@|$DIR|" \
      "$DIR/linux/livesample.desktop.in" > "$TARGET"
  chmod 644 "$TARGET"
  echo "Installed $TARGET"
fi

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
