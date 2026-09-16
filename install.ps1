# eds-tui installer for Windows. See install.sh for Linux/macOS.
#
#   irm https://raw.githubusercontent.com/edantonio505/eds-tui-js/main/install.ps1 | iex
#
# The normal way to install eds-tui is:
#
#   npm install -g eds-tui@latest
#
# This script is the FALLBACK for when that can't work: no reachable npm
# registry (air-gapped, proxy, outage), or a box that needs a version newer
# than what's published. It is what miniclosedai-node's installer drops to
# when its `npm install -g eds-tui@latest` fails.
#
# It clones the repo with plain git (NOT npm's own git-dependency fetch),
# runs `npm pack` on that local checkout, and installs the resulting tarball.
# `npm install -g git+https://github.com/...` for THIS repo was confirmed
# unreliable, reporting success while leaving an incomplete install.
#
# Because this is the fallback path it BOOTSTRAPS Node and git via winget
# rather than bailing when they're missing — it runs precisely on the boxes
# where that toolchain is the broken thing.

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/edantonio505/eds-tui-js.git"

$NodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
    $NodeMajor = [int]((node -e "console.log(process.versions.node.split('.')[0])") 2>$null)
    if ($NodeMajor -ge 20) { $NodeOk = $true }
}
if (-not $NodeOk) {
    Write-Host "Installing Node.js (eds-tui needs >=20)..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
        # winget updates the machine PATH, not this process's cached copy.
        $env:Path = "$env:ProgramFiles\nodejs;$env:Path"
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error "Node.js >=20 is required and couldn't be installed automatically. Install it from https://nodejs.org, then re-run."
        exit 1
    }
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm isn't available even though node is. Reinstall Node.js: https://nodejs.org"
    exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Installing git (this fallback installer clones the repo)..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id Git.Git --silent --accept-source-agreements --accept-package-agreements
        $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path"
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Error "git is required by this fallback installer. Install git, or use the normal path: npm install -g eds-tui@latest"
        exit 1
    }
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("eds-tui-install-" + [System.Guid]::NewGuid())
try {
    Write-Host "Cloning eds-tui-js..."
    git clone --depth 1 -q $RepoUrl $Tmp
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }

    Write-Host "Packing..."
    Push-Location $Tmp
    $Tarball = (npm pack --silent 2>$null | Select-Object -Last 1)
    Pop-Location
    $TarballPath = Join-Path $Tmp $Tarball
    if (-not $Tarball -or -not (Test-Path $TarballPath)) {
        throw "npm pack did not produce a tarball"
    }

    Write-Host "Installing the ask CLI..."
    npm install -g $TarballPath
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Host ""
    Write-Host "Done -- run 'ask' from any shell."
} finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
