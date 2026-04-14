#Requires -Version 5.1
<#
.SYNOPSIS
  检查 API 健康后，在 server 目录按顺序用 tsx 跑 manual 脚本（Executor 冒烟）。

.DESCRIPTION
  需已启动 server。环境变量：SMOKE_BASE_URL、EXECUTOR_SHARED_TOKEN、ADMIN_TOKEN、
  DEFAULT_ROBOT_ID、SMOKE_DEVICE_ID（未设则 MANUAL_DEVICE_ID 默认为 smoke-device-01）。

  Base URL：优先 SMOKE_BASE_URL，否则 http://127.0.0.1:3000。
#>

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServerDir = Join-Path $RepoRoot "server"

# ----- 解析 Base URL 并注入 manual 脚本使用的变量 -----
$baseUrl = "http://127.0.0.1:3000"
if ($env:SMOKE_BASE_URL -and $env:SMOKE_BASE_URL.Trim().Length -gt 0) {
  $baseUrl = $env:SMOKE_BASE_URL.Trim().TrimEnd("/")
}
else {
  $baseUrl = $baseUrl.TrimEnd("/")
}
$env:MANUAL_API_BASE_URL = $baseUrl

# ----- SMOKE_DEVICE_ID -> MANUAL_DEVICE_ID（manual/config 读后者）-----
$deviceDefault = "smoke-device-01"
if ($env:SMOKE_DEVICE_ID -and $env:SMOKE_DEVICE_ID.Trim().Length -gt 0) {
  $env:MANUAL_DEVICE_ID = $env:SMOKE_DEVICE_ID.Trim()
}
else {
  if (-not $env:MANUAL_DEVICE_ID -or $env:MANUAL_DEVICE_ID.Trim().Length -eq 0) {
    $env:MANUAL_DEVICE_ID = $deviceDefault
  }
}

Write-Host ""
Write-Host "[smoke-executor] MANUAL_API_BASE_URL=$($env:MANUAL_API_BASE_URL)" -ForegroundColor Gray
Write-Host "[smoke-executor] MANUAL_DEVICE_ID=$($env:MANUAL_DEVICE_ID)" -ForegroundColor Gray
if ($env:DEFAULT_ROBOT_ID) {
  Write-Host "[smoke-executor] DEFAULT_ROBOT_ID=$($env:DEFAULT_ROBOT_ID)" -ForegroundColor Gray
}
if ($env:EXECUTOR_SHARED_TOKEN) {
  Write-Host "[smoke-executor] EXECUTOR_SHARED_TOKEN=(已设置)" -ForegroundColor Gray
}
else {
  Write-Host "[smoke-executor] 警告: EXECUTOR_SHARED_TOKEN 未设置，manual 脚本可能失败" -ForegroundColor Yellow
}
if ($env:ADMIN_TOKEN) {
  Write-Host "[smoke-executor] ADMIN_TOKEN=(已设置)" -ForegroundColor Gray
}
else {
  Write-Host "[smoke-executor] 警告: ADMIN_TOKEN 未设置，create-test-send-task 可能失败" -ForegroundColor Yellow
}

# ----- A. 健康检查 GET /api/health -----
Write-Host ""
Write-Host "=== 检查 API 健康 ===" -ForegroundColor Cyan
$healthUri = "$baseUrl/api/health"
Write-Host ">> GET $healthUri" -ForegroundColor DarkGray
try {
  $healthResp = Invoke-WebRequest -Uri $healthUri -UseBasicParsing -TimeoutSec 5 -Method Get
  if ($healthResp.StatusCode -ne 200) {
    Write-Host "[失败] 步骤: 健康检查 (HTTP $($healthResp.StatusCode))" -ForegroundColor Red
    exit 1
  }
  Write-Host "[成功] 健康检查 HTTP 200" -ForegroundColor Green
}
catch {
  Write-Host "[失败] 步骤: 健康检查 — 无法连接 $baseUrl" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}

# ----- B. 在 server 目录顺序执行 manual 脚本 -----
Write-Host ""
Write-Host "=== 在 server 目录顺序执行 manual 脚本 ===" -ForegroundColor Cyan
Push-Location $ServerDir

$taskId = $null

# 1) register-device.ts
Write-Host ""
Write-Host "=== [1/7] register-device.ts ===" -ForegroundColor Cyan
Write-Host ">> pnpm.cmd exec tsx scripts/manual/register-device.ts" -ForegroundColor DarkGray
$out1 = & pnpm.cmd exec tsx "scripts/manual/register-device.ts" 2>&1 | ForEach-Object { $_.ToString() }
$out1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "[失败] 步骤: register-device.ts (退出码 $LASTEXITCODE)" -ForegroundColor Red
  Pop-Location
  exit 1
}

