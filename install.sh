#!/bin/bash
# Installs wave-meet-sync as a launchd agent that starts at login.
# Re-run this after moving the folder. `./install.sh uninstall` removes it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="local.wave-meet-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Uninstalled $LABEL"
  exit 0
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "node not found on PATH" >&2; exit 1; }

# Keep the asdf shim on PATH rather than baking in a version-pinned install
# path, so a future `asdf install nodejs` doesn't break the agent.
NODE_PATH_ENTRIES="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/sync.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_PATH_ENTRIES</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/wave-meet-sync.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/wave-meet-sync.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed $LABEL"
echo "  log:  tail -f $LOGDIR/wave-meet-sync.log"
echo "  stop: launchctl bootout gui/$(id -u)/$LABEL"
