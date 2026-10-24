/* ChatUSB 主进程
 * 职责：便携数据存储、跨网络聊天（MQTT 公共中转 / 局域网直连）、
 *       全局截图、语音/文件收发、权限管理
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut, dialog, Notification, shell, Menu, nativeTheme, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const mqtt = require('mqtt');
const { WebSocketServer, WebSocket } = require('ws');

/* ---------------- 便携数据目录（关键：所有数据跟随程序，放在 U 盘） ---------------- */
function resolvePortableBase() {
  if (process.env.CHATUSB_DATA_DIR) return process.env.CHATUSB_DATA_DIR;            // 测试/开发覆盖
  // 单文件便携版：程序运行时解压到临时目录，exe 真正所在目录由这个变量给出（就是 U 盘上的位置）
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged) return path.dirname(app.getPath('exe'));                      // 正式版：exe 所在目录
  return __dirname;                                                                 // 开发模式
}
const PORTABLE_BASE = resolvePortableBase();
const DATA_DIR = path.join(PORTABLE_BASE, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const VOICE_DIR = path.join(DATA_DIR, 'voice');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const PENDING_DIR = path.join(DATA_DIR, 'pending');   // 离线消息缓存（对方离线时暂存，上线后补发）
const BACKGROUNDS_DIR = path.join(DATA_DIR, 'backgrounds'); // 背景图文件夹（用户放图，软件随机当背景）
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');          // 上传的头像图片
const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json');   // 本地账户（QQ邮箱/手机号 + 密码哈希）
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');   // 好友列表
const NOTICES_FILE = path.join(DATA_DIR, 'notices.json');   // 好友申请通知
const MODEL_DIR = path.join(DATA_DIR, 'models');            // 语音识别模型（首次联网下载，之后离线）

/* 本地语音转字幕：Whisper 小模型（离线、免费）。首次使用时联网下载模型到 U 盘 data/models */
let transcriberPromise = null;
async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const mod = await import('@xenova/transformers');
      const { pipeline, env } = mod;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.remoteHost = 'https://hf-mirror.com';
      env.cacheDir = MODEL_DIR;
      env.backends = { onnx: { wasm: { numThreads: 1 } } };
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
    })().catch(e => { transcriberPromise = null; throw e; });
  }
  return transcriberPromise;
}
async function transcribeAudio(pcm, sampleRate) {
  try {
    const tr = await getTranscriber();
    const arr = new Float32Array(pcm);
    const out = await tr(arr, { language: 'zh', task: 'transcribe' });
    return (out && out.text) ? String(out.text).trim() : '';
  } catch { return ''; }
}

const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',   // EMQX 公共代理（国内可连）
  'wss://broker.hivemq.com:8884/mqtt' // HiveMQ 公共代理（备用）
];
const WAN_FILE_LIMIT = 700 * 1024;    // 公共模式单条文件上限（约 700KB，留协议余量）
const LAN_PORT = 3721;
const TEST_MODE = !!process.env.CHATUSB_TEST;

/* 目录与基础工具（必须先建目录，再写任何文件） */
function ensureDirs() {
  for (const d of [DATA_DIR, FILES_DIR, VOICE_DIR, HISTORY_DIR, PENDING_DIR, BACKGROUNDS_DIR, AVATAR_DIR]) fs.mkdirSync(d, { recursive: true });
  migrateHistoryLayout();   // 旧的单文件历史迁移到「每个房间一个文件夹」
}
function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
ensureDirs();
function newId() { return crypto.randomBytes(8).toString('hex'); }
function uid() { return 'u_' + crypto.randomBytes(5).toString('hex'); }
function relPath(p) { return path.relative(DATA_DIR, p).split(path.sep).join('/'); }
function absPath(r) { return path.isAbsolute(r) ? r : path.join(DATA_DIR, r); }
function now() { return Date.now(); }

/* 房间加密：房间密码 -> AES-256-GCM 密钥（同一房间同一密码才能互读） */
function roomKey(roomId, password) {
  return crypto.scryptSync(String(password || ''), 'chatusb:' + roomId, 32);
}
function encryptPayload(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { v: 2, e: true, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), d: enc.toString('base64') };
}
function decryptPayload(key, wire) {
  if (!wire || !wire.e) return wire.d ? JSON.parse(Buffer.from(wire.d, 'base64').toString('utf8')) : wire;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wire.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(wire.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(wire.d, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  } catch { return null; } // 密码错误/被篡改
}

/* ---------------- 全局状态 ---------------- */
let mainWin = null;
let shotWin = null;
let profile = loadProfile();
let roomList = loadRooms();
let friendList = loadFriends();
let notices = readJson(NOTICES_FILE, []);
let currentRoomId = profile.lastRoom || null;
let net = null;
let historyCache = {}; // roomId -> [msg,...]（内存中最近的消息，含未写盘的）
let seenIds = new Set(); // 已见过的消息 id（用于去重，避免离线补发造成重复）
let dnd = false;        // 离线模式（静音免打扰）：照常接收消息，但不响铃、不弹系统通知
let tray = null;        // 系统托盘
let quitting = false;   // 真正退出（托盘“退出”触发），用于区分“关闭=缩到托盘”

function loadProfile() {
  const p = readJson(PROFILE_FILE, {});
  if (!p.uid) p.uid = uid();
  if (!p.nickname) p.nickname = '用户' + p.uid.slice(-4);
  if (!p.avatarColor) p.avatarColor = '#3370ff';
  if (!p.avatarEmoji) p.avatarEmoji = '🐤';
  if (!p.theme) p.theme = 'light';
  if (!p.brokers || !p.brokers.length) p.brokers = DEFAULT_BROKERS;
  if (p.dndOnMinimize === undefined) p.dndOnMinimize = true;   // 默认：最小化/关闭进入离线模式
  if (p.accountServer === undefined) p.accountServer = '';     // 账号服务器地址（为空=纯本地账号）
  writeJson(PROFILE_FILE, p);
  return p;
}
function saveProfile(p) { profile = p; writeJson(PROFILE_FILE, p); }

/* ---------------- 本地账户（登录锁） ---------------- */
let account = readJson(ACCOUNT_FILE, null);
function validAccount(acc) {
  const a = String(acc || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) || /^1[3-9]\d{9}$/.test(a);
}
/* 账号服务器地址（设置里可填，如 http://192.168.1.10:3722，或 ws://... 自动转 http） */
function accountServerBase() {
  const s = String(profile.accountServer || '').trim();
  if (!s) return null;
  return s.replace(/^wss?:\/\//, 'http://').replace(/\/+$/, '');
}
/* 调用服务器账号 API；返回 {ok,err,exists,account} 或 null(服务器不可达/未配置) */
function callAccountApi(action, acc, pwd) {
  return new Promise((resolve) => {
    const base = accountServerBase();
    if (!base) return resolve(null);
    const url = base + '/api/account/' + action;
    const body = JSON.stringify({ account: acc, password: pwd });
    const payload = Buffer.from(body, 'utf8');
    const isHttps = /^https:\/\//i.test(url);
    const lib = isHttps ? https : http;
    let req;
    try {
      req = lib.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        timeout: 3000
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
      });
    } catch (_) { return resolve(null); }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}
function cacheAccount(a, pwd, serverFlag) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pwd), 'chatusb:acct:' + a + ':' + salt, 64).toString('hex');
  account = { account: a, salt, hash, createdAt: now(), server: !!serverFlag };
  writeJson(ACCOUNT_FILE, account);
}
async function registerAccount(acc, pwd) {
  const a = String(acc || '').trim();
  if (!validAccount(a)) return { ok: false, err: '请输入有效的 QQ 邮箱或 11 位手机号' };
  if (!pwd || String(pwd).length < 6) return { ok: false, err: '密码至少 6 位' };
  if (accountServerBase()) {
    const srv = await callAccountApi('register', a, pwd);
    if (srv) {
      if (srv.ok) { cacheAccount(a, pwd, true); return { ok: true, account: a, server: true }; }
      return srv;   // 已注册/格式错，交给前端提示（err 含"该账号已注册，请直接登录"）
    }
    // 服务器不可达 → 回退本地注册
  }
  cacheAccount(a, pwd, false);
  return { ok: true, account: a };
}
async function verifyAccount(acc, pwd) {
  const a = String(acc || '').trim();
  if (accountServerBase()) {
    const srv = await callAccountApi('login', a, pwd);
    if (srv) {
      if (srv.ok) { cacheAccount(a, pwd, true); return { ok: true, account: a, server: true }; }
      return srv;   // 账号不存在 / 密码错误
    }
    // 服务器不可达 → 回退本地验证
  }
  if (!account || account.account !== a) return { ok: false, err: '账号不存在' };
  const h = crypto.scryptSync(String(pwd), 'chatusb:acct:' + a + ':' + account.salt, 64);
  return h.equals(Buffer.from(account.hash, 'hex')) ? { ok: true, account: a } : { ok: false, err: '密码错误' };
}
function resetAccount() { try { fs.unlinkSync(ACCOUNT_FILE); } catch {} account = null; return { ok: true }; }
async function changePassword(oldPwd, newPwd) {
  if (!account) return { ok: false, err: '尚未设置账号' };
  const okOld = await verifyAccount(account.account, oldPwd);
  if (!okOld.ok) return { ok: false, err: okOld.err || '原密码错误' };
  if (!newPwd || String(newPwd).length < 6) return { ok: false, err: '新密码至少 6 位' };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(newPwd), 'chatusb:acct:' + account.account + ':' + salt, 64).toString('hex');
  account = { ...account, salt, hash, updatedAt: now() };
  writeJson(ACCOUNT_FILE, account);
  return { ok: true };
}

