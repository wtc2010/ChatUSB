'use strict';
/* ================= ChatUSB 自建中央服务器（MQTT over WebSocket） =================
 * 用途：替代默认的公共消息中转（emqx/hivemq），让聊天走你自己的服务器。
 * 运行：先 `npm install`，再 `node server.js`
 * 客户端连接：打开 ChatUSB → 设置 → 公共消息服务地址 填
 *   局域网/内网：  ws://你的IP:3722/mqtt
 *   公网（需域名+证书，见 README）：wss://你的域名:3723/mqtt
 * 可配环境变量：PORT(默认3722)、WSS_PORT(默认3723)、TLS_CERT、TLS_KEY
 */
const aedes = require('aedes')();
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const { Duplex } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ---------------- 账号中心（全局唯一账号） ----------------
 * 所有设备的注册/登录都走这里 → 同一 QQ 邮箱/手机号在所有 U 盘都是同一个账号。
 * 账号只存 加盐密码哈希，不存明文密码。
 */
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
function loadAccounts() { try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (_) { return {}; } }
function saveAccounts(a) { try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2)); } catch (_) {} }
function validAccount(a) {
  const s = String(a || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /^1[3-9]\d{9}$/.test(s);
}
function hashPwd(pwd, account, salt) {
  return crypto.scryptSync(String(pwd), 'chatusb:acct:' + account + ':' + salt, 64).toString('hex');
}

const WS_PATH = '/mqtt';
const HTTP_PORT = Number(process.env.PORT) || 3722;
const WSS_PORT = Number(process.env.WSS_PORT) || 3723;
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';

// 把 WebSocket 连接转成 aedes 可处理的流，接上 MQTT 协议
function attach(ws) {
  const stream = new Duplex({
    read() {},
    write(chunk, enc, cb) { try { if (ws.readyState === 1) ws.send(chunk, { binary: true }); } catch {} cb(); }
  });
  ws.on('message', (data) => { if (!stream.destroyed) stream.push(data); });
  ws.on('close', () => stream.destroy());
  ws.on('error', () => stream.destroy());
  aedes.handle(stream);
}

function lanIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const k of Object.keys(nets)) for (const n of nets[k] || []) {
    if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

// 明文 ws 服务（内网/局域网） + 账号 API
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url.startsWith('/api/account')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (_) {}
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const acc = loadAccounts();
      const a = String(p.account || '').trim();
      if (url.endsWith('/register')) {
        if (!validAccount(a)) { res.end(JSON.stringify({ ok: false, err: '请输入有效的 QQ 邮箱或 11 位手机号' })); return; }
        if (!p.password || String(p.password).length < 6) { res.end(JSON.stringify({ ok: false, err: '密码至少 6 位' })); return; }
        if (acc[a]) { res.end(JSON.stringify({ ok: false, err: '该账号已注册，请直接登录', exists: true })); return; }
        const salt = crypto.randomBytes(16).toString('hex');
        acc[a] = { salt, hash: hashPwd(p.password, a, salt), createdAt: Date.now() };
        saveAccounts(acc);
        res.end(JSON.stringify({ ok: true, account: a }));
        return;
      }
      if (url.endsWith('/login')) {
        if (!acc[a]) { res.end(JSON.stringify({ ok: false, err: '账号不存在' })); return; }
        const h = crypto.scryptSync(String(p.password || ''), 'chatusb:acct:' + a + ':' + acc[a].salt, 64);
        const ok = h.equals(Buffer.from(acc[a].hash, 'hex'));
        res.end(JSON.stringify(ok ? { ok: true, account: a } : { ok: false, err: '密码错误' }));
        return;
      }
      if (url.endsWith('/check')) {
        res.end(JSON.stringify({ ok: true, exists: !!acc[a], account: a }));
        return;
      }
      res.end(JSON.stringify({ ok: false, err: '未知接口' }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ChatUSB Server OK\n');
});
const wss = new WebSocketServer({ server, path: WS_PATH });
wss.on('connection', attach);

// 加密 wss 服务（公网，需提供证书）
let wssTls = null;
if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  const sTls = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) });
  wssTls = new WebSocketServer({ server: sTls, path: WS_PATH });
  wssTls.on('connection', attach);
  sTls.listen(WSS_PORT, () => console.log('[ChatUSB] 加密服务已启动：wss://你的域名:' + WSS_PORT + WS_PATH));
}

server.listen(HTTP_PORT, () => {
  console.log('[ChatUSB] 自建中央服务器已启动');
  console.log('[ChatUSB] 局域网地址：ws://' + lanIPs().join(' / ws://') + ':' + HTTP_PORT + WS_PATH);
  console.log('[ChatUSB] 本机地址：  ws://127.0.0.1:' + HTTP_PORT + WS_PATH);
  console.log('[ChatUSB] 在 ChatUSB「设置 → 公共消息服务地址」填入上述地址即可连接本服务器');
});

aedes.on('clientError', (client, err) => console.error('[ChatUSB] 客户端错误：' + err.message));
aedes.on('publish', (packet, client) => { /* 可在此做消息审计/日志 */ });
process.on('uncaughtException', (e) => console.error('[ChatUSB] 异常：' + e.message));
