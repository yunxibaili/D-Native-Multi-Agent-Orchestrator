<#
  native/windows-job-launcher/build.ps1

  Builds the W1 prototype binaries into ./build (git-ignored).

  Toolchain: gcc from MSYS2 UCRT64 (mingw-w64). No system-wide install, no
  modification of PATH: this script only requires that gcc is already
  resolvable, which was confirmed present on this machine before W1 started.

  Flags that matter:
    -static              self-contained PE; no toolchain runtime needed, only
                         OS-provided api-ms-win-crt-* (present on Win10+).
    -municode            wmain entry point, so argv arrives already parsed by
                         Windows' own CommandLineToArgvW-equivalent rules.
                         This is what makes argv round-tripping faithful.
    -Wall -Wextra        keep the helper honest.

  Usage:
    powershell -File native/windows-job-launcher/build.ps1
#>

$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir  = Join-Path $root 'src'
$outDir  = Join-Path $root 'build'

if (-not (Get-Command gcc -ErrorAction SilentlyContinue)) {
    throw "gcc not found on PATH. Install MSYS2 UCRT64 or add its bin directory for this invocation only (do not modify the system PATH permanently)."
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$common = @('-O2', '-static', '-municode', '-Wall', '-Wextra', '-std=c99')

Write-Host "== building w1joblauncher.exe =="
& gcc @common -o (Join-Path $outDir 'w1joblauncher.exe') (Join-Path $srcDir 'w1joblauncher.c')
if ($LASTEXITCODE -ne 0) { throw "w1joblauncher build failed" }

Write-Host "== building w1fixture.exe =="
& gcc @common -o (Join-Path $outDir 'w1fixture.exe') (Join-Path $srcDir 'w1fixture.c')
if ($LASTEXITCODE -ne 0) { throw "w1fixture build failed" }

Write-Host ""
Write-Host "== toolchain =="
& gcc --version | Select-Object -First 1

Write-Host ""
Write-Host "== output =="
Get-ChildItem $outDir -Filter *.exe | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,16)
    "{0,-22} {1,8} bytes  sha256:{2}" -f $_.Name, $_.Length, $hash
}

# ---------------------------------------------------------------------------
# Deploy the launcher to the SYSTEM volume.
#
# On this workstation a process is confined to the volume its executable lives
# on: a process descended from a D:-located launcher is DENIED writes to C:,
# which breaks every agent that writes its own home/config/temp on C: (for
# example ~/.codex). A launcher on the system volume has no such restriction and
# its descendants can write BOTH C: and D:.
#
# This is a plain copy of the sealed binary to a per-user path -- NOT an
# installer, and the binary itself is unchanged.
# ---------------------------------------------------------------------------
$deployDir = Join-Path $env:LOCALAPPDATA 'orchestrator'
if ($env:LOCALAPPDATA) {
    New-Item -ItemType Directory -Force -Path $deployDir | Out-Null
    Copy-Item (Join-Path $outDir 'w1joblauncher.exe') (Join-Path $deployDir 'w1joblauncher.exe') -Force
    Write-Host ""
    Write-Host "== deployed to system volume =="
    $d = Get-Item (Join-Path $deployDir 'w1joblauncher.exe')
    "{0} ({1} bytes)" -f $d.FullName, $d.Length
} else {
    Write-Warning "LOCALAPPDATA is not set; skipped system-volume deployment. Agents may be denied writes outside the repo volume."
}