function loadRooms() { return readJson(ROOMS_FILE, []); }
function saveRooms() { writeJson(ROOMS_FILE, roomList); }

function findRoom(id) { return roomList.find(r => r.id === id) || null; }

/* ---------------- 好友（一对一私聊，复用房间机制，不依赖服务器） ---------------- */
function loadFriends() { return readJson(FRIENDS_FILE, []); }
function saveFriends() { writeJson(FRIENDS_FILE, friendList); }
function saveNotices() { writeJson(NOTICES_FILE, notices); }
function myAccountId() { return (profile.uid || '').slice(-8); }
// 对称派生：无论从哪一方发起，得到同一个私聊房间号与密码
function deriveChat(peerId) {
  const s = [myAccountId(), String(peerId || '').trim()].sort().join('|');
  const h = crypto.createHash('sha256').update('chatusb:chat:' + s).digest('hex');
  return { roomId: 'F' + h.slice(0, 8), password: h.slice(0, 12) };
}
function addFriend(peerId) {
  const pid = String(peerId || '').trim();
  if (!pid || pid.length < 4) return { ok: false, err: '请输入对方编号（至少 4 位）' };
  if (pid === myAccountId()) return { ok: false, err: '不能添加自己' };
  if (friendList.find(f => f.id === pid)) return { ok: false, err: '已经是好友了' };
  const { roomId, password } = deriveChat(pid);
  let room = findRoom(roomId);
  if (!room) {
    room = { id: roomId, name: '私聊·' + pid, password, isChat: true, createdAt: now() };
    roomList.push(room); saveRooms();
  }
  const friend = { id: pid, nickname: '好友 ' + pid, roomId, password, addedAt: now() };
  friendList.push(friend); saveFriends();
  return { ok: true, friend };
}
function removeFriend(peerId) {
  const i = friendList.findIndex(f => f.id === String(peerId || '').trim());
  if (i < 0) return { ok: false, err: '好友不存在' };
  friendList.splice(i, 1); saveFriends();
  return { ok: true };
}

