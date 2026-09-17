# 静默启动 workbuddy-proxy（无窗口），供开机自启任务计划调用。
Set-Location -Path (Split-Path -Parent $PSScriptRoot)
& (Join-Path $PSScriptRoot 'start.ps1') | Out-Null
