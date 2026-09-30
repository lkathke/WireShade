#!/bin/sh
# WireShade CLI installer for macOS / Linux — no Node/npm required.
#
#   curl -fsSL https://raw.githubusercontent.com/lkathke/WireShade/master/install.sh | sh
#
# Downloads the standalone `wireshade` executable (Node embedded) into
# ~/.local/bin (override with WIRESHADE_INSTALL_DIR).
set -eu

REPO="lkathke/WireShade"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
    Linux)  o="linux" ;;
    Darwin) o="macos" ;;
    *) echo "wireshade: unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
    x86_64|amd64)   a="x64" ;;
    aarch64|arm64)  a="arm64" ;;
    armv7l|armv7)   a="armv7" ;;
    *) echo "wireshade: unsupported architecture: $arch" >&2; exit 1 ;;
esac

# macOS ships only x64 / arm64 builds.
if [ "$o" = "macos" ] && [ "$a" = "armv7" ]; then
    echo "wireshade: no macOS armv7 build" >&2; exit 1
fi

asset="wireshade-${o}-${a}"
if [ -n "${WIRESHADE_VERSION:-}" ]; then
    url="https://github.com/${REPO}/releases/download/${WIRESHADE_VERSION}/${asset}"
else
    url="https://github.com/${REPO}/releases/latest/download/${asset}"
fi

dir="${WIRESHADE_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
target="$dir/wireshade"

echo "Downloading $asset ..."
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target"
elif command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url"
else
    echo "wireshade: need curl or wget" >&2; exit 1
fi
chmod +x "$target"

echo ""
echo "Installed wireshade to $target"
case ":$PATH:" in
    *":$dir:"*) echo "Run:  wireshade help" ;;
    *) echo "Add $dir to your PATH, e.g.:"
       echo "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile && . ~/.profile"
       echo "Then run:  wireshade help" ;;
esac