/* ---------------- 历史记录（U 盘本地 jsonl，每个房间一个文件夹） ---------------- */
function historyFile(roomId) {
  const d = path.join(HISTORY_DIR, roomId);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return path.join(d, 'msgs.jsonl');
}
// 把旧的 data/history/<房间号>.jsonl 迁移到 data/history/<房间号>/msgs.jsonl
function migrateHistoryLayout() {
  try {
    for (const f of fs.readdirSync(HISTORY_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const roomId = f.slice(0, -6);
      const old = path.join(HISTORY_DIR, f);
      const d = path.join(HISTORY_DIR, roomId);
      fs.mkdirSync(d, { recursive: true });
      const target = path.join(d, 'msgs.jsonl');
      if (!fs.existsSync(target)) fs.renameSync(old, target);
      else { try { fs.appendFileSync(target, fs.readFileSync(old)); } catch {} try { fs.unlinkSync(old); } catch {} }
    }
  } catch {}
}
function appendHistory(roomId, msg) {
  if (msg && msg.id) seenIds.add(msg.id);
  try { fs.appendFileSync(historyFile(roomId), JSON.stringify(msg) + '\n'); } catch {}
  if (!historyCache[roomId]) historyCache[roomId] = [];
  historyCache[roomId].push(msg);
  trimHistory(roomId);
}
function trimHistory(roomId) {
  const arr = historyCache[roomId];
  if (arr.length > 3000) {
    arr.splice(0, arr.length - 3000);
    try {
      fs.writeFileSync(historyFile(roomId), arr.map(m => JSON.stringify(m)).join('\n') + '\n');
    } catch {}
  }
}
function loadHistory(roomId, limit, skip) {
  const file = historyFile(roomId);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
  const start = Math.max(0, lines.length - skip - limit);
  const out = lines.slice(start, Math.max(0, lines.length - skip)).map(l => { try { const m = JSON.parse(l); if (m && m.id) seenIds.add(m.id); return m; } catch { return null; } }).filter(Boolean);
  return out;
}
function historyCount(roomId) {
  try { return fs.readFileSync(historyFile(roomId), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}
function markRecalled(roomId, targetId) {
  const cache = historyCache[roomId];
  let changed = false;
  if (cache) { for (const m of cache) { if (m && m.id === targetId && !m.recalled) { m.recalled = true; changed = true; } } }
  if (changed) { try { fs.writeFileSync(historyFile(roomId), cache.map(m => JSON.stringify(m)).join('\n') + '\n'); } catch {} }
  return changed;
}

/* ---------------- 文件存储 ---------------- */
function roomDir(base, roomId) { const d = path.join(base, roomId); fs.mkdirSync(d, { recursive: true }); return d; }
function saveLocalFile(kind, roomId, msgId, name, buf) {
  const base = kind === 'voice' ? VOICE_DIR : FILES_DIR;
  const ext = kind === 'voice' ? '.webm' : path.extname(name);
  const safeName = path.basename(name).replace(/[\\\/:*?"<>|]/g, '_');
  const p = path.join(roomDir(base, roomId), msgId + '_' + safeName);
  fs.writeFileSync(p, buf);
  return { abs: p, rel: relPath(p), name: safeName, ext };
}

/* ---------------- 背景图（data/backgrounds，随机选一张当背景） ---------------- */
const BG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
function seedBackgrounds() {
  try {
    if (fs.existsSync(BACKGROUNDS_DIR) && fs.readdirSync(BACKGROUNDS_DIR).length > 0) return;
    fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
    const src = path.join(__dirname, 'assets', 'backgrounds');
    if (!fs.existsSync(src)) return;
    for (const f of fs.readdirSync(src)) {
      try { if (!fs.existsSync(path.join(BACKGROUNDS_DIR, f))) fs.copyFileSync(path.join(src, f), path.join(BACKGROUNDS_DIR, f)); } catch {}
    }
  } catch {}
}
function bgList() { try { return fs.readdirSync(BACKGROUNDS_DIR).filter(f => BG_EXT.includes(path.extname(f).toLowerCase())); } catch { return []; } }
function bgPick() {
  const list = bgList();
  if (!list.length) return { none: true };
  const name = list[Math.floor(Math.random() * list.length)];
  try {
    const buf = fs.readFileSync(path.join(BACKGROUNDS_DIR, name));
    const mime = ({ '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp' })[path.extname(name).toLowerCase()] || 'image/png';
    return { name, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), total: list.length };
  } catch { return { none: true }; }
}

/* ---------------- 头像（上传图片，存 data/avatars） ---------------- */
const AVATAR_MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const AVATAR_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function avatarSet(dataUrl, thumb) {
  try {
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return { ok: false, err: '不是有效的图片' };
    if (dataUrl.length > 5 * 1024 * 1024) return { ok: false, err: '图片过大（>3MB）' };
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const ext = AVATAR_MIME_EXT[mime] || '.png';
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    for (const f of fs.readdirSync(AVATAR_DIR)) { try { fs.unlinkSync(path.join(AVATAR_DIR, f)); } catch {} }
    fs.writeFileSync(path.join(AVATAR_DIR, 'avatar' + ext), buf);
    profile.avatarImg = 'avatars/avatar' + ext;
    // 缩略图（用于同步给好友，小图省流量）
    profile.avatarThumb = null;
    if (thumb && thumb.startsWith('data:image/')) {
      try { fs.writeFileSync(path.join(AVATAR_DIR, 'avatar-thumb.png'), Buffer.from(thumb.slice(thumb.indexOf(',') + 1), 'base64')); profile.avatarThumb = 'avatars/avatar-thumb.png'; } catch {}
    }
    saveProfile(profile);
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), thumb: avatarThumbDataUrl() };
  } catch (err) { return { ok: false, err: '保存头像失败: ' + err.message }; }
}
function avatarThumbDataUrl() {
  try {
    if (!profile.avatarThumb) return null;
    const p = path.join(DATA_DIR, profile.avatarThumb);
    if (!fs.existsSync(p)) return null;
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch { return null; }
}
function avatarGetThumb() { return { ok: !!profile.avatarThumb, dataUrl: avatarThumbDataUrl() }; }
function avatarGet() {
  try {
    if (!profile.avatarImg) return { ok: false };
    const p = path.join(DATA_DIR, profile.avatarImg);
    if (!fs.existsSync(p)) return { ok: false };
    const buf = fs.readFileSync(p);
    const mime = AVATAR_EXT_MIME[path.extname(p).toLowerCase()] || 'image/png';
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
  } catch { return { ok: false }; }
}
function avatarClear() {
  try { for (const f of fs.readdirSync(AVATAR_DIR)) { try { fs.unlinkSync(path.join(AVATAR_DIR, f)); } catch {} } } catch {}
  profile.avatarImg = null;
  profile.avatarThumb = null;
  saveProfile(profile);
  return { ok: true };
}
function peerAvatarPath(uid) { return path.join(AVATAR_DIR, 'peers', String(uid) + '.png'); }

/* ---------------- 消息构造 ---------------- */
function buildMsg(type, content, extra) {
  return Object.assign({
    id: newId(),
    roomId: currentRoomId,
    from: { uid: profile.uid, name: profile.nickname, color: profile.avatarColor, emoji: profile.avatarEmoji },
    type, content, ts: now()
  }, extra || {});
}

/* 带 base64 负载的线上消息（发送时用），history 里存的是落盘后的版本 */
function toWireMsg(msg) {
  const w = Object.assign({}, msg);
  if (w.fileBytes) {
    w.content = w.fileBytes.toString('base64');
    w.fileBytes = undefined;
  }
  if (w.file) {
    w.file = Object.assign({}, w.file);   // 只传元信息，不带本地路径
    delete w.file.path;
    delete w.file.abs;
  }
  return w;
}

/* =====================================================================
 * 网络层：两种模式
 *   wan —— MQTT 走公共代理，任意网络可互聊（默认）
 *   lan —— 一方开主机、另一方直连 ws://ip:port，局域网内大文件无限制
 * ===================================================================== */
class Net {
  constructor() {
    this.mode = 'wan';
    this.roomId = null;
    this.mqttClient = null;
    this.wsServer = null;
    this.wsClient = null;
    this.peers = new Map();      // uid -> {uid,name,color,emoji,online,ts}
    this.selfUid = profile.uid;
    this.myId = (profile.uid || '').slice(-8);   // 对外编号，名片通道的 key
    this.friendOnline = new Map(); // friendId -> {name, ts}
    this.presTimer = null;
    this.connState = 'disconnected';
    this.brokerIndex = 0;
    this.roomKey = null;
  }

  emit(ev) {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('event', ev);
  }
  setState(state, extra) {
    this.connState = state;
    this.emit({ type: 'conn', state, mode: this.mode, roomId: this.roomId, ...(extra || {}) });
  }

  /* ---------- 进入房间（自动切换/建立传输） ---------- */
  async connect(roomId, mode) {
    this.disconnect();
    this.mode = mode || this.mode;
    this.roomId = roomId;
    const room = findRoom(roomId);
    this.roomKey = room && room.password ? roomKey(roomId, room.password) : null;
    this.peers.clear();
    this.setState('connecting');
    if (this.mode === 'lan') {
      this._startLanHost(roomId);
    } else {
      this._connectMqtt(roomId);
    }
  }

  /* ---------- MQTT 公共模式 ---------- */
  _connectMqtt(roomId) {
    const brokers = (profile.brokers && profile.brokers.length ? profile.brokers : DEFAULT_BROKERS);
    const broker = brokers[this.brokerIndex % brokers.length];
    this.emit({ type: 'log', text: '正在连接公共消息服务：' + broker });
    const client = mqtt.connect(broker, {
      clientId: 'cub_' + this.selfUid + '_' + Math.random().toString(16).slice(2, 8),
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 15000,
      rejectUnauthorized: false
    });
    this.mqttClient = client;
    const msgsTopic = 'chatusb/' + roomId + '/msgs';
    const presTopic = 'chatusb/' + roomId + '/presence';
    const reqTopic = 'chatusb/req/' + this.myId;
    const friendPresTopics = friendList.map(f => 'chatusb/pres/' + f.id);

    client.on('connect', () => {
      this.brokerIndex = 0;
      this.setState('connected');
      client.subscribe([msgsTopic, presTopic + '/+', reqTopic].concat(friendPresTopics), { qos: 1 }, (err) => {
        if (err) this.emit({ type: 'log', text: '订阅失败：' + err.message });
      });
      this._publishPresence(true);
      this._beacon();
      this._startBeaconTimer();
    });
    client.on('reconnect', () => this.setState('connecting'));
    client.on('close', () => { this._stopBeaconTimer(); if (this.connState === 'connected') this.setState('disconnected'); });
    client.on('error', (err) => {
      this.emit({ type: 'log', text: '公共服务连接失败：' + err.message });
      if (this.mqttClient === client) {
        this.brokerIndex++;
        if (this.brokerIndex >= (profile.brokers || DEFAULT_BROKERS).length) this.brokerIndex = 0;
      }
    });
    client.on('message', (topic, payload) => {
      if (topic === msgsTopic) this._handleWire(JSON.parse(payload.toString('utf8')));
      else if (topic.startsWith(presTopic + '/')) {
        try { const p = JSON.parse(payload.toString('utf8')); this._handlePresence(p); } catch {}
      }
      else if (topic === reqTopic) {
        try { this._handleFriendMsg(JSON.parse(payload.toString('utf8'))); } catch (e) {}
      }
      else if (topic.startsWith('chatusb/pres/')) {
        try { this._handleFriendPresence(JSON.parse(payload.toString('utf8'))); } catch {}
      }
    });
  }

  /* ---------- 好友名片通道：上线心跳 + 请求收发 ---------- */
  _beacon() {
    if (!this.mqttClient || !this.mqttClient.connected) return;
    this.mqttClient.publish('chatusb/pres/' + this.myId,
      JSON.stringify({ uid: this.selfUid, id: this.myId, name: profile.nickname, ts: now() }), { qos: 0 });
  }
  _startBeaconTimer() {
    this._stopBeaconTimer();
    this.presTimer = setInterval(() => { this._beacon(); this._checkFriendOffline(); }, 25000);
  }
  _stopBeaconTimer() { if (this.presTimer) { clearInterval(this.presTimer); this.presTimer = null; } }
  _checkFriendOffline() {
    for (const [id, o] of [...this.friendOnline]) {
      if (now() - o.ts > 90000) { this.friendOnline.delete(id); this.emit({ type: 'friend-presence', id, online: false }); }
    }
  }
  _handleFriendPresence(p) {
    if (!p || !p.id) return;
    const f = friendList.find(x => x.id === p.id);
    if (!f) return;
    const was = this.friendOnline.has(p.id);
    this.friendOnline.set(p.id, { name: p.name || f.nickname, ts: now() });
    if (!was) this.emit({ type: 'friend-presence', id: p.id, name: p.name || f.nickname, online: true });
  }
  _handleFriendMsg(p) {
    if (!p || !p.type) return;
    if (p.type === 'friendReq') {
      const fromId = p.from && p.from.uid ? p.from.uid.slice(-8) : '';
      const reqId = p.reqId || '';
      const notice = { id: reqId, peerId: fromId, peerUid: (p.from && p.from.uid) || '', name: (p.from && p.from.name) || ('好友 ' + fromId), msg: p.msg || '', ts: p.ts || now(), status: 'pending', dir: 'in' };
      notices.push(notice); saveNotices();
      this.emit({ type: 'friend-notice', notice });
    } else if (p.type === 'friendResp') {
      const fromId = p.from && p.from.uid ? p.from.uid.slice(-8) : '';
      const reqId = p.reqId || '';
      const n = notices.find(x => x.id === reqId && x.dir === 'out');
      if (n) { n.status = p.ok ? 'accepted' : 'rejected'; saveNotices(); this.emit({ type: 'friend-notice', notice: n }); }
      if (p.ok && fromId) {
        const r = addFriend(fromId);
        if (r && r.ok) this.emit({ type: 'friend-added', friend: r.friend });
      }
    }
  }
  sendFriendReq(peerId, msg) {
    const reqId = 'r' + crypto.randomBytes(6).toString('hex');
    const p = { type: 'friendReq', reqId, from: { uid: this.selfUid, name: profile.nickname }, msg: msg || '', ts: now() };
    const notice = { id: reqId, peerId, name: '好友 ' + peerId, msg: msg || '', ts: now(), status: 'pending', dir: 'out' };
    notices.push(notice); saveNotices();
    this.emit({ type: 'friend-notice', notice });
    this.publishRaw('chatusb/req/' + peerId, p);
    return { ok: true, noticeId: reqId };
  }
  sendFriendResp(peerId, reqId, ok) {
    this.publishRaw('chatusb/req/' + peerId,
      { type: 'friendResp', reqId, from: { uid: this.selfUid, name: profile.nickname }, ok, ts: now() });
  }
  publishRaw(topic, obj) {
    if (this.mqttClient && this.mqttClient.connected) this.mqttClient.publish(topic, JSON.stringify(obj), { qos: 1 });
  }

  _publishPresence(online) {
    if (!this.mqttClient || !this.mqttClient.connected) return;
    const topic = 'chatusb/' + this.roomId + '/presence/' + this.selfUid;
    const payload = JSON.stringify({
      uid: this.selfUid, name: profile.nickname, color: profile.avatarColor,
      emoji: profile.avatarEmoji, online, ts: now()
    });
    this.mqttClient.publish(topic, payload, { qos: 1, retain: true });
  }

  _handlePresence(p) {
    const key = p.uid;
    if (key === this.selfUid) return;
    const wasOnline = this.peers.has(key) && this.peers.get(key).online;
    this.peers.set(key, p);
    this.emit({ type: 'presence', peers: [...this.peers.values()].filter(x => x.online) });
    if (p.online) {
      if (!wasOnline) {
        this.emit({ type: 'system', text: '「' + p.name + '」进入了房间' });
        // 对方上线：把离线期间缓存在 U 盘的消息补发给他
        this.flushPending(this.roomId, p.uid);
      }
    }
  }

  /* ---------- 局域网直连模式 ---------- */
  _startLanHost(roomId) {
    this.wsServer = new WebSocketServer({ port: LAN_PORT, host: '0.0.0.0' });
    const self = this;
    this.wsServer.on('listening', () => {
      this.setState('connected');
      this.emit({ type: 'lan', lanUrl: this.lanUrl(), hosting: true });
    });
    this.wsServer.on('error', (err) => {
      this.emit({ type: 'log', text: '局域网主机启动失败：' + err.message });
      this.setState('disconnected');
    });
    this.wsServer.on('connection', (ws) => {
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
        if (m.t === 'join') {
          ws.peer = m.peer;
          this.peers.set(m.peer.uid, Object.assign({}, m.peer, { online: true, ts: now() }));
          this._broadcastLan({ t: 'presence', peers: [...this.peers.values()] });
          this.emit({ type: 'system', text: '「' + m.peer.name + '」进入了房间' });
        } else if (m.t === 'msg') {
          this._handleWire(m.wire);
          // 转发给其他人
          this._broadcastLan({ t: 'msg', wire: m.wire }, ws);
        }
      });
      ws.on('close', () => {
        if (ws.peer) {
          this.peers.delete(ws.peer.uid);
          this._broadcastLan({ t: 'presence', peers: [...this.peers.values()] });
          this.emit({ type: 'system', text: '「' + ws.peer.name + '」离开了房间' });
        }
      });
    });
  }

  _broadcastLan(msg, exceptWs) {
    if (!this.wsServer) return;
    const data = JSON.stringify(msg);
    for (const c of this.wsServer.clients) {
      if (c !== exceptWs && c.readyState === WebSocket.OPEN) c.send(data);
    }
  }

  lanUrl() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === 'IPv4' && !n.internal) return 'ws://' + n.address + ':' + LAN_PORT;
      }
    }
    return 'ws://127.0.0.1:' + LAN_PORT;
  }

  lanJoin(roomId, url) {
    this.disconnect();
    this.mode = 'lan';
    this.roomId = roomId;
    const room = findRoom(roomId);
    this.roomKey = room && room.password ? roomKey(roomId, room.password) : null;
    this.peers.clear();
    this.setState('connecting');
    const ws = new WebSocket(url);
    this.wsClient = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'join',
        peer: { uid: profile.uid, name: profile.nickname, color: profile.avatarColor, emoji: profile.avatarEmoji }
      }));
      this.setState('connected');
    });
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (m.t === 'msg') this._handleWire(m.wire);
      else if (m.t === 'presence') {
        this.peers.clear();
        for (const p of m.peers) if (p.uid !== this.selfUid) this.peers.set(p.uid, p);
        this.emit({ type: 'presence', peers: [...this.peers.values()] });
      }
    });
    ws.on('close', () => { this.setState('disconnected'); this.emit({ type: 'log', text: '局域网连接已断开' }); });
    ws.on('error', (err) => {
      this.emit({ type: 'log', text: '局域网连接失败：' + err.message });
      this.setState('disconnected');
    });
  }

  /* ---------- 收消息统一入口 ---------- */
  _handleWire(wire) {
    const msg = wire.e ? decryptPayload(this.roomKey, wire) : wire;
    if (!msg) {
      this.emit({ type: 'log', text: '收到一条无法解密的消息（房间密码不一致？）' });
      return;
    }
    if (msg.roomId !== this.roomId) return;
    if (seenIds.has(msg.id)) return; // 已收到过（离线补发/重放），跳过避免重复
    if (msg.from && msg.from.uid === this.selfUid) return; // 自己的消息由发送方本地记录
    // 头像同步消息：缓存好友头像，不写入聊天记录
    if (msg.type === 'avatar' && msg.from && msg.from.uid && msg.content) {
      seenIds.add(msg.id);
      this.emit({ type: 'avatar', uid: msg.from.uid, name: msg.from.name || '', avatar: msg.content });
      return;
    }
    // 撤回消息：不写入聊天记录，只把目标消息标记为已撤回
    if (msg.type === 'recall' && msg.targetId) {
      seenIds.add(msg.id);
      markRecalled(msg.roomId, msg.targetId);
      this.emit({ type: 'recall', roomId: msg.roomId, targetId: msg.targetId, self: false });
      return;
    }
    // 带负载的文件类消息：解码并保存到 U 盘
    if (msg.content && (msg.type === 'file' || msg.type === 'image' || msg.type === 'voice')) {
      try {
        const buf = Buffer.from(msg.content, 'base64');
        const saved = saveLocalFile(msg.type === 'voice' ? 'voice' : 'file', msg.roomId, msg.id,
          msg.type === 'voice' ? 'voice.webm' : (msg.file ? msg.file.name : 'file'), buf);
        msg.content = '';
        msg.file = Object.assign({}, msg.file || {}, { path: saved.rel, name: saved.name });
      } catch (e) {
        this.emit({ type: 'log', text: '接收文件失败：' + e.message });
      }
    }
    appendHistory(msg.roomId, msg);
    this.emit({ type: 'message', msg });
  }

  /* ---------- 发送 ---------- */
  publish(msg) {
    const wire = toWireMsg(msg);
    const out = this.roomKey ? encryptPayload(this.roomKey, wire) : wire;
    if (this.mode === 'lan') {
      if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
        this.wsClient.send(JSON.stringify({ t: 'msg', wire: out }));
      } else if (this.wsServer) {
        this._broadcastLan({ t: 'msg', wire: out });
      } else {
        throw new Error('局域网未连接，无法发送');
      }
    } else if (this.mqttClient && this.mqttClient.connected) {
      this.mqttClient.publish('chatusb/' + msg.roomId + '/msgs', JSON.stringify(out), { qos: 1 });
    } else {
      throw new Error('当前未连接，无法发送');
    }
    return out;
  }

  /* ---------- 离线消息缓存（云端存历史）：对方离线时缓存在U盘，上线后补发 ---------- */
  offlinePeerUids(roomId) {
    const online = new Set();
    for (const p of this.peers.values()) if (p.online) online.add(p.uid);
    const offline = new Set();
    const arr = historyCache[roomId];
    if (arr) for (const m of arr) if (m && m.from && m.from.uid && m.from.uid !== this.selfUid) offline.add(m.from.uid);
    for (const uid of online) offline.delete(uid);
    return [...offline];
  }
  cacheOffline(roomId, wireOut) {
    if (this.mode !== 'wan' || !this.mqttClient || !this.mqttClient.connected) return;
    const uids = this.offlinePeerUids(roomId);
    if (!uids.length) return;
    const line = JSON.stringify(wireOut);
    const pendDir = path.join(PENDING_DIR, roomId);
    try { fs.mkdirSync(pendDir, { recursive: true }); } catch {}
    for (const uid of uids) {
      try { fs.appendFileSync(path.join(pendDir, uid + '.jsonl'), line + '\n'); } catch {}
    }
    this.emit({ type: 'log', text: '对方不在线，消息已缓存在U盘，对方上线后自动补发' });
  }
  flushPending(roomId, uid) {
    if (this.mode !== 'wan' || !this.mqttClient || !this.mqttClient.connected) return;
    const file = path.join(PENDING_DIR, roomId, uid + '.jsonl');
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
    if (!lines.length) return;
    const topic = 'chatusb/' + roomId + '/msgs';
    for (const line of lines) { try { this.mqttClient.publish(topic, line, { qos: 1 }); } catch {} }
    try { fs.unlinkSync(file); } catch {}
    const name = (this.peers.get(uid) && this.peers.get(uid).name) || uid;
    this.emit({ type: 'system', text: '已向「' + name + '」补发离线期间的 ' + lines.length + ' 条消息' });
  }

  disconnect() {
    if (this.mqttClient) {
      this._publishPresence(false);
      try { this.mqttClient.end(true); } catch {}
      this.mqttClient = null;
    }
    if (this.wsServer) { try { this.wsServer.close(); } catch {} this.wsServer = null; }
    if (this.wsClient) { try { this.wsClient.close(); } catch {} this.wsClient = null; }
    this.peers.clear();
  }
}

