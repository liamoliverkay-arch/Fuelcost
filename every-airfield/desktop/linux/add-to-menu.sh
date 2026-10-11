#!/bin/sh
# Adds Every Airfield to your desktop's app menu (for this user only; nothing needs sudo).
DIR="$(cd "$(dirname "$0")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
cat > "$APPS/every-airfield.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Every Airfield
Comment=World airport map with live planes and fuel prices
Exec="$DIR/start.sh" %U
Icon=$DIR/icon.png
Terminal=false
Categories=Utility;Maps;
StartupWMClass=Every Airfield
DESKTOP
chmod +x "$APPS/every-airfield.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1
echo "Added Every Airfield to your app menu. To remove it later, delete $APPS/every-airfield.desktop"
