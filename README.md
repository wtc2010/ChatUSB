# ChatUSB

U盘便携聊天软件：桌面 Electron 便携版 + 手机安卓版（Capacitor）。

- **数据全在 U 盘**：聊天记录、图片、文件、头像都存放在 U 盘的 `data\` 目录，换电脑插上 U 盘即用，账号和数据随 U 盘走。
- **跨网聊天**：走公共/自建 MQTT 消息中转，不同网络也能聊。
- **端到端加密**：房间号+密码 AES 端到端加密，离线消息缓存补发。
- **自建服务器账号中心**：同一 QQ 邮箱/手机号在所有设备（U 盘）都是同一个账号（可选，需自建 `server/`）。
- **丰富功能**：日/夜间模式、自定义背景、截图、语音消息、语音转字幕、消息提醒/撤回/表情包/搜索/草稿/引用回复/@提醒/多选转发、好友系统、离线模式（免打扰缩到托盘）。

## 目录结构

```
├─ src/            客户端源码（Electron 主进程 + renderer 界面）
│  ├─ main.js
│  ├─ preload.js
│  └─ renderer/    界面代码（index.html / app.js / style.css / 截图组件）
├─ server/         自建中央服务器（MQTT over WebSocket + 账号中心）
└─ README.md
```

## 构建/运行

**客户端（Windows 便携版）**
```bash
cd src
npm install
# 用 electron-builder 打包 portable 单文件，或 electron . 直接运行
```

**服务器**
```bash
cd server
npm install
node server.js
# 客户端「设置→公共消息服务地址」填 ws://你的IP:3722/mqtt
```

## 账号中心

自建服务器启动后，在客户端「设置→账号服务器地址」填 `http://你的IP:3722`。之后所有设备用同一 QQ 邮箱/手机号注册/登录，就是同一个账号；服务器不可达时自动回退本地账号，不影响使用。

## 说明

- 客户端源码不含任何个人账号/聊天数据（数据只在 U 盘本地）。
- 手机版安装包 APK 在 `ChatUSB-Mobile/`，见其目录说明。
- 本项目仅供学习交流，请勿用于非法用途。