# 2) send-heartbeat.ts
Write-Host ""
Write-Host "=== [2/7] send-heartbeat.ts ===" -ForegroundColor Cyan
Write-Host ">> pnpm.cmd exec tsx scripts/manual/send-heartbeat.ts" -ForegroundColor DarkGray
$out2 = & pnpm.cmd exec tsx "scripts/manual/send-heartbeat.ts" 2>&1 | ForEach-Object { $_.ToString() }
$out2 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "[失败] 步骤: send-heartbeat.ts (退出码 $LASTEXITCODE)" -ForegroundColor Red
  Pop-Location
  exit 1
}

# 3) mock-inbound-event.ts
Write-Host ""
Write-Host "=== [3/7] mock-inbound-event.ts ===" -ForegroundColor Cyan
Write-Host ">> pnpm.cmd exec tsx scripts/manual/mock-inbound-event.ts" -ForegroundColor DarkGray
$out3 = & pnpm.cmd exec tsx "scripts/manual/mock-inbound-event.ts" 2>&1 | ForEach-Object { $_.ToString() }
$out3 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "[失败] 步骤: mock-inbound-event.ts (退出码 $LASTEXITCODE)" -ForegroundColor Red
  Pop-Location
  exit 1
}

# 4) create-test-send-task.ts
Write-Host ""
Write-Host "=== [4/7] create-test-send-task.ts ===" -ForegroundColor Cyan
Write-Host ">> pnpm.cmd exec tsx scripts/manual/create-test-send-task.ts" -ForegroundColor DarkGray
$out4 = & pnpm.cmd exec tsx "scripts/manual/create-test-send-task.ts" 2>&1 | ForEach-Object { $_.ToString() }
$out4 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "[失败] 步骤: create-test-send-task.ts (退出码 $LASTEXITCODE)" -ForegroundColor Red
  Pop-Location
  exit 1
}

# 5) pull-task.ts — 解析 SMOKE_TASK_ID=
Write-Host ""
Write-Host "=== [5/7] pull-task.ts ===" -ForegroundColor Cyan
Write-Host ">> pnpm.cmd exec tsx scripts/manual/pull-task.ts" -ForegroundColor DarkGray
$out5 = & pnpm.cmd exec tsx "scripts/manual/pull-task.ts" 2>&1 | ForEach-Object { $_.ToString() }
$out5 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "[失败] 步骤: pull-task.ts (退出码 $LASTEXITCODE)" -ForegroundColor Red
  Pop-Location
  exit 1
}

foreach ($line in $out5) {
  if ($line -match '^\s*SMOKE_TASK_ID=(.+)$') {
    $taskId = $Matches[1].Trim()
    break
  }
}

if (-not $taskId -or $taskId.Length -eq 0) {
  Write-Host "[失败] 步骤: pull-task.ts — 输出中未找到 SMOKE_TASK_ID=<id>" -ForegroundColor Red
  Pop-Location
  exit 1
}

Write-Host "[信息] 已解析任务 ID: $taskId" -ForegroundColor Green
$env:MANUAL_TASK_ID = $taskId

# 6) ack-task.ts
Write-Host ""
Write-Host "=== [6/7] ack-task.ts (MANUAL_TASK_ID=$taskId) ===" -ForegroundColor Cyan
Write-Host ">> pnpm.cmd exec tsx scripts/manual/ack-task.ts" -ForegroundColor DarkGray
$out6 = & pnpm.cmd exec tsx "scripts/manual/ack-task.ts" 2>&1 | ForEach-Object { $_.ToString() }
$out6 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "[失败] 步骤: ack-task.ts (退出码 $LASTEXITCODE)" -ForegroundColor Red
  Remove-Item Env:MANUAL_TASK_ID -ErrorAction SilentlyContinue
  Pop-Location
  exit 1
}

# 7) report-task-result.ts
$env:MANUAL_RESULT_STATUS = "success"
Write-Host ""
Write-Host "=== [7/7] report-task-result.ts (MANUAL_RESULT_STATUS=success) ===" -ForegroundColor Cyan
Write-Host ">> pnpm.cmd exec tsx scripts/manual/report-task-result.ts" -ForegroundColor DarkGray
$out7 = & pnpm.cmd exec tsx "scripts/manual/report-task-result.ts" 2>&1 | ForEach-Object { $_.ToString() }
$out7 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "[失败] 步骤: report-task-result.ts (退出码 $LASTEXITCODE)" -ForegroundColor Red
  Remove-Item Env:MANUAL_TASK_ID -ErrorAction SilentlyContinue
  Remove-Item Env:MANUAL_RESULT_STATUS -ErrorAction SilentlyContinue
  Pop-Location
  exit 1
}

Remove-Item Env:MANUAL_TASK_ID -ErrorAction SilentlyContinue
Remove-Item Env:MANUAL_RESULT_STATUS -ErrorAction SilentlyContinue

Pop-Location

Write-Host ""
Write-Host "[smoke-executor] 全流程完成。" -ForegroundColor Green
exit 0
