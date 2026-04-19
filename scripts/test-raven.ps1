$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$ravenRoot = Join-Path $root "services\\raven"

$env:SCRIPTARR_RAVEN_DATA_ROOT = Join-Path $ravenRoot "build\\test-downloads"
$env:SCRIPTARR_RAVEN_LOG_DIR = Join-Path $ravenRoot "build\\test-logs"

Push-Location $ravenRoot
try {
  & .\gradlew.bat --no-daemon check
} finally {
  Pop-Location
}
