#!/bin/sh
# Arma «Dotrino Terminal.app» con el binario ya compilado y lo comprime con la versión en el
# nombre (CONVENCIONES §11.5). Se corre en macOS (hace falta iconutil y sips).
#   desktop/scripts/macos-bundle.sh <target-dir> <arch>
set -eu
cd "$(dirname "$0")/.."
TARGET_DIR=$1
ARCH=$2
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
APP="dist/Dotrino Terminal.app"
rm -rf dist && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$TARGET_DIR/dotrino-terminal-desktop" "$APP/Contents/MacOS/"
ICONSET=dist/icon.iconset && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon-512.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d assets/icon-512.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Dotrino Terminal</string>
  <key>CFBundleDisplayName</key><string>Dotrino Terminal</string>
  <key>CFBundleIdentifier</key><string>com.dotrino.terminal</string>
  <key>CFBundleExecutable</key><string>dotrino-terminal-desktop</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
(cd dist && ditto -c -k --keepParent "Dotrino Terminal.app" "dotrino-terminal-desktop-$VERSION-macos-$ARCH.zip")
echo "dist/dotrino-terminal-desktop-$VERSION-macos-$ARCH.zip"
