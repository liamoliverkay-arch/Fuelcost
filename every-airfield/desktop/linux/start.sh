#!/bin/sh
# Starts Every Airfield on Linux. Chromium's sandbox needs either its helper (chrome-sandbox, owned by
# root) or unprivileged user namespaces; some systems (e.g. Ubuntu 23.10 and newer) allow neither for
# apps outside the package manager, so then the app starts without that extra layer instead of failing.
DIR="$(cd "$(dirname "$0")" && pwd)"
# started from a terminal inside VS Code (or another Electron app)? That sets ELECTRON_RUN_AS_NODE,
# which would run the app as plain Node.js and exit at once.
unset ELECTRON_RUN_AS_NODE
HELPER="$DIR/chrome-sandbox"
if [ -u "$HELPER" ] && [ "$(stat -c %u "$HELPER" 2>/dev/null)" = "0" ]; then
  exec "$DIR/every-airfield" "$@"
fi
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "0" ] &&
   [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = "1" ]; then
  exec "$DIR/every-airfield" "$@"
fi
exec "$DIR/every-airfield" --no-sandbox "$@"
