# ChatUSB 自建服务器一键启动（消息中转 + 账号中心）
# 用法：双击运行，或 在 ChatUSB 客户端「设置→公共消息服务地址」填 ws://本机IP:3722/mqtt
# 停止：关掉这个窗口 / 任务管理器结束 node.exe
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $dir
Write-Host "正在启动 ChatUSB 服务器（账号中心 + 消息中转）..." -ForegroundColor Cyan
node server.js