/* =====================================================================
 * 发送消息（主进程统一入口，先落盘再发送）
 * ===================================================================== */
function sendText(roomId, text, opts) {
  const t = text.trim();
  if (!t) return { ok: false, err: '消息不能为空' };
  if (!net || net.roomId !== roomId) return { ok: false, err: '未连接该房间' };
  const extra = { roomId };
  const o = opts || {};
  if (o.reply) extra.reply = o.reply;
  if (o.mention && o.mention.length) extra.mention = o.mention;
  const msg = buildMsg('text', t, extra);
  appendHistory(roomId, msg);
  const out = net.publish(msg);
  if (out) net.cacheOffline(roomId, out);
  emitSelf(msg);
  return { ok: true };
}

function sendFileMsg(roomId, buf, name, mime, type, duration, transcript) {
  const isVoice = type === 'voice';
  const limit = WAN_FILE_LIMIT;
  if ((net.mode === 'wan') && buf.length > limit) {
    return { ok: false, err: '公共模式单条文件上限 ' + Math.floor(limit / 1024) + 'KB。大于该值的文件请使用「局域网直连模式」发送' };
  }
  const msg = buildMsg(isVoice ? 'voice' : (mime && mime.startsWith('image/') ? 'image' : 'file'), '', {
    roomId,
    file: { name, size: buf.length, mime: mime || 'application/octet-stream' },
    duration: duration || 0,
    transcript: transcript || ''
  });
  // 本地留档（发送方 U 盘也要有这份文件）
  const saved = saveLocalFile(isVoice ? 'voice' : 'file', roomId, msg.id, isVoice ? 'voice.webm' : name, buf);
  msg.file = Object.assign({}, msg.file, { path: saved.rel, name: saved.name });
  msg.fileBytes = buf;
  appendHistory(roomId, msg);
  const out = net.publish(msg);
  if (out) net.cacheOffline(roomId, out);
  emitSelf(msg);
  return { ok: true };
}

