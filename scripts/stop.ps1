# 停止后台运行的 workbuddy-proxy。
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'logs\proxy.pid'

$targets = @()
if (Test-Path $PidFile) {
  $targets += [int]((Get-Content $PidFile -Raw).Trim())
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
# 兜底：按命令行匹配（pid 文件丢失时）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*workbuddy-proxy*serve.ts*' } |
  ForEach-Object { $targets += [int]$_.ProcessId }

$targets = $targets | Sort-Object -Unique
foreach ($id in $targets) {
  try {
    Stop-Process -Id $id -Force -ErrorAction Stop
    Write-Host "已停止 PID $id"
  } catch { }
}

if ($targets.Count -eq 0) { Write-Host 'workbuddy-proxy 未在运行' }
