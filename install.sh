#!/usr/bin/env bash
# eds-tui installer — Linux/macOS. See install.ps1 for Windows.
#
#   curl -fsSL https://raw.githubusercontent.com/edantonio505/eds-tui-js/main/install.sh | bash
#
# The normal way to install eds-tui is:
#
#   npm install -g eds-tui@latest
#
# This script is the FALLBACK for when that can't work: no reachable npm
# registry (air-gapped, proxy, outage), or a box that needs a version newer
# than what's published. It is what miniclosedai's and miniclosedai-node's
# installers drop to when their `npm install -g eds-tui@latest` fails.
#
# It installs by a plain `git clone` (NOT npm's own git-dependency fetch),
# then `npm pack` on the local checkout — which just tars up local files, no
# network or git resolution involved — then `npm install -g` that tarball.
# That indirection is deliberate: `npm install -g git+https://github.com/...`
# for THIS repo was confirmed unreliable in real testing, reporting success
# while silently producing an incomplete install (no dist/, sometimes an
# empty package directory), with no visible error. dist/ is committed to git
# specifically so a clone always has real code to pack.
#
# Because this is the fallback path, it BOOTSTRAPS Node rather than bailing
# when it's missing: it runs precisely on the boxes where the Node/npm
# toolchain is the thing that's broken, so refusing to run without Node would
# make it useless exactly when it's needed. Safe to re-run — always clones
# fresh.

set -euo pipefail

REPO_URL="https://github.com/edantonio505/eds-tui-js.git"
OS="$(uname -s)"
SUDO=""
[ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# Install/upgrade Node to >=20 when this box has none or one too old. apt's
# own `nodejs` package is years out of date on LTS releases (Ubuntu 22.04
# ships Node 12), hence NodeSource rather than a plain apt-get install.
ensure_node() {
  local major=0
  command -v node >/dev/null 2>&1 && \
    major="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 20 ] 2>/dev/null && return 0

  echo "Installing Node.js (eds-tui needs >=20; this box has ${major:-none})..."
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 \
      && $SUDO apt-get install -y -qq nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 \
      && $SUDO dnf install -y -q nodejs
  elif command -v apk >/dev/null 2>&1; then
    $SUDO apk add --quiet nodejs npm
  fi

  command -v node >/dev/null 2>&1 || return 1
  major="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 20 ] 2>/dev/null
}

if ! ensure_node; then
  echo "Node.js >=20 is required and couldn't be installed automatically." >&2
  echo "Install it from https://nodejs.org, then re-run this script." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm isn't available even though node is. Reinstall Node.js: https://nodejs.org" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required by this fallback installer (it clones the repo)." >&2
  echo "Install git, or use the normal path instead: npm install -g eds-tui@latest" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Cloning eds-tui-js..."
git clone --depth 1 -q "$REPO_URL" "$TMP"

echo "Packing..."
TARBALL="$(cd "$TMP" && npm pack --silent 2>/dev/null | tail -1)"
if [ -z "$TARBALL" ] || [ ! -f "$TMP/$TARBALL" ]; then
  echo "npm pack did not produce a tarball — aborting." >&2
  exit 1
fi

echo "Installing the ask CLI..."
# Unprivileged first, on purpose: brew/nvm/npm-prefix installs are
# user-writable and must not have root-owned files written into them. Only a
# root-owned global prefix (a NodeSource/apt Node puts it under /usr) needs
# the retry, and that failure mode is EACCES.
if ! npm install -g "$TMP/$TARBALL"; then
  if [ -n "$SUDO" ]; then
    echo "Retrying with sudo (global npm prefix looks root-owned)..."
    $SUDO npm install -g "$TMP/$TARBALL"
  else
    exit 1
  fi
fi

echo
echo "Done — run 'ask' from any shell."