function emitSelf(msg) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('event', { type: 'message', msg, self: true });
}

/* =====================================================================
 * 截图
 * ===================================================================== */
let screenshotPayload = null;

async function captureScreen() {
  const cursor = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor);
  const b = disp.bounds;
  const sf = disp.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(b.width * sf), height: Math.round(b.height * sf) }
  });
  let src = sources.find(s => String(s.display_id) === String(disp.id));
  if (!src) src = sources[0];
  if (!src) throw new Error('无法获取屏幕画面（请检查系统屏幕录制权限）');
  return { dataUrl: 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(92).toString('base64'), bounds: b };
}

/* 生成一张纯色 PNG dataURL（用于截图自动化测试） */
function makeTestPng(w, h, rgb) {
  const zlib = require('zlib');
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255;
    }
  }
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]).toString('base64');
}
const SHOT_TEST = !!process.env.CHATUSB_SHOT_TEST;
function shotDbg(t) { try { fs.appendFileSync(path.join(PORTABLE_BASE, '_debug_shot.log'), t + '\n'); } catch {} }

async function startScreenshot() {
  if (shotWin) { shotWin.focus(); return; }
  try {
    const cap = SHOT_TEST
      ? { dataUrl: makeTestPng(800, 500, [30, 120, 220]), bounds: { x: 0, y: 0, width: 800, height: 500 } }
      : await captureScreen();
    screenshotPayload = cap;
    const b = cap.bounds;
    shotWin = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, transparent: true, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, fullscreenable: false,
      enableLargerThanScreen: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    shotWin.setAlwaysOnTop(true, 'screen-saver');
    shotWin.loadFile(path.join(__dirname, 'renderer', 'screenshot.html'));
    shotWin.once('ready-to-show', () => shotWin.show());
    shotWin.on('closed', () => { shotWin = null; screenshotPayload = null; });
    if (SHOT_TEST) {
      shotWin.webContents.once('did-finish-load', async () => {
        await new Promise(r => setTimeout(r, 1200));
        await shotWin.webContents.executeJavaScript('selectRect = {x:80,y:60,w:360,h:280}; enterEdit(); "ok";').catch(e => shotDbg('enterEdit-fail ' + e.message));
        await new Promise(r => setTimeout(r, 800));
        const state = await shotWin.webContents.executeJavaScript('JSON.stringify({toolbarHidden: document.getElementById(' + String.fromCharCode(39) + 'toolbar' + String.fromCharCode(39) + ').classList.contains(' + String.fromCharCode(39) + 'hidden' + String.fromCharCode(39) + '), cw: canvas.width, ch: canvas.height, hist: history.length, tip: document.getElementById(' + String.fromCharCode(39) + 'tipbar' + String.fromCharCode(39) + ').style.display})').catch(e => 'ERR ' + e.message);
        shotDbg('SHOT-TEST state=' + state);
        await shotWin.webContents.executeJavaScript('finish(' + String.fromCharCode(39) + 'send' + String.fromCharCode(39) + '); "ok";').catch(e => shotDbg('finish-fail ' + e.message));
        setTimeout(() => app.exit(0), 800);
      });
    }
  } catch (err) {
    if (mainWin) mainWin.webContents.send('event', { type: 'log', text: '截图失败：' + err.message });
  }
}

async function shotFinish(result) {
  if (SHOT_TEST) {
    const png = (result.png || '').replace(/^data:image\/png;base64,/, '');
    const ok = png.length > 100 && result.action === 'send';
    shotDbg('SHOT-TEST finish action=' + result.action + ' pngBase64Len=' + png.length + ' RESULT=' + (ok ? 'PASS' : 'FAIL'));
    if (shotWin) shotWin.close();
    setTimeout(() => app.exit(0), 500);
    return;
  }
  if (result.action === 'cancel') { if (shotWin) shotWin.close(); return; }
  if (result.action === 'save') {
    const dlg = await dialog.showSaveDialog(shotWin, {
      title: '保存截图',
      defaultPath: path.join(os.homedir(), 'Pictures', '截图-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '.png')
    });
    if (!dlg.canceled && dlg.filePath) {
      fs.writeFileSync(dlg.filePath, Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      if (mainWin) mainWin.webContents.send('event', { type: 'log', text: '截图已保存：' + dlg.filePath });
    }
    if (shotWin) shotWin.close();
    return;
  }
  // send
  const buf = Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  const name = '截图-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '.png';
  const r = sendFileMsg(currentRoomId, buf, name, 'image/png', 'image');
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('event', { type: 'log', text: r.ok ? '截图已发送' : '截图发送失败：' + r.err });
  if (shotWin) shotWin.close();
}

/* =====================================================================
 * 窗口
 * ===================================================================== */
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1080, height: 720, minWidth: 900, minHeight: 600,
    title: 'ChatUSB 便携聊天',
    icon: path.join(__dirname, 'build', 'icon.png'),
    frame: false,                 // 去掉系统原生标题栏，改用应用内自定义标题栏
    backgroundColor: '#f5f6f7',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 把渲染进程的所有报错/console 写进 U 盘日志，便于定位“点了没反应”
  mainWin.webContents.on('console-message', (e, level, message) => {
    try { fs.appendFileSync(path.join(DATA_DIR, 'log.txt'), '[' + level + '] ' + (message || '') + '\n'); } catch (_) {}
  });
  mainWin.webContents.on('render-process-gone', (e, details) => {
    try { fs.appendFileSync(path.join(DATA_DIR, 'log.txt'), '[render-gone] ' + JSON.stringify(details) + '\n'); } catch (_) {}
  });
  mainWin.on('maximize', () => { if (!mainWin.isDestroyed()) mainWin.webContents.send('event', { type: 'win-max', value: true }); });
  mainWin.on('unmaximize', () => { if (!mainWin.isDestroyed()) mainWin.webContents.send('event', { type: 'win-max', value: false }); });
  // 离线模式（静音免打扰）：最小化 → 缩到托盘 + 静音；恢复 → 退出静音
  mainWin.on('minimize', () => { if (profile.dndOnMinimize !== false) enterDnd(); });
  mainWin.on('restore', () => { if (!quitting) exitDnd(); });
  mainWin.on('show', () => { if (!quitting) exitDnd(); });
  // 点关闭 = 缩到托盘 + 离线模式（真正退出请用托盘菜单“退出”)
  mainWin.on('close', (e) => {
    if (!quitting && profile.dndOnMinimize !== false) { e.preventDefault(); enterDnd(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
  createTray();
}

/* 进入离线模式：缩到托盘、静音免打扰（消息照收，不响铃不弹窗） */
function enterDnd() {
  dnd = true;
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isVisible()) mainWin.hide();
    mainWin.webContents.send('event', { type: 'dnd', on: true });
  }
  if (tray) tray.setToolTip('ChatUSB · 离线模式（静音，消息照常接收）');
}
function exitDnd() {
  dnd = false;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('event', { type: 'dnd', on: false });
  if (tray) tray.setToolTip('ChatUSB 便携聊天');
}
function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
    tray.setToolTip('ChatUSB 便携聊天');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 ChatUSB', click: () => { if (mainWin) { mainWin.show(); mainWin.focus(); } exitDnd(); } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => {
      if (!mainWin) return;
      if (mainWin.isVisible()) { enterDnd(); } else { mainWin.show(); mainWin.focus(); exitDnd(); }
    });
  } catch (_) {}
}

