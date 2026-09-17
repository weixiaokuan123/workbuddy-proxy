# 查询 workbuddy-proxy 两个区域的运行状态（只读）。
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot

$regions = @(
  @{ name = 'cn';     port = 39301; keyFile = Join-Path $Root 'keys\cn.key' },
  @{ name = 'global'; port = 39302; keyFile = Join-Path $Root 'keys\global.key' }
)

foreach ($r in $regions) {
  Write-Host ("== {0}  http://127.0.0.1:{1} ==" -f $r.name, $r.port)
  if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port $r.port -WarningAction SilentlyContinue -InformationLevel Quiet)) {
    Write-Host "  端口未监听（服务未启动或该区域未就绪）`n"
    continue
  }
  if (-not (Test-Path $r.keyFile)) { Write-Host "  缺少 key 文件`n"; continue }
  $key = (Get-Content $r.keyFile -Raw).Trim()
  try {
    $st = Invoke-RestMethod -Uri "http://127.0.0.1:$($r.port)/status" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
    if ($st.auth.state -eq 'signed-in') {
      Write-Host ("  账号: {0}  domain: {1}  积分: {2}  模型数: {3}" -f `
        $st.auth.account, $st.auth.domain, $st.credits.total, $st.models)
    } else {
      $msg = $st.auth.message
      if (-not $msg) { $msg = 'signed-out' }
      Write-Host ("  未登录: {0}" -f $msg)
    }
  } catch {
    Write-Host "  查询失败: $($_.Exception.Message)"
  }
  Write-Host ''
}
