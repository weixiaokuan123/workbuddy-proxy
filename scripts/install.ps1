# 一次性安装：补 BOM、启动代理、注入 opencode provider 配置、验证。
# 不写死任何用户路径，全部基于本脚本所在目录推导。
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "== workbuddy-proxy 安装（$Root）=="

# 1) Node 版本检查
try {
  $nodeVer = (& node --version).Trim()
  Write-Host "Node: $nodeVer"
} catch {
  Write-Host "未找到 node，请先安装 Node.js 22.19+ 或 24+" -ForegroundColor Red
  exit 1
}

# 2) 给 .ps1 补 BOM（Windows PowerShell 5.1 对中文友好）
if (Test-Path (Join-Path $Root 'add-bom.cjs')) {
  & node (Join-Path $Root 'add-bom.cjs') | Out-Null
}

# 3) 启动代理
& (Join-Path $PSScriptRoot 'start.ps1')

# 4) 注入 provider 配置
& node (Join-Path $PSScriptRoot 'inject-config.cjs')

# 5) 结束后提示
Write-Host ''
Write-Host "已安装。请重启 opencode 以加载新的 provider。" -ForegroundColor Green
Write-Host "提示：先在 WorkBuddy 桌面端登录，代理才能取到凭据。"