/* =====================================================================
 * IPC
 * ===================================================================== */
function registerIpc() {
  ipcMain.handle('profile:get', () => Object.assign({}, profile, { dataDir: DATA_DIR }));
  ipcMain.handle('profile:save', (e, p) => { saveProfile(Object.assign({}, profile, p)); return profile; });

  ipcMain.handle('account:status', () => ({ registered: !!account, account: account ? account.account : '' }));
  ipcMain.handle('account:register', (e, acc, pwd) => registerAccount(acc, pwd));
  ipcMain.handle('account:login', (e, acc, pwd) => verifyAccount(acc, pwd));
  ipcMain.handle('account:reset', () => resetAccount());
  ipcMain.handle('account:changePwd', (e, oldp, newp) => changePassword(oldp, newp));

  ipcMain.handle('rooms:list', () => roomList);
  ipcMain.handle('rooms:create', (e, name, password) => {
    const id = 'R' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
    const room = { id, name: (name || '新房间').trim(), password: password || '', createdAt: now() };
    roomList.push(room);
    saveRooms();
    return room;
  });
  ipcMain.handle('rooms:join', (e, id, password) => {
    const roomId = String(id || '').trim();
    if (!roomId) return { ok: false, err: '请输入房间号' };
    let room = findRoom(roomId);
    if (!room) { room = { id: roomId, name: '房间 ' + roomId, password: password || '', createdAt: now() }; roomList.push(room); saveRooms(); }
    return { ok: true, room };
  });
  ipcMain.handle('rooms:update', (e, roomId, patch) => {
    const room = findRoom(roomId);
    if (!room) return { ok: false, err: '房间不存在' };
    const nameChanged = typeof patch.name === 'string' && patch.name.trim() !== room.name;
    const pwdChanged = typeof patch.password === 'string' && patch.password.trim() !== (room.password || '');
    if (nameChanged) room.name = patch.name.trim() || room.name;
    if (pwdChanged) {
      room.password = patch.password.trim();
      // 密码变了 → 加密密钥(scrypt(密码,房间号))变，旧记录用旧密钥加密无法再解开，清空该房间本地历史与离线缓存
      for (const d of [path.join(HISTORY_DIR, room.id), path.join(PENDING_DIR, room.id)]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
      }
    }
    saveRooms();
    return { ok: true, room, nameChanged, pwdChanged };
  });
  ipcMain.handle('rooms:leave', (e, id) => { roomList = roomList.filter(r => r.id !== id); saveRooms(); });
  ipcMain.handle('rooms:delete', (e, id) => { roomList = roomList.filter(r => r.id !== id); saveRooms(); });

  ipcMain.handle('friends:list', () => friendList);
  ipcMain.handle('friends:add', (e, peerId) => addFriend(peerId));
  ipcMain.handle('friends:request', (e, peerId, msg) => {
    const pid = String(peerId || '').trim();
    if (!pid || pid.length < 4) return { ok: false, err: '请输入对方编号（至少 4 位）' };
    if (pid === myAccountId()) return { ok: false, err: '不能添加自己' };
    if (friendList.find(f => f.id === pid)) return { ok: false, err: '已经是好友了' };
    if (!net || !net.mqttClient || !net.mqttClient.connected) return { ok: false, err: '未连接网络，无法发送好友申请' };
    return net.sendFriendReq(pid, msg);
  });
  ipcMain.handle('friends:remove', (e, peerId) => removeFriend(peerId));
  ipcMain.handle('friends:rename', (e, peerId, nickname) => {
    const f = friendList.find(x => x.id === String(peerId || '').trim());
    if (!f) return { ok: false };
    f.nickname = String(nickname || '').trim() || f.nickname; saveFriends(); return { ok: true, friend: f };
  });

  ipcMain.handle('notices:list', () => notices);
  ipcMain.handle('notices:status', (e, id, status) => {
    const n = notices.find(x => x.id === String(id || '').trim());
    if (!n) return { ok: false, err: '通知不存在' };
    if (status === 'accepted' && n.dir === 'in') {
      const r = addFriend(n.peerId);
      if (r.ok) { if (net) net.sendFriendResp(n.peerId, n.id, true); n.status = 'accepted'; saveNotices(); return { ok: true, friend: r.friend }; }
      return r;
    }
    if (status === 'rejected' && n.dir === 'in') {
      if (net) net.sendFriendResp(n.peerId, n.id, false);
      n.status = 'rejected'; saveNotices(); return { ok: true };
    }
    n.status = status; saveNotices(); return { ok: true };
  });

  ipcMain.handle('net:connect', (e, roomId) => {
    currentRoomId = roomId;
    profile.lastRoom = roomId;
    saveProfile(profile);
    net = net || new Net();
    net.connect(roomId, 'wan');
    return { ok: true };
  });
  ipcMain.handle('net:disconnect', () => { if (net) net.disconnect(); return { ok: true }; });
  ipcMain.handle('theme:set', (e, theme) => { setNativeTheme(theme); return true; });

  /* 自定义标题栏窗口控制 */
  ipcMain.handle('window:minimize', () => { if (mainWin) mainWin.minimize(); return true; });
  ipcMain.handle('window:maximizeToggle', () => { if (!mainWin) return true; if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize(); return true; });
  ipcMain.handle('window:close', () => { if (mainWin) mainWin.close(); return true; });
  ipcMain.handle('window:isMaximized', () => !!(mainWin && mainWin.isMaximized()));

  /* 背景图 */
  ipcMain.handle('bg:list', () => ({ names: bgList() }));
  ipcMain.handle('bg:pick', () => bgPick());
  ipcMain.handle('bg:open', () => { try { shell.openPath(BACKGROUNDS_DIR); } catch {} return true; });

  /* 头像（上传图片，存到 U 盘 data/avatars） */
  ipcMain.handle('avatar:set', (e, payload) => avatarSet(payload && payload.dataUrl, payload && payload.thumb));
  ipcMain.handle('avatar:get', () => avatarGet());
  ipcMain.handle('avatar:getThumb', () => avatarGetThumb());
  ipcMain.handle('avatar:clear', () => avatarClear());
  /* 好友头像缓存（存 data/avatars/peers） */
  ipcMain.handle('avatar:savePeer', (e, uid, dataUrl) => {
    try {
      if (!uid || !dataUrl || !dataUrl.startsWith('data:image/')) return { ok: false };
      fs.mkdirSync(path.join(AVATAR_DIR, 'peers'), { recursive: true });
      fs.writeFileSync(peerAvatarPath(uid), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      return { ok: true };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('avatar:getPeer', (e, uid) => {
    try {
      const p = peerAvatarPath(uid);
      if (!fs.existsSync(p)) return { ok: false };
      return { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('msg:sendAvatar', () => {
    const t = avatarThumbDataUrl();
    if (!t) return { ok: false };
    try { net.publish(buildMsg('avatar', t)); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; }
  });
  ipcMain.handle('lan:host', (e, roomId) => {
    currentRoomId = roomId;
    profile.lastRoom = roomId;
    saveProfile(profile);
    net = net || new Net();
    net.connect(roomId, 'lan');
    return { ok: true, lanUrl: net.lanUrl() };
  });
  ipcMain.handle('lan:join', (e, roomId, url) => {
    currentRoomId = roomId;
    profile.lastRoom = roomId;
    saveProfile(profile);
    net = net || new Net();
    net.lanJoin(roomId, url);
    return { ok: true };
  });
  ipcMain.handle('lan:stop', () => { if (net) net.disconnect(); return { ok: true }; });

  ipcMain.handle('msg:sendText', (e, roomId, text, opts) => sendText(roomId, text, opts || {}));
  ipcMain.handle('file:read', async (e, p) => { try { return await fs.promises.readFile(p); } catch { return null; } });
  ipcMain.handle('msg:sendFile', async (e, roomId, bytes, name, mime) => {
    const buf = Buffer.from(bytes);
    const r = sendFileMsg(roomId, buf, name, mime, 'file');
    return r;
  });
  ipcMain.handle('msg:sendVoice', async (e, roomId, bytes, duration, transcript) => {
    const r = sendFileMsg(roomId, Buffer.from(bytes), 'voice.webm', 'audio/webm', 'voice', duration, transcript);
    return r;
  });
  ipcMain.handle('asr:transcribe', (e, pcm, sampleRate) => transcribeAudio(pcm, sampleRate));
  ipcMain.handle('msg:recall', (e, roomId, targetId) => {
    const cache = historyCache[roomId];
    let found = null;
    if (cache) found = cache.find(m => m && m.id === targetId) || null;
    if (!found || found.recalled || !(found.from && found.from.uid === profile.uid)) return { ok: false, err: '只能撤回自己、且未被撤回的消息' };
    found.recalled = true;
    try { fs.writeFileSync(historyFile(roomId), cache.map(m => JSON.stringify(m)).join('\n') + '\n'); } catch {}
    const msg = buildMsg('recall', '', { roomId, targetId });
    const out = net.publish(msg);
    if (out) net.cacheOffline(roomId, out);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('event', { type: 'recall', roomId, targetId, self: true });
    return { ok: true };
  });

  ipcMain.handle('history:load', (e, roomId, limit, skip) => loadHistory(roomId, limit || 200, skip || 0));
  ipcMain.handle('history:count', (e, roomId) => historyCount(roomId));
  ipcMain.handle('history:search', async (e, roomId, query) => {
    if (!query || !String(query).trim()) return [];
    const q = String(query).trim().toLowerCase();
    let lines = [];
    try { lines = (await fs.promises.readFile(historyFile(roomId), 'utf8')).split('\n').filter(Boolean); } catch {}
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < 50; i--) {
      let m = null; try { m = JSON.parse(lines[i]); } catch {}
      if (m && m.type === 'text' && !m.recalled && String(m.content || '').toLowerCase().indexOf(q) >= 0) {
        out.push({ id: m.id, ts: m.ts, name: (m.from && m.from.name) || '', content: m.content });
      }
    }
    return out;
  });

  ipcMain.handle('file:dataUrl', (e, rel) => {
    try {
      const p = absPath(rel);
      if (!fs.existsSync(p)) return null;
      const ext = path.extname(p).toLowerCase();
      let mime = 'application/octet-stream';
      if (ext === '.png') mime = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.gif') mime = 'image/gif';
      else if (ext === '.webp') mime = 'image/webp';
      else if (ext === '.webm') mime = 'audio/webm';
      else if (ext === '.mp3') mime = 'audio/mpeg';
      else if (ext === '.ogg') mime = 'audio/ogg';
      else if (ext === '.wav') mime = 'audio/wav';
      return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
    } catch { return null; }
  });
  ipcMain.handle('file:saveDialog', async (e, rel, suggestedName) => {
    const p = absPath(rel);
    if (!fs.existsSync(p)) return { ok: false, err: '文件不存在（U 盘数据可能不完整）' };
    const dlg = await dialog.showSaveDialog(mainWin, { title: '保存文件', defaultPath: path.join(os.homedir(), 'Downloads', suggestedName || path.basename(p)) });
    if (dlg.canceled) return { ok: false, err: 'canceled' };
    fs.copyFileSync(p, dlg.filePath);
    return { ok: true, path: dlg.filePath };
  });
  ipcMain.handle('file:open', (e, rel) => {
    const p = absPath(rel);
    if (fs.existsSync(p)) shell.openPath(p);
    return { ok: true };
  });

  ipcMain.handle('shot:start', () => startScreenshot());
  ipcMain.handle('shot:finish', (e, result) => shotFinish(result));
  ipcMain.handle('shot:get', () => screenshotPayload);

  ipcMain.handle('app:notify', (e, title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
    return { ok: true };
  });
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, dataDir: DATA_DIR }));
}

/* =====================================================================
 * 权限：允许麦克风 / 屏幕捕获 / 通知
 * ===================================================================== */
function setupPermissions() {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const allow = ['media', 'audioCapture', 'desktopCapturer', 'notifications'].includes(permission);
    cb(allow);
  });
}

/* =====================================================================
 * 自测模式：自动建房间、发文字/文件/语音，验证收发
 * ===================================================================== */
async function runSelfTest() {
  const tag = process.env.CHATUSB_TEST_TAG || 'A';
  const roomId = 'SELFTEST-' + (process.env.CHATUSB_TEST_ROOM || 'ROOM1');
  const results = [];
  function log(ok, name, detail) { results.push({ ok, name, detail }); console.log('[SELFTEST ' + tag + '] ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + ' ' + (detail || '')); }

  try {
    profile.nickname = '测试' + tag;
    saveProfile(profile);
    roomList.push({ id: roomId, name: '自测房间', password: 'pwd123', createdAt: now() });
    saveRooms();
    currentRoomId = roomId;
    net = new Net();
    net.connect(roomId, 'wan');

    // 先让探测客户端订阅主题，再发送，确保能收到
    const other = mqtt.connect(DEFAULT_BROKERS[0], { clientId: 'cub_probe_' + Math.random().toString(16).slice(2, 8), clean: true });
    const received = [];
    await new Promise(res => {
      other.on('connect', () => {
        other.subscribe('chatusb/' + roomId + '/msgs', { qos: 1 }, () => {
          other.on('message', (t, p) => { try { received.push(JSON.parse(p.toString())); } catch {} });
          res();
        });
      });
      other.on('error', () => res());
    });

    await new Promise(res => setTimeout(res, 5000));
    log(net.connState === 'connected', 'MQTT 连接', net.connState);

    const sendResults = [];
    const publish = net.publish.bind(net);
    net.publish = (msg) => {
      try { publish(msg); sendResults.push(msg); log(true, '发送 ' + msg.type, msg.id); }
      catch (e) { log(false, '发送 ' + msg.type, e.message); }
    };

    sendText(roomId, '你好，我是 ' + tag);
    sendFileMsg(roomId, Buffer.from('ChatUSB 自测文件内容-' + tag), '测试文件.txt', 'text/plain', 'file');
    sendFileMsg(roomId, Buffer.from(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), '测试图片.png', 'image/png', 'image');
    sendFileMsg(roomId, Buffer.from('webm-fake-' + tag), 'voice.webm', 'audio/webm', 'voice', 3);

    await new Promise(res => setTimeout(res, 8000));
    other.end(true);

    // 校验 A 自己发出的消息都已落盘
    const hist = loadHistory(roomId, 100, 0);
    log(hist.length >= 8, '本地历史落盘 ' + hist.length + ' 条', '');
    log(sendResults.length === 4, '发送调用成功 ' + sendResults.length + '/4', '');

    // 探测客户端视角：验证消息到达公共消息服务（跨网络可达）且被加密
    const mine = received.filter(m => m && m.e === true);
    log(received.length >= 4, '公共服务收到 ' + received.length + '/4 条消息', '');
    log(mine.length >= 4, '负载已加密(AES-256-GCM)', mine.length + ' 条密文');

    // 校验对端（另一个实例）发来的消息已落盘到 U 盘
    const others = hist.filter(m => m.from && m.from.uid !== profile.uid);
    log(others.length >= 4, '收到对端消息并落盘 ' + others.length + '/4', others.map(m => m.type).join(','));
    const fileMsg = others.find(m => (m.type === 'file' || m.type === 'image' || m.type === 'voice') && m.file && m.file.path);
    const fileOk = !!fileMsg && fs.existsSync(absPath(fileMsg.file.path)) && !fileMsg.content;
    log(fileOk, '对端文件已保存到U盘', fileMsg ? fileMsg.file.path : '');
    const voiceMsg = others.find(m => m.type === 'voice' && m.file && m.file.path);
    const voiceOk = !!voiceMsg && fs.existsSync(absPath(voiceMsg.file.path));
    log(voiceOk, '对端语音已保存到U盘', voiceMsg ? voiceMsg.file.path : '');

    // 局域网直连模式测试（仅 A 实例执行，避免端口冲突）
    if (tag === 'A') {
      try {
        net.disconnect();
        net = new Net();
        net.connect(roomId, 'lan');
        await new Promise(res => setTimeout(res, 1500));
        const wsClient = new WebSocket('ws://127.0.0.1:3721');
        const lanGot = [];
        await new Promise(res => {
          wsClient.on('open', () => {
            wsClient.send(JSON.stringify({ t: 'join', peer: { uid: 'u_probe', name: '探测', color: '#fff', emoji: '🔍' } }));
            wsClient.on('message', (d) => { try { lanGot.push(JSON.parse(d.toString())); } catch {} });
            setTimeout(() => {
              try { net.publish(buildMsg('text', '局域网测试消息', { roomId })); }
              catch (e) { log(false, 'LAN 发送', e.message); }
            }, 600);
            setTimeout(res, 2500);
          });
          wsClient.on('error', () => res());
        });
        wsClient.close();
        const lanMsgs = lanGot.filter(m => m.t === 'msg');
        const lanPres = lanGot.filter(m => m.t === 'presence');
        log(lanMsgs.length >= 1, 'LAN 主机广播收到', lanMsgs.length + ' 条消息');
        log(lanPres.length >= 1, 'LAN 在线列表广播', lanPres.length + ' 次');
      } catch (e) {
        log(false, 'LAN 测试异常', e.message);
      }
    }

    console.log('[SELFTEST ' + tag + '] SUMMARY ' + JSON.stringify(results));
  } catch (e) {
    console.log('[SELFTEST ' + tag + '] CRASH ' + e.message);
    console.log(e.stack);
  }
  setTimeout(() => app.exit(0), 1500);
}

/* =====================================================================
 * 生命周期
 * ===================================================================== */
/* ---------------- 中文应用菜单 ---------------- */
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: 'ChatUSB', submenu: [{ role: 'about', label: '关于 ChatUSB' }, { type: 'separator' }, { role: 'quit', label: '退出 ChatUSB' }] }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建房间 / 加入房间', click: () => { if (mainWin) mainWin.webContents.send('event', { type: 'menu-join' }); } },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '切换日间/夜间模式', accelerator: 'CmdOrCtrl+Shift+T', click: () => { if (mainWin) mainWin.webContents.send('event', { type: 'menu-toggle-theme' }); } },
        { label: '截图（框选并发送）', accelerator: 'CmdOrCtrl+Shift+A', click: () => startScreenshot() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(process.env.CHATUSB_DEVTOOLS ? [{ role: 'toggleDevTools', label: '开发者工具' }] : [])
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '最大化' },
        ...(isMac ? [{ role: 'front', label: '前置全部窗口' }] : [{ role: 'close', label: '关闭窗口' }])
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 ChatUSB', click: () => {
            dialog.showMessageBox({ type: 'info', title: '关于 ChatUSB',
              message: 'ChatUSB 便携聊天',
              detail: '解压即用的 U 盘聊天软件\n跨网络互聊 · 数据全部保存在程序旁 data 目录\n\n快捷键：Ctrl+Shift+A 截图 · Ctrl+Shift+T 切换模式',
              buttons: ['好的'] });
          } }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.env.CHATUSB_MENU_DUMP) {
    const walk = (items, depth) => { for (const it of items) { try { fs.appendFileSync(path.join(PORTABLE_BASE, '_menu_dump.txt'), ' '.repeat(depth) + (it.label || '—') + '\n'); } catch {} if (it.submenu) walk(it.submenu.items, depth + 2); } };
    try { walk(Menu.getApplicationMenu().items, 0); } catch {}
  }
}

