#!/bin/sh
# Build "Work Tracker.app" (macOS): opening it starts the server, closing its window stops it.
#   ./make_app.sh     then drag "Work Tracker.app" into the Dock or /Applications
# The app runs this folder's code and data, so leave the folder where it is (or run this again).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Work Tracker.app"

[ -x "$DIR/.venv/bin/python" ] || python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install -q -r "$DIR/requirements.txt" pywebview

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

ICONSET="$(mktemp -d)/icon.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$DIR/docs/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$DIR/docs/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

# A link to the interpreter inside the app, so the Dock and the menu bar show Work Tracker, not Python
# (the venv's python hands off to Python.app). It uses the venv's packages.
PY="$("$DIR/.venv/bin/python" -c 'import sys; print(sys.base_prefix)')/Resources/Python.app/Contents/MacOS/Python"
SITE="$("$DIR/.venv/bin/python" -c 'import site; print(site.getsitepackages()[0])')"
RUN='./.venv/bin/python'
if [ -x "$PY" ]; then
  ln -s "$PY" "$APP/Contents/MacOS/python"
  RUN="env PYTHONPATH=\"$SITE\" \"$APP/Contents/MacOS/python\""
fi
cat > "$APP/Contents/MacOS/Work Tracker" <<EOF
#!/bin/sh
cd "$DIR" && exec $RUN desktop.py 2>>tracker.log
EOF
chmod +x "$APP/Contents/MacOS/Work Tracker"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Work Tracker</string>
  <key>CFBundleDisplayName</key><string>Work Tracker</string>
  <key>CFBundleIdentifier</key><string>com.worktracker.app</string>
  <key>CFBundleExecutable</key><string>Work Tracker</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
EOF

echo "Built $APP"
[ -f "$HOME/Library/LaunchAgents/com.worktracker.plist" ] && \
  echo "Note: autostart.sh keeps a server running all the time; './autostart.sh remove' so closing the app stops it."
exit 0
