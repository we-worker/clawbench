#!/usr/bin/env bash
# ClawBench — one-line installer
# Usage: curl -fsSL https://github.com/xulongzhe/clawbench/releases/latest/download/install.sh | bash
set -e

REPO="xulongzhe/clawbench"
BINARY="clawbench"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

# --- Detect OS & Arch ---
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$OS" in
  Linux*)
    PLATFORM="linux-amd64"
    EXT=".zip"
    ;;
  Darwin*)
    case "$ARCH" in
      arm64|aarch64) PLATFORM="darwin-arm64" ;;
      *)            PLATFORM="darwin-amd64" ;;
    esac
    EXT=".zip"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    # Running under Git Bash / MSYS2 on Windows
    PLATFORM="windows-amd64"
    EXT=".zip"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# --- Get latest release tag ---
echo "Detecting latest release..."
LATEST="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
if [ -z "$LATEST" ]; then
  echo "Failed to detect latest version" >&2
  exit 1
fi
echo "Latest version: ${LATEST}"

# --- Download ---
ASSET_NAME="${BINARY}-${PLATFORM}${EXT}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${ASSET_NAME}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading ${ASSET_NAME}..."
curl -fsSL -o "${TMPDIR}/${ASSET_NAME}" "${DOWNLOAD_URL}"

# --- Extract ---
echo "Extracting..."
cd "$TMPDIR"
if command -v unzip >/dev/null 2>&1; then
  unzip -o -q "${ASSET_NAME}"
else
  # Fallback: try python
  python3 -c "import zipfile; zipfile.ZipFile('${ASSET_NAME}').extractall('.')"
fi

# --- Install ---
mkdir -p "$INSTALL_DIR"
if [ "$PLATFORM" = "windows-amd64" ]; then
  # On Windows (Git Bash), just copy the .exe
  cp -f clawbench.exe "${INSTALL_DIR}/clawbench.exe" 2>/dev/null || cp -f clawbench "${INSTALL_DIR}/clawbench.exe"
  BINARY_PATH="${INSTALL_DIR}/clawbench.exe"
else
  cp -f "$BINARY" "${INSTALL_DIR}/$BINARY"
  chmod +x "${INSTALL_DIR}/$BINARY"
  BINARY_PATH="${INSTALL_DIR}/$BINARY"
fi

# --- PATH hint ---
echo ""
echo "Installed: ${BINARY_PATH}"

if ! echo ":$PATH:" | grep -q ":${INSTALL_DIR}:"; then
  echo ""
  echo "Add to PATH:"
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
  fi
  if [ -n "$SHELL_RC" ]; then
    echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ${SHELL_RC}"
    echo "  source ${SHELL_RC}"
  else
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
fi

echo ""
echo "Run: ${BINARY_PATH}"