/* ---------------- 离线补发自动化自测（CHATUSB_OFFLINE_TEST=1） ---------------- */
function waitFor(fn, ms) {
  return new Promise((res) => {
    const t = setInterval(() => { if (fn()) { clearInterval(t); res(true); } }, 150);
    setTimeout(() => { clearInterval(t); res(fn()); }, ms);
  });
}
function runOfflineTest() {
  const roomId = process.env.CHATUSB_TEST_ROOM || 'OFFROOM';
  if (!findRoom(roomId)) roomList.push({ id: roomId, name: '离线测试', password: 'offpwd', created: now() });
  net = new Net();
  net.connect(roomId, 'wan').catch(() => {});
  const results = [];
  const log2 = (name, ok, detail) => { results.push({ ok, name, detail }); console.log('[OFFLINETEST] ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + ' ' + (detail || '')); };
  const peerUid = 'u_offlinepeer_test';
  const pendFile = () => path.join(PENDING_DIR, roomId, peerUid + '.jsonl');
  const pendCount = () => { try { return fs.readFileSync(pendFile(), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

  (async () => {
    await waitFor(() => net.connState === 'connected', 15000);
    log2('MQTT 连接', true, 'connected');
    if (!historyCache[roomId]) historyCache[roomId] = [];
    // 让发送方“认识”一个目前离线的成员
    historyCache[roomId].push({ id: 'peer_ref_' + roomId, from: { uid: peerUid, name: '离线好友' } });
    // 构造一条加密消息并缓存（模拟对方离线时我发出的消息）
    const msg = buildMsg('text', '离线补发测试消息', { roomId });
    const out = net.roomKey ? encryptPayload(net.roomKey, toWireMsg(msg)) : toWireMsg(msg);
    net.cacheOffline(roomId, out);
    log2('离线消息已缓存到U盘', pendCount() >= 1, '缓存行数=' + pendCount());

    // 挂一个“刚上线的接收端”原始客户端订阅该房间
    const recipient = mqtt.connect(DEFAULT_BROKERS[0], {
      clientId: 'cub_offrecv_' + Math.random().toString(16).slice(2, 8), clean: true,
      keepalive: 30, reconnectPeriod: 2000, connectTimeout: 15000, rejectUnauthorized: false
    });
    const msgsTopic = 'chatusb/' + roomId + '/msgs';
    const received = [];
    recipient.on('message', (_t, p) => received.push(p.toString('utf8')));
    await new Promise((res) => recipient.on('connect', () => {
      recipient.subscribe(msgsTopic, { qos: 1 }, (err) => res());
    }));

    // 模拟离线成员上线 → 触发自动补发
    net._handlePresence({ uid: peerUid, name: '离线好友', color: '#000', emoji: '🙂', online: true, ts: now() });
    await new Promise(r => setTimeout(r, 3500));

    log2('上线后收到补发消息', received.length >= 1, '收到条数=' + received.length);
    let decOk = false;
    if (received.length) {
      try { const p = JSON.parse(received[0]); const dec = p.e ? decryptPayload(net.roomKey, p) : p; decOk = dec && dec.content === '离线补发测试消息'; } catch {}
    }
    log2('补发消息解密校验', decOk, '');
    log2('补发后U盘缓存已清空', pendCount() === 0, '剩余行数=' + pendCount());

    recipient.end(true);
    net.disconnect();
    console.log('[OFFLINETEST] SUMMARY ' + JSON.stringify(results));
    setTimeout(() => app.exit(results.every(r => r.ok) ? 0 : 1), 400);
  })();
}

/* ---------------- 让系统原生窗口标题栏跟随主题（夜间模式整条变黑） ---------------- */
function setNativeTheme(theme) {
  try {
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
    if (mainWin && !mainWin.isDestroyed()) mainWin.setBackgroundColor(theme === 'dark' ? '#1d2129' : '#f5f6f7');
  } catch {}
}

app.whenReady().then(() => {
  ensureDirs();
  seedBackgrounds();
  app.setPath('userData', DATA_DIR);
  setNativeTheme(profile.theme);
  if (app.isPackaged) {
    app.setAppUserModelId('com.chatusb.portable');
    if (process.platform === 'win32') { /* Windows 任务栏分组 */ }
  }
  registerIpc();
  setupPermissions();
  if (process.env.CHATUSB_OFFLINE_TEST) { runOfflineTest(); return; }
  if (TEST_MODE) { runSelfTest(); return; }
  if (SHOT_TEST) { setTimeout(() => startScreenshot(), 800); return; }
  buildAppMenu();
  createMainWindow();
  try {
    globalShortcut.register('CommandOrControl+Shift+A', () => startScreenshot());
    globalShortcut.register('CommandOrControl+Shift+T', () => {
      const cur = profile.theme === 'dark' ? 'light' : 'dark';
      setNativeTheme(cur);
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('event', { type: 'toggle-theme-shortcut', theme: cur });
    });
  } catch {}
});

app.on('window-all-closed', () => {
  if (net) net.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  if (net) net.disconnect();
  globalShortcut.unregisterAll();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
