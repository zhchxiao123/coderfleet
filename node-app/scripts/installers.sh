#!/usr/bin/env bash
# Turns the packaged Apps under out/ (from `npm run package`) into installers
# under release/. Each platform's installer is built where its tool exists:
#   macOS    .dmg         hdiutil (macOS only)
#   Windows  Setup .exe   makensis (apt install nsis / brew install makensis)
#   Linux    .deb         dpkg-deb, plus a .tar.gz for other distributions
# Usage: scripts/installers.sh <label> [mac|windows|linux]...   (label goes into file names)
set -euo pipefail
cd "$(dirname "$0")/.."

label=${1:?usage: installers.sh <label> [mac|windows|linux]...}
shift
version=$(node -p "require('./package.json').version")
mkdir -p release

mac() {
  local arch app stage
  for arch in arm64 x64; do
    app=out/CoderFleet-darwin-$arch/CoderFleet.app
    [ -d "$app" ] || continue
    # No developer certificate: sign for this machine only, or the App does not start on Apple silicon.
    codesign --force --deep --sign - "$app"
    stage=$(mktemp -d)
    ditto "$app" "$stage/CoderFleet.app"
    ln -s /Applications "$stage/Applications"
    hdiutil create -quiet -volname CoderFleet -srcfolder "$stage" -ov -format UDZO "release/CoderFleet-$label-mac-$arch.dmg"
    rm -rf "$stage"
  done
}

windows() {
  local arch
  for arch in x64 arm64; do
    [ -d "out/CoderFleet-win32-$arch" ] || continue
    makensis -V2 -DVERSION="$version" -DSOURCE="$PWD/out/CoderFleet-win32-$arch" -DICON="$PWD/icons/coderfleet.ico" \
      -DOUTFILE="$PWD/release/CoderFleet-$label-windows-$arch-setup.exe" installer/windows.nsi
  done
}

linux() {
  local arch deb root
  for arch in x64 arm64; do
    [ -d "out/CoderFleet-linux-$arch" ] || continue
    tar -czf "release/CoderFleet-$label-linux-$arch.tar.gz" -C out "CoderFleet-linux-$arch"
    deb=amd64; [ "$arch" = arm64 ] && deb=arm64
    root=$(mktemp -d)
    mkdir -p "$root/DEBIAN" "$root/opt" "$root/usr/bin" "$root/usr/share/applications" "$root/usr/share/pixmaps"
    cp -a "out/CoderFleet-linux-$arch" "$root/opt/CoderFleet"
    # Chromium's sandbox helper must be setuid root where unprivileged user namespaces are off.
    chmod 4755 "$root/opt/CoderFleet/chrome-sandbox"
    ln -s /opt/CoderFleet/CoderFleet "$root/usr/bin/coderfleet"
    cp installer/coderfleet.desktop "$root/usr/share/applications/coderfleet.desktop"
    cp icons/coderfleet.png "$root/usr/share/pixmaps/coderfleet.png"
    sed -e "s/@VERSION@/$version/" -e "s/@ARCH@/$deb/" \
      -e "s/@SIZE@/$(du -sk "$root/opt" | cut -f1)/" installer/debian-control > "$root/DEBIAN/control"
    chmod 755 "$root"; chmod -R go-w "$root"
    dpkg-deb --root-owner-group -Zxz --build "$root" "release/CoderFleet-$label-linux-$deb.deb" >/dev/null
    rm -rf "$root"
  done
}

[ $# -gt 0 ] || set -- mac windows linux
for target in "$@"; do
  case "$target" in mac|windows|linux) "$target" ;; *) echo "unknown target: $target" >&2; exit 2 ;; esac
done
ls -lh release
