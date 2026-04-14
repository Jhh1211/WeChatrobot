#Requires -Version 5.1
# UTF-8
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServerDir = Join-Path $RepoRoot "server"
$ComposeFile = Join-Path $RepoRoot "docker-compose.yml"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Exit-Fail {
  param([string]$Step)
  Write-Host ""
  Write-Host "FAILED at step: $Step" -ForegroundColor Red
  exit 1
}

function Test-Tool {
  param(
    [string]$Name,
    [string]$ExeName,
    [string[]]$VersionArgs
  )
  Write-Step "Check $Name"
  $cmd = Get-Command $ExeName -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Host "Not found in PATH: $ExeName" -ForegroundColor Red
    Exit-Fail "check $Name"
  }
  Write-Host "OK: $($cmd.Source)"
  & $ExeName @VersionArgs 2>&1 | ForEach-Object { Write-Host $_ }
  if (-not $?) {
    Exit-Fail "check $Name (command failed)"
  }
}

Write-Host "bootstrap-dev.ps1" -ForegroundColor Green
Write-Host "Repo: $RepoRoot"

Test-Tool -Name "Docker" -ExeName "docker" -VersionArgs @("--version")
Test-Tool -Name "Node" -ExeName "node" -VersionArgs @("-v")
Test-Tool -Name "npm" -ExeName "npm.cmd" -VersionArgs @("-v")
Test-Tool -Name "pnpm" -ExeName "pnpm.cmd" -VersionArgs @("-v")

Write-Step "server/.env"
$envExample = Join-Path $ServerDir ".env.example"
$envFile = Join-Path $ServerDir ".env"
if (-not (Test-Path $envFile)) {
  if (-not (Test-Path $envExample)) {
    Write-Host "Missing file: $envExample" -ForegroundColor Red
    Exit-Fail "copy .env"
  }
  Copy-Item -LiteralPath $envExample -Destination $envFile
  Write-Host "Copied: .env.example -> .env"
} else {
  Write-Host "server/.env exists, skip copy"
}

Write-Step "docker compose up -d postgres redis"
Push-Location -LiteralPath $RepoRoot
& docker compose -f $ComposeFile up -d postgres redis 2>&1 | ForEach-Object { Write-Host $_ }
if (-not $?) {
  Pop-Location
  Exit-Fail "docker compose up -d postgres redis"
}
Pop-Location
Write-Host "docker compose OK"

Write-Step "pnpm.cmd install (in server/)"
Push-Location -LiteralPath $ServerDir
& pnpm.cmd install 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Exit-Fail "pnpm.cmd install (exit code $LASTEXITCODE)"
}
Write-Host "pnpm install OK"

Write-Step "pnpm.cmd prisma generate"
& pnpm.cmd prisma generate 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Exit-Fail "pnpm.cmd prisma generate (exit code $LASTEXITCODE)"
}
Write-Host "prisma generate OK"

Write-Step "pnpm.cmd prisma migrate deploy"
& pnpm.cmd prisma migrate deploy 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Exit-Fail "pnpm.cmd prisma migrate deploy (exit code $LASTEXITCODE)"
}
Write-Host "prisma migrate deploy OK"

Write-Step "pnpm.cmd exec prisma db seed"
& pnpm.cmd exec prisma db seed 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Exit-Fail "pnpm.cmd exec prisma db seed (exit code $LASTEXITCODE)"
}
Write-Host "prisma db seed OK"

Write-Step "pnpm.cmd test"
& pnpm.cmd test 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  Exit-Fail "pnpm.cmd test (exit code $LASTEXITCODE)"
}
Write-Host "pnpm test OK"

Pop-Location

Write-Host ""
Write-Host "All steps completed successfully." -ForegroundColor Green
exit 0
