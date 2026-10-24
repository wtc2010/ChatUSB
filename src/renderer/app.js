'use strict';
/* ================= ChatUSB 渲染层 ================= */
window.addEventListener('error', (ev) => { try { console.error('[uncaught] ' + (ev.message || '') + ' @ ' + (ev.filename || '') + ':' + ev.lineno); } catch (_) {} });
window.addEventListener('unhandledrejection', (ev) => { try { console.error('[rejection] ' + (ev.reason && ev.reason.message || ev.reason)); } catch (_) {} });
const $ = (sel) => document.querySelector(sel);
/* 本地存储读写（桌面版补齐，供自定义表情等使用） */
function load(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (_) { return def; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
const C = window.chatUSB;

const state = {
  profile: null,
  rooms: [],
  currentRoom: null,
  avatarUrl: null,   // 上传的头像图片(dataUrl)，未上传则为 null
  peerAvatars: {},  // 好友头像缓存 uid -> dataUrl
  conn: { state: 'disconnected', mode: 'wan' },
  peers: new Map(),
  msgs: [],            // 当前房间内存消息（新→旧）
  loadedCount: 0,
  totalCount: 0,
  recorder: null,
  recording: false,
  lanHosting: false,
  lanUrl: '',
  registeredAccount: '',   // 登录账号（QQ邮箱/手机号）
  unlocked: false,
  autoLock: false,         // 失焦自动锁定
  lockTimer: null,
  friends: [],             // 好友列表
  friendOnline: {},        // 好友在线状态 id -> true/false
  unread: {},              // 未读私聊计数 id -> n
  notices: [],             // 好友申请通知
  dnd: false,              // 离线模式（静音免打扰）：只接收消息、不响铃不弹通知
};

/* ---------------- 工具 ---------------- */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = (t) => new Date(t).toDateString();
  if (y(ts) === y(today)) return '今天';
  const yest = new Date(today.getTime() - 86400000);
  if (y(ts) === y(yest)) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function toast(text, ms) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms || 2200);
}
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* 生成正方形缩略图（用于同步给好友，小图省流量） */
function makeThumb(dataUrl, size, cb) {
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      const g = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      cb(c.toDataURL('image/png'));
    } catch { cb(null); }
  };
  img.onerror = () => cb(null);
  img.src = dataUrl;
}

/* ---------------- 主题与背景（调色盘 + 背景文件夹） ---------------- */
const PRESETS = [
  { id: 'clean',  name: '极简白', accent: '#3370ff', softL: '#e8f0ff', softD: '#26324b', bubble: '#95ec69' },
  { id: 'blue',   name: '经典蓝', accent: '#1e6fff', softL: '#e5efff', softD: '#22314b', bubble: '#7fd0ff' },
  { id: 'sea',    name: '地海蔚蓝', accent: '#0fa3a5', softL: '#e0f5f5', softD: '#17373a', bubble: '#7de3de' },
  { id: 'sakura', name: '樱语红粉', accent: '#e0567b', softL: '#ffe8ef', softD: '#4a2330', bubble: '#ff9ab6' },
  { id: 'gold',   name: '典雅金', accent: '#b58a3c', softL: '#f6ecd6', softD: '#3a3320', bubble: '#e3c878' },
  { id: 'lilac',  name: '丁香紫', accent: '#8b5cf6', softL: '#efe9ff', softD: '#2b2444', bubble: '#c7a7ff' },
  { id: 'green',  name: '芸豆青', accent: '#3a9d5b', softL: '#e3f5e9', softD: '#1d3a28', bubble: '#8fdcae' },
  { id: 'red',    name: '辰砂色', accent: '#c03a2b', softL: '#ffe8e3', softD: '#48201c', bubble: '#ff9a8a' }
];
function hexToRgba(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }

function applyAppearance() {
  const dark = state.profile.theme === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const p = PRESETS.find(x => x.id === state.profile.accentPreset) || PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty('--accent', p.accent);
  root.style.setProperty('--accent-soft', dark ? p.softD : p.softL);
  root.style.setProperty('--bubble-self', p.bubble);
  root.style.setProperty('--bg-grad', `radial-gradient(1200px 800px at 18% 0%, ${hexToRgba(p.accent, dark ? 0.20 : 0.16)}, transparent 62%)`);
}
function applyTheme(theme) {
  state.profile.theme = theme;
  applyAppearance();
}
async function toggleTheme() {
  const t = state.profile.theme === 'dark' ? 'light' : 'dark';
  state.profile = await C.saveProfile({ theme: t });
  applyTheme(t);
  C.setTheme && C.setTheme(t);   // 同步系统标题栏（夜间模式整条变黑）
  $('#btn-theme').textContent = t === 'dark' ? '☀ 模式' : '🌓 模式';
}

/* 随机从背景文件夹选一张铺满窗口 */
async function applyBg() {
  const bg = await C.bgPick();
  const el = $('#bg-image');
  if (bg.none) { el.style.backgroundImage = 'none'; if ($('#bg-current')) $('#bg-current').textContent = '（未找到背景图）'; return; }
  el.style.backgroundImage = `url("${bg.dataUrl}")`;
  if ($('#bg-current')) $('#bg-current').textContent = bg.name + ' · 共 ' + bg.total + ' 张';
  return bg;
}

/* ---------------- 初始化 ---------------- */
async function init() {
  bindAccountScreen();
  bindUi();
  C.onEvent(handleEvent);
  const ac = await C.accountStatus();
  if (ac && ac.registered) {
    state.registeredAccount = ac.account;
    const prof = await C.getProfile();
    if (prof && prof.remember) await unlockApp();   // 勾了“记住登录”→ 直接进入；否则每次都要输密码
    else showAccountScreen(true, ac.account);
  }
  else showAccountScreen(false);
}

/* ---------------- 锁定（隐藏聊天内容） ---------------- */
function lockApp() {
  showAccountScreen(true, state.registeredAccount);
  toast('已锁定，输入密码解锁');
}
function startLockTimer() {
  clearTimeout(state.lockTimer);
  if (!state.autoLock) return;
  state.lockTimer = setTimeout(() => { if (!state.unlocked) return; lockApp(); }, 30000);
}
function clearLockTimer() { clearTimeout(state.lockTimer); }

/* ---------------- 账户登录门禁 ---------------- */
function showAccountScreen(registered, acct) {
  const sc = $('#login-screen');
  sc.classList.remove('hidden');
  $('#login-mode-register').style.display = registered ? 'none' : '';
  $('#login-mode-login').style.display = registered ? '' : 'none';
  if (registered) $('#lg-login-account').value = acct || '';
  if (!registered) { $('#lg-account').value = ''; $('#lg-pwd').value = ''; $('#lg-pwd2').value = ''; }
  $('#lg-error').textContent = '';
  sc.querySelector('input').focus();
}
function hideAccountScreen() { $('#login-screen').classList.add('hidden'); }
function lgerr(msg) { $('#lg-error').textContent = msg; }

function bindAccountScreen() {
  // 输账号时实时检测：账号已注册 → 自动切到密码登录界面；新账号 → 留在注册界面
  const regAccount = () => state.registeredAccount || '';
  $('#lg-account').addEventListener('input', () => {
    const v = $('#lg-account').value.trim();
    if (regAccount() && v && v === regAccount()) {
      $('#lg-login-account').value = v;
      $('#login-mode-register').style.display = 'none';
      $('#login-mode-login').style.display = '';
      toast('该账号已注册，请直接输入密码登录');
    }
  });
  $('#lg-login-account').addEventListener('input', () => {
    const v = $('#lg-login-account').value.trim();
    if (regAccount() && v && v !== regAccount()) {
      $('#lg-account').value = v;
      $('#login-mode-register').style.display = '';
      $('#login-mode-login').style.display = 'none';
    }
  });
  $('#lg-register-btn').addEventListener('click', async () => {
    const a = $('#lg-account').value.trim();
    const p = $('#lg-pwd').value;
    const p2 = $('#lg-pwd2').value;
    if (!a || !p) { lgerr('请填写账号和密码'); return; }
    if (p !== p2) { lgerr('两次输入的密码不一致'); return; }
    const r = await C.accountRegister(a, p);
    if (r && r.ok) { await C.saveProfile({ remember: $('#lg-remember').checked }); hideAccountScreen(); await unlockApp(); }
    else if (r && r.exists) {
      $('#lg-login-account').value = a;
      $('#login-mode-register').style.display = 'none';
      $('#login-mode-login').style.display = '';
      lgerr('该账号已注册，请直接输入密码登录');
    }
    else lgerr(r && r.err ? r.err : '注册失败');
  });
  $('#lg-login-btn').addEventListener('click', async () => {
    const a = $('#lg-login-account').value.trim();
    const p = $('#lg-login-pwd').value;
    if (!p) { lgerr('请输入密码'); return; }
    const r = await C.accountLogin(a, p);
    if (r && r.ok) { await C.saveProfile({ remember: $('#lg-remember').checked }); hideAccountScreen(); await unlockApp(); }
    else lgerr(r && r.err ? r.err : '登录失败');
  });
  $('#lg-reset').addEventListener('click', (e) => {
    e.preventDefault();
    if (confirm('重新设置账号会清除本 U 盘的登录账号，聊天数据不受影响。确定继续？')) {
      C.accountReset().then(() => showAccountScreen(false));
    }
  });
  const enter = (btn) => (e) => { if (e.key === 'Enter') btn.click(); };
  $('#lg-pwd').addEventListener('keydown', enter($('#lg-register-btn')));
  $('#lg-pwd2').addEventListener('keydown', enter($('#lg-register-btn')));
  $('#lg-login-pwd').addEventListener('keydown', enter($('#lg-login-btn')));
}

async function unlockApp() {
  state.unlocked = true;
  state.profile = await C.getProfile();
  state.autoLock = !!state.profile.autoLock;
  state.rooms = await C.getRooms();
  const avGet = await C.avatarGet();
  if (avGet && avGet.ok) state.avatarUrl = avGet.dataUrl;
  applyTheme(state.profile.theme);
  C.setTheme && C.setTheme(state.profile.theme);
  $('#btn-theme').textContent = state.profile.theme === 'dark' ? '☀ 模式' : '🌓 模式';
  renderMe();
  renderRooms();
  renderFriends();
  renderNotices();
  applyBg();

  const last = state.profile.lastRoom && state.rooms.find(r => r.id === state.profile.lastRoom);
  const target = last || state.rooms[0];
  if (target) selectRoom(target.id, true);
}

function renderMe() {
  const p = state.profile;
  const av = $('#me-avatar');
  if (state.avatarUrl) {
    av.style.backgroundImage = `url("${state.avatarUrl}")`;
    av.style.backgroundSize = 'cover'; av.style.backgroundPosition = 'center';
    av.textContent = '';
  } else {
    av.style.backgroundImage = 'none';
    av.style.background = p.avatarColor;
    av.textContent = p.avatarEmoji;
  }
  $('#me-name').textContent = p.nickname;
  $('#me-uid').textContent = '编号 ' + p.uid.slice(-8);
}

function renderRooms() {
  const list = $('#rooms-list');
  list.innerHTML = '';
  for (const r of state.rooms) {
    if (r.isChat) continue;   // 私聊房间只出现在好友列表
    const item = document.createElement('div');
    item.className = 'room-item' + (r.id === state.currentRoom ? ' active' : '');
    item.innerHTML = `
      <div class="r-name">${esc(r.name)}</div>
      <div class="r-id" title="房间号 ${esc(r.id)}">${esc(r.id.slice(-6))}</div>
      <button class="r-gear" title="房间设置">⚙</button>
      <button class="r-del" title="删除房间记录">✕</button>`;
    item.querySelector('.r-gear').addEventListener('click', (e) => { e.stopPropagation(); showRoomSettings(r.id); });
    item.querySelector('.r-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除「' + r.name + '」的房间记录？（U 盘上的聊天记录文件仍会保留）')) return;
      await C.deleteRoom(r.id);
      state.rooms = await C.getRooms();
      if (state.currentRoom === r.id) { state.currentRoom = null; await C.disconnect(); }
      renderRooms();
    });
    item.addEventListener('click', () => selectRoom(r.id, true));
    list.appendChild(item);
  }
}

/* ---------------- 好友 ---------------- */
async function renderFriends() {
  const list = $('#friends-list');
  const cnt = $('#friends-cnt');
  state.friends = await C.friendsList();
  cnt.textContent = state.friends.length ? ' ' + state.friends.length : '';
  list.innerHTML = '';
  if (!state.friends.length) {
    const empty = document.createElement('div');
    empty.className = 'friend-item empty';
    empty.textContent = '还没有好友，点下方添加';
    list.appendChild(empty);
    return;
  }
  for (const f of state.friends) {
    const item = document.createElement('div');
    item.className = 'friend-item' + (f.roomId === state.currentRoom ? ' active' : '');
    const peer = f.id;
    const online = !!state.friendOnline[peer];
    const unread = state.unread[peer] || 0;
    const av = state.peerAvatars[peer] || state.peerAvatars['u_' + peer];
    item.innerHTML = `
      <div class="f-av" ${av ? `style="background-image:url('${av}')"` : ''}>${esc((f.nickname || peer).slice(0, 1))}${online ? '<i class="f-dot" title="在线"></i>' : ''}</div>
      <div class="f-info"><div class="f-name">${esc(f.nickname)}</div><div class="f-id">${esc(peer)}</div></div>
      ${unread ? `<span class="f-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
      <button class="r-gear" title="备注 / 删除">⚙</button>`;
    item.querySelector('.r-gear').addEventListener('click', async (e) => {
      e.stopPropagation();
      showFriendMenu(f);
    });
    item.addEventListener('click', () => {
      if (state.unread[peer]) { state.unread[peer] = 0; renderFriends(); }
      selectRoom(f.roomId, true);
    });
    list.appendChild(item);
  }
}
/* 轻量更新单个好友的未读红点（消息频繁时避免整表重绘） */
function bumpUnread(peer) {
  state.unread[peer] = (state.unread[peer] || 0) + 1;
  const items = document.querySelectorAll('#friends-list .friend-item');
  for (const it of items) {
    const idEl = it.querySelector('.f-id');
    if (idEl && idEl.textContent === peer) {
      let b = it.querySelector('.f-unread');
      if (!b) { b = document.createElement('span'); b.className = 'f-unread'; it.appendChild(b); }
      const n = state.unread[peer]; b.textContent = n > 99 ? '99+' : n;
      break;
    }
  }
}
function showFriendMenu(f) {
  openModal(
    '好友：' + f.nickname,
    `
    <div class="form-row"><label>备注昵称</label><input type="text" id="fd-name" value="${esc(f.nickname)}"></div>
    <div class="tip">好友编号：${esc(f.id)}　进入私聊后可直接对话</div>
    `,
    `<button id="modal-cancel">取消</button><button id="modal-ok" class="primary">保存</button><button id="modal-rm" style="margin-left:auto;background:#f5573c;color:#fff">删除好友</button>`
  );
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-ok').addEventListener('click', async () => {
    await C.friendsRename(f.id, $('#fd-name').value.trim());
    closeModal(); renderFriends();
  });
  $('#modal-rm').addEventListener('click', async () => {
    if (!confirm('删除好友「' + f.nickname + '」？私聊房间记录保留在 U 盘。')) return;
    await C.friendsRemove(f.id);
    closeModal(); renderFriends();
  });
}
async function syncFriendFromMsg(m) {
  if (!m || !m.from || !m.from.uid) return;
  const pid = m.from.uid.slice(-8);
  const f = state.friends.find(x => x.id === pid);
  if (f && f.nickname !== (m.from.name || f.nickname)) {
    f.nickname = m.from.name || f.nickname;
    await C.friendsRename(pid, f.nickname);
    renderFriends();
  }
}
function showAddFriend() {
  openModal(
    '添加好友',
    `
    <div class="form-row"><label>对方编号（让对方在左下角「编号」处看到自己的编号）</label><input type="text" id="fd-peer" placeholder="例如 a1b2c3d4"></div>
    <div class="form-row"><label>验证留言（可选）</label><input type="text" id="fd-msg" placeholder="例如：我是 xx，加个好友"></div>
    <div class="tip">发出好友申请后，对方在「🔔 好友通知」里同意，你们就互为好友并开启私聊。</div>
    `,
    `<button id="modal-cancel">取消</button><button id="modal-ok" class="primary">发送申请</button>`
  );
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-ok').addEventListener('click', async () => {
    const pid = $('#fd-peer').value.trim();
    if (!pid) { toast('请输入对方编号'); return; }
    const r = await C.friendsRequest(pid, $('#fd-msg').value.trim());
    if (r && r.ok) {
      closeModal();
      renderNotices();
      toast('好友申请已发送，等待对方同意');
    } else toast(r && r.err ? r.err : '发送失败');
  });
}

/* ---------------- 好友通知 ---------------- */
async function renderNotices() {
  state.notices = await C.noticesList();
  const pending = state.notices.filter(n => n.status === 'pending').length;
  const b = $('#notices-badge');
  if (pending) { b.textContent = pending > 99 ? '99+' : pending; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}
function showNotices() {
  const rows = state.notices.slice().reverse().map(n => {
    const st = n.status === 'accepted' ? '<span class="n-ok">已同意</span>'
      : n.status === 'rejected' ? '<span class="n-no">已拒绝</span>'
      : '<span class="n-wait">等待验证</span>';
    const btns = (n.dir === 'in' && n.status === 'pending')
      ? `<div class="n-btns"><button class="n-agree" data-id="${esc(n.id)}">同意</button><button class="n-reject" data-id="${esc(n.id)}">拒绝</button></div>`
      : `<div class="n-meta">${n.dir === 'out' ? '我发出' : '收到'} · ${fmtDate(n.ts)} ${fmtTime(n.ts)}</div>`;
    return `<div class="n-row"><div class="n-head"><b>${esc(n.name)}</b><span class="n-id">${esc(n.peerId)}</span>${st}</div>
      <div class="n-msg">${esc(n.msg || '请求添加你为好友')}</div>${btns}</div>`;
  }).join('');
  openModal('好友通知', '<div class="modal-box-scroll">' + (rows || '<div class="tip">暂无好友通知</div>') + '</div>', `<button id="modal-cancel">关闭</button>`);
  $('#modal-cancel').addEventListener('click', closeModal);
  document.querySelectorAll('.n-agree').forEach(b => b.addEventListener('click', async () => {
    const r = await C.noticesStatus(b.dataset.id, 'accepted');
    renderNotices(); renderFriends();
    closeModal();
    toast(r && r.ok ? '已同意，互为好友' : (r && r.err ? r.err : '操作失败'));
  }));
  document.querySelectorAll('.n-reject').forEach(b => b.addEventListener('click', async () => {
    await C.noticesStatus(b.dataset.id, 'rejected');
    renderNotices(); closeModal(); toast('已拒绝');
  }));
}

async function selectRoom(roomId, needConnect) {
  if (state.currentRoom === roomId) return;
  // 切换房间：收起表情面板/转发条/转发弹窗，避免遮挡
  $('#emoji-panel').classList.add('hidden');
  $('#forward-bar').classList.add('hidden');
  $('#fwd-modal').classList.add('hidden');
  $('#search-bar').classList.add('hidden');
  if (state.currentRoom) localStorage.setItem('cu.draft.' + state.currentRoom, $('#input-text').value);
  state.currentRoom = roomId;
  state.roomToken = ++roomToken;
  lastMsgDate = '';
  state.msgs = [];
  state.loadedCount = 0;
  state.totalCount = 0;
  $('#messages').innerHTML = '';
  renderRooms();
  const room = state.rooms.find(r => r.id === roomId);
  $('#room-name').textContent = room ? room.name : roomId;
  state.totalCount = await C.historyCount(roomId);
  await loadMore();
  $('#input-text').value = localStorage.getItem('cu.draft.' + roomId) || '';
  if (needConnect) await C.connect(roomId);
  if (needConnect && state.avatarUrl) C.sendAvatar();
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function loadMore() {
  const tk = state.roomToken;
  if (state.loadedCount >= state.totalCount) return;
  const limit = 200;
  const older = await C.loadHistory(state.currentRoom, limit, state.loadedCount);
  if (tk !== state.roomToken) return;
  state.loadedCount += older.length;
  const div = $('#messages');
  const prevScroll = div.scrollHeight;
  for (const m of older) div.insertBefore(renderMsg(m), div.firstChild);
  div.scrollTop = div.scrollHeight - prevScroll;
  if (state.loadedCount < state.totalCount) {
    const btn = document.createElement('button');
    btn.className = 'load-more'; btn.textContent = '加载更多消息';
    btn.addEventListener('click', loadMore);
    div.insertBefore(btn, div.firstChild);
  }
}

/* ---------------- 消息渲染 ---------------- */
let lastMsgDate = '';
let roomToken = 0;   // 切房间令牌：防止过时的历史加载混入当前房间
function renderMsg(m) {
  if (m.type === 'system') {
    const s = document.createElement('div');
    s.className = 'sys-msg'; s.textContent = m.content;
    return s;
  }
  const wrap = document.createElement('div');
  const isSelf = m.from && m.from.uid === state.profile.uid;
  wrap.className = 'msg-row' + (isSelf ? ' self' : '');
  if (m.id) wrap.dataset.msgid = m.id;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.title = m.from && m.from.name || '';
  const uid = m.from && m.from.uid;
  if (isSelf && state.avatarUrl) {
    av.style.backgroundImage = 'url("' + state.avatarUrl + '")';
    av.style.backgroundSize = 'cover'; av.style.backgroundPosition = 'center';
  } else if (!isSelf && uid && state.peerAvatars[uid]) {
    av.style.backgroundImage = 'url("' + state.peerAvatars[uid] + '")';
    av.style.backgroundSize = 'cover'; av.style.backgroundPosition = 'center';
  } else {
    av.style.background = m.from && m.from.color || '#8a9099';
    av.textContent = m.from && m.from.emoji || '👤';
  }
  if (!isSelf && uid && !state.peerAvatars[uid]) {
    C.avatarGetPeer(uid).then(r => {
      if (r && r.ok) {
        state.peerAvatars[uid] = r.dataUrl;
        const e = wrap.querySelector('.avatar');
        if (e) { e.style.backgroundImage = 'url("' + r.dataUrl + '")'; e.style.backgroundSize = 'cover'; e.style.backgroundPosition = 'center'; e.textContent = ''; }
      }
    });
  }
  const body = document.createElement('div');
  body.className = 'msg-body';
  const name = document.createElement('div');
  name.className = 'msg-name';
  name.textContent = isSelf ? '我' : (m.from && m.from.name || '未知用户');
  body.appendChild(name);
  if (m.reply && m.reply.name) {
    const rp = document.createElement('div'); rp.className = 'msg-reply';
    rp.textContent = '↩ 回复 ' + m.reply.name + '：' + (m.reply.text || '');
    rp.addEventListener('click', () => jumpToMessage(m.reply.id));
    body.appendChild(rp);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.type === 'text') {
    bubble.textContent = m.content;
  } else if (m.type === 'image') {
    const img = document.createElement('img');
    img.className = 'img-preview';
    img.alt = m.file ? m.file.name : '图片';
    if (m.file && m.file.path) {
      C.fileDataUrl(m.file.path).then(url => { if (url) { img.src = url; img.classList.remove('img-preview'); } else img.alt = '图片文件缺失'; });
    } else if (m.content) img.src = 'data:image/png;base64,' + m.content;
    img.addEventListener('click', () => { if (img.src && img.src.startsWith('data:image')) { const w = window.open(); w.document.write(`<img src="${img.src}" style="max-width:100vw">`); } });
    bubble.appendChild(img);
  } else if (m.type === 'voice') {
    bubble.innerHTML = `<div class="voice-row"><span class="v-icon">🎤</span><div class="v-bar"><div class="v-fill"></div></div><span class="v-dur">${m.duration ? m.duration + '″' : ''}</span></div>`;
    const audio = document.createElement('audio');
    audio.controls = false;
    audio.preload = 'none';
    if (m.file && m.file.path) C.fileDataUrl(m.file.path).then(url => { if (url) audio.src = url; });
    audio.addEventListener('loadedmetadata', () => {});
    bubble.querySelector('.voice-row').addEventListener('click', () => {
      if (!audio.src) { toast('语音文件缺失'); return; }
      if (!audio.paused) { audio.pause(); audio.currentTime = 0; }
      else audio.play();
    });
    audio.addEventListener('timeupdate', () => {
      const fill = bubble.querySelector('.v-fill');
      if (fill && audio.duration) fill.style.width = (100 - (audio.currentTime / audio.duration) * 100) + '%';
    });
    bubble.appendChild(audio);
    if (m.transcript) { const td=document.createElement('div'); td.className='v-trans'; td.textContent=m.transcript; bubble.appendChild(td); }
  } else if (m.type === 'file') {
    bubble.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'file-card';
    const ext = (m.file && m.file.name || '').split('.').pop().toLowerCase() || 'file';
    const icon = ['png','jpg','jpeg','gif','webp'].includes(ext) ? '🖼' : ['mp3','wav','ogg','webm'].includes(ext) ? '🎵' : ['zip','rar','7z'].includes(ext) ? '🗜' : ['pdf'].includes(ext) ? '📕' : ['doc','docx'].includes(ext) ? '📘' : ['xls','xlsx'].includes(ext) ? '📗' : '📄';
    card.innerHTML = `<span class="f-icon">${icon}</span><div><div class="f-name">${esc(m.file ? m.file.name : '文件')}</div><div class="f-size">${m.file ? fmtSize(m.file.size) : ''} · ${isSelf ? '已保存到U盘' : '点击保存'}</div></div><span class="f-op">保存</span>`;
    card.addEventListener('click', async () => {
      if (!m.file || !m.file.path) return;
      const r = await C.saveFileDialog(m.file.path, m.file.name);
      if (r.ok) toast('已保存：' + r.path);
    });
    bubble.appendChild(card);
  }
  if (m.recalled) { bubble.innerHTML=''; bubble.textContent='[消息已撤回]'; }
  body.appendChild(bubble);
  if (isSelf && m.id && m.type !== 'system') {
    wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); recallMsg(m.id); });
  } else if (!isSelf && m.id && m.type === 'text' && !m.recalled) {
    wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      state.pendingReply = { id: m.id, name: (m.from && m.from.name) || '对方', text: String(m.content || '').slice(0, 50) };
      $('#input-text').value = (state.pendingReply.name ? '回复 @' + state.pendingReply.name + '：' : '') + $('#input-text').value;
      $('#input-text').focus();
      toast('已引用，输入内容后发送即回复');
    });
  }

  const time = document.createElement('div');
  time.className = 'msg-time'; time.textContent = fmtTime(m.ts);
  body.appendChild(time);
  // 多选转发：进入多选模式后，点击消息勾选
  if (m.id && m.type !== 'system') {
    wrap.addEventListener('click', (e) => {
      if (!state.multiSel || e.target.closest('a')) return;
      const s = state.multiSel;
      if (s.roomId !== state.currentRoom) return;
      if (s.sel.has(m.id)) { s.sel.delete(m.id); s.msgs.delete(m.id); wrap.classList.remove('sel'); }
      else { s.sel.add(m.id); s.msgs.set(m.id, m); wrap.classList.add('sel'); }
      $('#fwd-count').textContent = '已选 ' + s.sel.size + ' 条';
      $('#forward-bar').classList.remove('hidden');
    });
  }
  wrap.appendChild(av);
  wrap.appendChild(body);
  return wrap;
}

let _notifyCtx = null;
function playNotifySound() {
  try {
    if (!_notifyCtx) _notifyCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = _notifyCtx.createOscillator(), g = _notifyCtx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    o.connect(g); g.connect(_notifyCtx.destination);
    g.gain.setValueAtTime(0.001, _notifyCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, _notifyCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, _notifyCtx.currentTime + 0.25);
    o.start(); o.stop(_notifyCtx.currentTime + 0.3);
  } catch (e) {}
}
function recallMsg(id) {
  if (!confirm('撤回这条消息？对方将看到“消息已撤回”。')) return;
  C.recall(state.currentRoom, id).then(r => {
    if (r && r.ok) {
      const n = document.querySelector('#messages .msg-row[data-msgid="' + CSS.escape(id) + '"]');
      if (n) { const b = n.querySelector('.bubble'); if (b) { b.innerHTML = ''; b.textContent = '[消息已撤回]'; } }
      toast('已撤回');
    } else toast((r && r.err) || '撤回失败');
  });
}
function appendMsg(m) {
  // 只显示当前房间的消息；旧房间晚到/在途的消息直接丢弃，避免串房
  if (m.roomId && state.currentRoom && m.roomId !== state.currentRoom) {
    // 不在当前房间时，若是好友私聊消息 → 累计未读红点
    const fr = state.friends.find(f => f.roomId === m.roomId);
    if (fr && m.type !== 'system') bumpUnread(fr.id);
    return;
  }
  const div = $('#messages');
  const dateSep = fmtDate(m.ts);
  if (dateSep !== lastMsgDate) {
    lastMsgDate = dateSep;
    const sep = document.createElement('div');
    sep.className = 'date-sep'; sep.textContent = dateSep;
    div.appendChild(sep);
  }
  const node = renderMsg(m);
  div.appendChild(node);
  const atBottom = div.scrollHeight - div.scrollTop - div.clientHeight < 120;
  if (atBottom) div.scrollTop = div.scrollHeight;
  // 新消息红点：窗口失焦时闪烁标题
  if (!document.hasFocus() && m.type !== 'system') {
    document.title = '● 新消息';
    setTimeout(() => { document.title = 'ChatUSB 便携聊天'; }, 4000);
  }
}

/* ---------------- 事件处理 ---------------- */
function handleEvent(ev) {
  switch (ev.type) {
    case 'conn':
      state.conn = { state: ev.state, mode: ev.mode };
      const el = $('#conn-state');
      el.className = ev.state;
      el.lastChild.textContent = ev.state === 'connected' ? '已连接' : ev.state === 'connecting' ? '连接中…' : '未连接';
      $('#btn-lan').classList.toggle('active', ev.mode === 'lan');
      $('#btn-lan').textContent = ev.mode === 'lan' ? '🛑 局域网' : '📡 局域网';
      break;
    case 'message':
      appendMsg(ev.msg);
      syncFriendFromMsg(ev.msg);   // 私聊时同步好友昵称
      // @提醒：被@时给提示
      if (ev.msg.mention && ev.msg.mention.indexOf(state.profile.uid) >= 0) {
        const an = (ev.msg.from && ev.msg.from.name) || '有人';
        toast('「' + an + '」@了你：' + String(ev.msg.content || '').slice(0, 20));
      }
      // 消息提醒：非自己的消息，可关（设置里）。弹窗仅窗口未聚焦时；声音始终可关
      // 离线模式（免打扰）：只接收消息，不响铃、不弹系统通知
      if (!state.dnd && ev.msg.type !== 'system' && ev.msg.from && ev.msg.from.uid !== state.profile.uid) {
        const soundOn = state.profile.sound !== false;
        const preview = ev.msg.type === 'text' ? ev.msg.content
          : ev.msg.type === 'image' ? '[图片]'
          : ev.msg.type === 'voice' ? '[语音]'
          : ev.msg.type === 'file' ? '[文件]' : '';
        if (soundOn) playNotifySound();
        if (!document.hasFocus() && state.profile.notify !== false && soundOn) C.notify(ev.msg.from.name || '新消息', preview);
      }
      break;
    case 'dnd':
      state.dnd = !!ev.on;
      const _dndEl = $('#dnd-badge');
      if (_dndEl) { _dndEl.classList.toggle('hidden', !state.dnd); if (state.dnd) _dndEl.textContent = '🌙 离线模式 · 静音'; }
      break;
    case 'recall':
      if (ev.roomId && state.currentRoom && ev.roomId !== state.currentRoom) break;
      const rnode = document.querySelector('#messages .msg-row[data-msgid="' + CSS.escape(ev.targetId) + '"]');
      if (rnode) { const rb = rnode.querySelector('.bubble'); if (rb) { rb.innerHTML = ''; rb.textContent = '[消息已撤回]'; } }
      break;
    case 'system':
      appendMsg({ type: 'system', content: ev.text, ts: Date.now() });
      break;
    case 'presence':
      state.peers.clear();
      for (const p of ev.peers) state.peers.set(p.uid, p);
      const n = state.peers.size;
      $('#online-count').textContent = n > 0 ? `在线 ${n} 人` : '';
      break;
    case 'avatar':
      // 收到好友头像：缓存 + 存 U 盘，下次重启也还有
      state.peerAvatars[ev.uid] = ev.avatar;
      C.avatarSavePeer(ev.uid, ev.avatar);
      appendMsg({ type: 'system', content: ev.name ? `「${ev.name}」更新了头像` : '对方更新了头像', ts: Date.now() });
      break;
    case 'friend-notice':
      renderNotices();
      if (ev.notice && ev.notice.dir === 'in' && ev.notice.status === 'pending') {
        toast('🔔 「' + ev.notice.name + '」请求加你为好友');
      }
      if (ev.notice && ev.notice.status === 'accepted') renderFriends();
      break;
    case 'friend-added':
      renderFriends();
      break;
    case 'friend-presence':
      state.friendOnline[ev.id] = ev.online;
      if (ev.online) toast('🟢 「' + ev.name + '」上线了');
      renderFriends();
      break;
    case 'lan':
      state.lanHosting = true;
      state.lanUrl = ev.lanUrl;
      break;
    case 'menu-toggle-theme':
      toggleTheme();
      break;
    case 'menu-join':
      showRoomModal();
      break;
    case 'win-max':
      $('#tb-max').textContent = ev.value ? '❐' : '□';
      break;
    case 'toggle-theme-shortcut':
      state.profile.theme = ev.theme;
      applyTheme(ev.theme);
      $('#btn-theme').textContent = ev.theme === 'dark' ? '☀ 模式' : '🌓 模式';
      break;
    case 'log':
      toast(ev.text, 3200);
      break;
  }
}

/* ---------------- 发送 ---------------- */
function sendText() {
  const input = $('#input-text');
  const t = input.value;
  if (!t.trim()) return;
  const opts = {};
  if (state.pendingReply) opts.reply = state.pendingReply;
  const mentions = [];
  state.peers.forEach((p, uid) => { if (t.indexOf('@' + p.name) >= 0) mentions.push(uid); });
  if (mentions.length) opts.mention = mentions;
  C.sendText(state.currentRoom, t, opts).then(r => {
    if (r.ok) { input.value = ''; localStorage.removeItem('cu.draft.' + state.currentRoom); state.pendingReply = null; }
    else toast(r.err);
  });
}

async function sendFiles(files) {
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const r = await C.sendFile(state.currentRoom, buf, f.name, f.type);
    if (!r.ok) toast(r.err);
  }
}

/* ---------------- 语音（按住说话） ---------------- */
let pcmCtx=null,pcmNodes=[],pcmData=[],pcmRate=48000,pcmResolve=null;
function startPcmCapture(stream){
  pcmData=[];
  pcmCtx=new (window.AudioContext||window.webkitAudioContext)();
  pcmRate=pcmCtx.sampleRate||48000;
  const src=pcmCtx.createMediaStreamSource(stream);
  const gain=pcmCtx.createGain(); gain.gain.value=0;
  const proc=pcmCtx.createScriptProcessor(4096,1,1);
  proc.onaudioprocess=e=>{ pcmData.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(proc); proc.connect(gain); gain.connect(pcmCtx.destination);
  pcmNodes=[src,proc,gain];
  return new Promise(resolve=>{ pcmResolve=resolve; });
}
function stopPcmCapture(){
  try{
    if(pcmResolve){
      let raw=new Float32Array(0);
      if(pcmData.length){ const len=pcmData.reduce((s,a)=>s+a.length,0); raw=new Float32Array(len); let o=0; for(const a of pcmData){ raw.set(a,o); o+=a.length; } }
      pcmResolve(resample(raw,pcmRate,16000)); pcmResolve=null;
    }
    pcmNodes.forEach(n=>{ try{n.disconnect();}catch(e){} }); pcmNodes=[];
    if(pcmCtx){ try{pcmCtx.close();}catch(e){} pcmCtx=null; }
  }catch(e){}
}
function resample(input,inRate,outRate){
  if(input.length===0||inRate===outRate) return input;
  const ratio=inRate/outRate;
  const outLen=Math.round(input.length/ratio);
  const out=new Float32Array(outLen);
  for(let i=0;i<outLen;i++){ const pos=i*ratio; const i0=Math.floor(pos); const i1=Math.min(i0+1,input.length-1); const frac=pos-i0; out[i]=input[i0]*(1-frac)+input[i1]*frac; }
  return out;
}
async function startVoice() {
  if (state.recording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    const chunks = [];
    const t0 = Date.now();
    const pcmPromise = startPcmCapture(stream);
    state.recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    state.recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      stopPcmCapture();
      const dur = Math.max(1, Math.round((Date.now() - t0) / 1000));
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size > 0) {
        const buf = await blob.arrayBuffer();
        // 本地语音转字幕（Whisper，离线）
        let text = '';
        try { const pcm = await pcmPromise; if (pcm && pcm.length > 0) text = (await C.transcribe(pcm, 16000)) || ''; } catch (e) { text = ''; }
        if (text) toast('字幕：' + text.slice(0, 30));
        const r = await C.sendVoice(state.currentRoom, buf, dur, text);
        if (!r.ok) toast(r.err);
      }
    };
    state.recorder.start();
    state.recording = true;
    const btn = $('#btn-voice');
    btn.classList.add('recording');
    btn.textContent = '⏺';
    toast('录音中… 松开手指发送（自动转字幕）');
  } catch {
    toast('无法访问麦克风（请在系统设置中允许麦克风权限）');
  }
}
function stopVoice() {
  if (!state.recording) return;
  state.recording = false;
  try { state.recorder.stop(); } catch {}
  const btn = $('#btn-voice');
  btn.classList.remove('recording');
  btn.textContent = '🎤';
}

/* ---------------- 弹窗 ---------------- */
function openModal(title, bodyHtml, actionsHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-actions').innerHTML = actionsHtml;
  $('#modal-mask').classList.remove('hidden');
}
function closeModal() { $('#modal-mask').classList.add('hidden'); }

function showSettings() {
  const p = state.profile;
  const colors = ['#3370ff', '#00b42a', '#f53f3f', '#ff7d00', '#722ed1', '#14c9c9', '#f759ab', '#2f3542'];
  const curPreset = (p.accentPreset || 'clean');
  let pendingAvatar = null;   // 本次待上传头像 {dataUrl, thumb}；'__CLEAR__' 表示还原默认
  const avatarPreviewSrc = () => pendingAvatar === '__CLEAR__' ? null : (pendingAvatar ? pendingAvatar.dataUrl : state.avatarUrl);
  const renderAvatarPreview = () => {
    const el = $('#set-avatar-prev');
    const src = avatarPreviewSrc();
    if (src) { el.style.backgroundImage = 'url("' + src + '")'; el.textContent = ''; }
    else { el.style.backgroundImage = 'none'; el.style.background = p.avatarColor; el.textContent = p.avatarEmoji; }
  };
  openModal(
    '账号与设置',
    `
    <div class="form-row"><label>昵称（自定义账号名）</label><input type="text" id="set-name" value="${esc(p.nickname)}"></div>
    <div class="form-row"><label>头像（上传图片，存 U 盘 data/avatars）</label>
      <div class="avatar-upload">
        <div class="avatar-prev" id="set-avatar-prev" title="当前头像"></div>
        <button id="btn-avatar-up" type="button">📷 上传图片</button>
        <button id="btn-avatar-clear" type="button">还原默认</button>
        <input type="file" id="set-avatar-file" accept="image/*" style="display:none">
      </div>
    </div>
    <div class="form-row"><label>头像表情</label><input type="text" id="set-emoji" value="${esc(p.avatarEmoji)}" maxlength="4" style="width:80px"></div>
    <div class="form-row"><label>头像颜色</label><div class="color-pick" id="set-colors">${colors.map(c => `<div class="swatch ${c === p.avatarColor ? 'sel' : ''}" data-c="${c}" style="background:${c}"></div>`).join('')}</div></div>
    <div class="form-row"><label>背景图（data\\backgrounds 文件夹，自动随机一张）</label>
      <div class="bg-row"><span id="bg-current">…</span>
        <button id="btn-bg-open" type="button">📂 打开文件夹</button>
        <button id="btn-bg-next" type="button">🎲 换一张</button>
      </div>
    </div>
    <div class="form-row"><label>界面配色（调色盘）</label><div class="color-pick" id="set-presets">${PRESETS.map(x => `<div class="swatch preset ${x.id === curPreset ? 'sel' : ''}" data-p="${x.id}" title="${x.name}" style="background:${x.accent}"></div>`).join('')}</div></div>
    <div class="form-row"><label>公共消息服务地址（默认公共中转，可改为自建 MQTT 服务）</label><input type="text" id="set-broker" value="${esc(p.brokers[0])}"></div>
    <div class="form-row"><label>账号服务器地址（填了则同一账号在所有U盘通用，如 http://电脑IP:3722；留空=每个U盘独立账号）</label><input type="text" id="set-account-server" value="${esc(p.accountServer || '')}" placeholder="留空则各U盘独立账号"></div>
    <div class="form-row"><label>修改登录密码（账号 ${esc(state.registeredAccount || '')}）</label>
      <div class="avatar-upload" style="width:100%">
        <input type="password" id="set-oldpwd" placeholder="原密码" style="flex:1;min-width:90px">
        <input type="password" id="set-newpwd" placeholder="新密码（至少 6 位）" style="flex:1;min-width:120px">
        <button id="btn-pwd-save" type="button">改密</button>
      </div>
    </div>
    <div class="form-row"><label class="lock-row"><input type="checkbox" id="set-autolock" ${p.autoLock ? 'checked' : ''}> 离开自动锁定（窗口失焦 30 秒后自动锁屏，需重新输入密码）</label></div>
    <div class="form-row"><label class="lock-row"><input type="checkbox" id="set-notify" ${p.notify !== false ? 'checked' : ''}> 新消息弹窗提醒（窗口未聚焦时）</label></div>
    <div class="form-row"><label class="lock-row"><input type="checkbox" id="set-sound" ${p.sound !== false ? 'checked' : ''}> 新消息提示音</label></div>
    <div class="form-row"><label class="lock-row"><input type="checkbox" id="set-dnd" ${p.dndOnMinimize !== false ? 'checked' : ''}> 最小化 / 关闭时进入离线模式（静音不提醒，缩到托盘；消息照常接收）</label></div>
    <div class="form-row"><label>数据目录（U 盘上的存储位置）</label><input type="text" value="${esc(p.dataDir || '程序目录/data')}" disabled></div>
    `,
    `<button id="modal-cancel">取消</button><button id="modal-ok" class="primary">保存</button>`
  );
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#btn-pwd-save').addEventListener('click', async () => {
    const op = $('#set-oldpwd').value, np = $('#set-newpwd').value;
    if (!op || !np) { toast('请填写原密码和新密码'); return; }
    const r = await C.accountChangePwd(op, np);
    toast(r && r.ok ? '密码已修改' : (r.err || '修改失败'));
    if (r && r.ok) { $('#set-oldpwd').value = ''; $('#set-newpwd').value = ''; }
  });
  $('#modal-ok').addEventListener('click', async () => {
    const color = document.querySelector('#set-colors .swatch.sel');
    const psel = document.querySelector('#set-presets .swatch.sel');
    const brokers = $('#set-broker').value.trim() ? [$('#set-broker').value.trim()] : undefined;
    state.autoLock = $('#set-autolock').checked;
    if (pendingAvatar === '__CLEAR__') { const r = await C.avatarClear(); if (r && r.ok) state.avatarUrl = null; }
    else if (pendingAvatar) { const r = await C.avatarSet({ dataUrl: pendingAvatar.dataUrl, thumb: pendingAvatar.thumb }); if (r && r.ok) state.avatarUrl = r.dataUrl; }
    if (state.currentRoom && pendingAvatar) C.sendAvatar();   // 同步头像给好友
    state.profile = await C.saveProfile({
      nickname: $('#set-name').value.trim() || p.nickname,
      avatarEmoji: $('#set-emoji').value.trim() || p.avatarEmoji,
      avatarColor: color ? color.dataset.c : p.avatarColor,
      accentPreset: psel ? psel.dataset.p : (p.accentPreset || 'clean'),
      brokers,
      accountServer: $('#set-account-server').value.trim(),
      autoLock: state.autoLock,
      notify: $('#set-notify').checked,
      sound: $('#set-sound').checked,
      dndOnMinimize: $('#set-dnd').checked
    });
    applyAppearance();
    renderMe();
    closeModal();
    toast('已保存');
  });
  $('#set-colors').addEventListener('click', (e) => {
    const s = e.target.closest('.swatch');
    if (!s) return;
    document.querySelectorAll('#set-colors .swatch').forEach(x => x.classList.remove('sel'));
    s.classList.add('sel');
  });
  $('#set-presets').addEventListener('click', (e) => {
    const s = e.target.closest('.swatch.preset');
    if (!s) return;
    document.querySelectorAll('#set-presets .swatch').forEach(x => x.classList.remove('sel'));
    s.classList.add('sel');
    state.profile.accentPreset = s.dataset.p;   // 预览
    applyAppearance();
  });
  $('#btn-bg-open').addEventListener('click', () => C.bgOpen());
  $('#btn-bg-next').addEventListener('click', async () => { await applyBg(); toast('已随机换背景'); });
  // 头像上传 / 还原
  $('#btn-avatar-up').addEventListener('click', () => $('#set-avatar-file').click());
  $('#set-avatar-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) { toast('图片不能超过 3MB'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      const dataUrl = rd.result;
      makeThumb(dataUrl, 512, (sq) => {
        if (!sq) { toast('图片处理失败，请换一张'); return; }
        makeThumb(dataUrl, 160, (thumb) => {
          pendingAvatar = { dataUrl: sq, thumb };
          renderAvatarPreview();
          toast('已选择头像，点「保存」生效');
        });
      });
    };
    rd.readAsDataURL(f);
    e.target.value = '';
  });
  $('#btn-avatar-clear').addEventListener('click', () => { pendingAvatar = '__CLEAR__'; renderAvatarPreview(); });
  renderAvatarPreview();
  applyBg();
}

function showRoomModal() {
  openModal(
    '加入 / 创建房间',
    `
    <div class="modal-tabs">
      <button id="tab-join" class="active">加入房间</button>
      <button id="tab-create">创建房间</button>
    </div>
    <div id="room-form">
      <div class="form-row"><label>房间号（向朋友分享此编号即可加入）</label><input type="text" id="room-id" placeholder="例如 R7F3A2B1"></div>
      <div class="form-row"><label>房间密码（可选，双方需使用相同密码）</label><input type="password" id="room-pwd" placeholder="不填则为公开房间"></div>
      <div class="form-row" id="room-name-row" style="display:none"><label>房间名称</label><input type="text" id="room-name" placeholder="例如：好友聊天"></div>
    </div>
    <div class="tip">房间号 + 密码相同的人才能互聊；不同网络（不同 Wi-Fi / 4G / 跨城市）均可连接。</div>
    `,
    `<button id="modal-cancel">取消</button><button id="modal-ok" class="primary">确定</button>`
  );
  $('#modal-cancel').addEventListener('click', closeModal);
  const mode = { join: true };
  $('#tab-join').addEventListener('click', () => {
    mode.join = true;
    $('#tab-join').classList.add('active'); $('#tab-create').classList.remove('active');
    $('#room-name-row').style.display = 'none';
    $('#room-id').placeholder = '例如 R7F3A2B1';
  });
  $('#tab-create').addEventListener('click', () => {
    mode.join = false;
    $('#tab-create').classList.add('active'); $('#tab-join').classList.remove('active');
    $('#room-name-row').style.display = '';
    $('#room-id').placeholder = '留空自动生成';
  });
  $('#modal-ok').addEventListener('click', async () => {
    const pwd = $('#room-pwd').value;
    let room;
    if (mode.join) {
      const r = await C.joinRoom($('#room-id').value, pwd);
      if (!r.ok) { toast(r.err); return; }
      room = r.room;
    } else {
      room = await C.createRoom($('#room-name').value, pwd);
    }
    state.rooms = await C.getRooms();
    renderRooms();
    closeModal();
    state.currentRoom = null;
    await selectRoom(room.id, true);
    toast('房间「' + room.name + '」房间号 ' + room.id);
  });
}

function showRoomSettings(roomId) {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return;
  openModal(
    '房间设置',
    `
    <div class="form-row"><label>房间号（固定，分享给朋友加入）</label><input type="text" value="${esc(room.id)}" disabled></div>
    <div class="form-row"><label>房间名称（显示用，不影响房间号）</label><input type="text" id="rs-name" value="${esc(room.name)}" placeholder="例如：好友聊天"></div>
    <div class="form-row"><label>房间密码</label><input type="password" id="rs-pwd" value="${esc(room.password)}" placeholder="留空=公开房间"><div class="tip">改密码会重新生成加密密钥，双方必须改成相同密码才能继续互聊；本 U 盘上该房间的旧聊天记录将无法解密并被清空。</div></div>
    `,
    `<button id="modal-cancel">取消</button><button id="modal-ok" class="primary">保存</button>`
  );
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-ok').addEventListener('click', async () => {
    const name = $('#rs-name').value.trim() || room.name;
    const pwd = $('#rs-pwd').value;
    const pwdChanged = pwd !== (room.password || '');
    if (pwdChanged && !confirm('密码改变后，双方须改成相同密码才能继续互聊；本 U 盘上该房间的旧聊天记录将被清空。继续吗？')) return;
    const r = await C.updateRoom(roomId, { name, password: pwd });
    if (!r || !r.ok) { toast((r && r.err) || '保存失败'); return; }
    state.rooms = await C.getRooms();
    if (r.pwdChanged && state.currentRoom === roomId) {
      state.msgs = []; state.loadedCount = 0; state.totalCount = 0;
      $('#messages').innerHTML = '';
      await C.connect(roomId);   // 重连，按新密码重新派生密钥
    }
    renderRooms();
    if (state.currentRoom === roomId) {
      const rr = state.rooms.find(x => x.id === roomId);
      $('#room-name').textContent = rr ? rr.name : roomId;
    }
    closeModal();
    toast(r.nameChanged && r.pwdChanged ? '已保存（房间名与密码已更新）' : (r.pwdChanged ? '密码已更新，请告知对方改同一密码' : '已保存'));
  });
}

function showLanModal() {
  openModal(
    '局域网直连模式',
    `
    <div class="modal-tabs">
      <button id="tab-host" class="active">我是主机</button>
      <button id="tab-joinlan">加入主机</button>
    </div>
    <div id="lan-form">
      <div class="form-row"><label>房间号</label><input type="text" id="lan-room-id" value="${esc(state.currentRoom || '')}"></div>
      <div class="form-row"><label>房间密码（可选）</label><input type="password" id="lan-room-pwd"></div>
      <div class="form-row" id="lan-host-info" style="display:none">
        <label>把下面地址发给同一局域网的朋友，对方选择「加入主机」粘贴即可：</label>
        <div id="lan-info">启动后显示…</div>
      </div>
      <div class="form-row" id="lan-join-row" style="display:none"><label>主机地址</label><input type="text" id="lan-url" placeholder="ws://192.168.1.100:3721"></div>
    </div>
    <div class="tip">局域网模式：同一 Wi-Fi/网线下直接点对点连接，大文件传输无限制，不经过公共服务。</div>
    `,
    `<button id="modal-cancel">取消</button><button id="modal-ok" class="primary">连接</button>`
  );
  $('#modal-cancel').addEventListener('click', closeModal);
  const mode = { host: true };
  $('#tab-host').addEventListener('click', () => {
    mode.host = true;
    $('#tab-host').classList.add('active'); $('#tab-joinlan').classList.remove('active');
    $('#lan-host-info').style.display = 'none'; $('#lan-join-row').style.display = 'none';
  });
  $('#tab-joinlan').addEventListener('click', () => {
    mode.host = false;
    $('#tab-joinlan').classList.add('active'); $('#tab-host').classList.remove('active');
    $('#lan-host-info').style.display = 'none'; $('#lan-join-row').style.display = '';
  });
  $('#modal-ok').addEventListener('click', async () => {
    const roomId = $('#lan-room-id').value.trim();
    if (!roomId) { toast('请输入房间号'); return; }
    if (mode.host) {
      const r = await C.lanHost(roomId);
      if (r.ok) {
        $('#lan-host-info').style.display = '';
        $('#lan-info').textContent = r.lanUrl;
        state.lanHosting = true;
        closeModal();
        toast('已开启局域网主机：' + r.lanUrl);
      }
    } else {
      const r = await C.lanJoin(roomId, $('#lan-url').value.trim());
      if (r.ok) { closeModal(); toast('已连接局域网主机'); }
    }
  });
}

/* ---------------- 事件绑定 ---------------- */
function bindUi() {
  /* 自定义标题栏 */
  $('#tb-lock').addEventListener('click', lockApp);
  $('#tb-min').addEventListener('click', () => C.minimizeWindow());
  $('#tb-max').addEventListener('click', () => C.maximizeToggle());
  $('#tb-close').addEventListener('click', () => C.closeWindow());
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('#tb-controls')) return;
    C.maximizeToggle();
  });
  C.isMaximized().then((m) => { $('#tb-max').textContent = m ? '❐' : '□'; });

  /* 离开自动锁定（失焦 30 秒） */
  window.addEventListener('blur', startLockTimer);
  window.addEventListener('focus', clearLockTimer);

  $('#btn-shot').addEventListener('click', () => C.startScreenshot());
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-settings').addEventListener('click', showSettings);
  $('#btn-new-room').addEventListener('click', showRoomModal);
  $('#btn-add-friend').addEventListener('click', showAddFriend);
  $('#btn-notices').addEventListener('click', showNotices);
  $('#btn-lan').addEventListener('click', () => {
    if (state.conn.mode === 'lan') { C.disconnect(); $('#btn-lan').classList.remove('active'); toast('已退出局域网模式'); }
    else showLanModal();
  });

  $('#btn-send').addEventListener('click', sendText);
  // 多选转发
  state.multiSel = null;
  $('#btn-multi').addEventListener('click', () => {
    if (!state.currentRoom) { toast('请先加入房间'); return; }
    if (state.multiSel) { state.multiSel = null; $('#forward-bar').classList.add('hidden'); renderRooms(); }
    else { state.multiSel = { roomId: state.currentRoom, sel: new Set(), msgs: new Map() }; toast('点击消息勾选，选完点“转发…”'); }
    $('#btn-multi').classList.toggle('active', !!state.multiSel);
  });
  $('#btn-fwd-cancel').addEventListener('click', () => { state.multiSel = null; $('#forward-bar').classList.add('hidden'); $('#btn-multi').classList.remove('active'); renderRooms(); });
  $('#btn-fwd').addEventListener('click', () => {
    const s = state.multiSel; if (!s) return;
    const list = $('#fwd-room-list'); list.innerHTML = '';
    const targets = state.rooms.filter(r => r.id !== s.roomId);
    if (!targets.length) { toast('没有可转发的目标房间'); return; }
    targets.forEach(r => {
      const b = document.createElement('button'); b.className = 'room-opt';
      b.textContent = r.name + '（' + r.id + '）';
      b.addEventListener('click', async () => {
        $('#fwd-modal').classList.add('hidden');
        await doForward(s, r.id);
      });
      list.appendChild(b);
    });
    $('#fwd-modal').classList.remove('hidden');
  });
  $('#fwd-modal-close').addEventListener('click', () => $('#fwd-modal').classList.add('hidden'));
  $('#fwd-modal').addEventListener('click', (e) => { if (e.target === $('#fwd-modal')) $('#fwd-modal').classList.add('hidden'); });
  async function doForward(s, targetRoomId) {
    let ok = 0, fail = 0;
    for (const id of s.sel) {
      const m = s.msgs.get(id);
      if (!m) { fail++; continue; }
      const r = m.type === 'text' ? await C.sendText(targetRoomId, m.content)
        : (m.type === 'image' && m.file && m.file.abs) ? (async () => { try { const bytes = await C.readFile(m.file.abs); if (!bytes) return { ok: false, err: '读取图片失败' }; return await C.sendFile(targetRoomId, bytes, m.file.name || 'image.png', 'image/png'); } catch { return { ok: false, err: '读取图片失败' }; } })()
        : { ok: false, err: '该类型暂不能转发' };
      if (r.ok) ok++; else fail++;
    }
    state.multiSel = null; $('#forward-bar').classList.add('hidden'); $('#btn-multi').classList.remove('active'); renderRooms();
    toast('转发完成：成功 ' + ok + ' 条' + (fail ? '，失败 ' + fail + ' 条' : ''));
  }

  // 草稿箱：输入内容自动暂存，重开/换房间恢复
  let _dt; $('#input-text').addEventListener('input', () => { clearTimeout(_dt); _dt = setTimeout(() => { if (state.currentRoom) localStorage.setItem('cu.draft.' + state.currentRoom, $('#input-text').value); }, 400); });
  // 消息搜索
  const sb = $('#search-bar');
  $('#btn-search').addEventListener('click', () => { sb.classList.toggle('hidden'); if (!sb.classList.contains('hidden')) $('#search-input').focus(); });
  $('#search-close').addEventListener('click', () => sb.classList.add('hidden'));
  $('#search-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = $('#search-input').value.trim();
    if (!q || !state.currentRoom) return;
    const res = await C.searchHistory(state.currentRoom, q);
    const box = $('#search-results'); box.innerHTML = '';
    if (!res.length) { box.innerHTML = '<div class="search-item muted">没有找到匹配的消息</div>'; return; }
    res.forEach(r => {
      const d = document.createElement('div'); d.className = 'search-item';
      d.innerHTML = `<span class="sname">${esc(r.name)}</span><span class="stext">${esc(r.content)}</span><span class="stime">${fmtTime(r.ts)}</span>`;
      d.addEventListener('click', () => { sb.classList.add('hidden'); jumpToMessage(r.id); });
      box.appendChild(d);
    });
  });
  function jumpToMessage(id) {
    const found = document.querySelector('#messages .msg-row[data-msgid="' + CSS.escape(id) + '"]');
    if (found) { found.scrollIntoView({ block: 'center' }); found.classList.add('flash'); setTimeout(() => found.classList.remove('flash'), 1500); return; }
    toast('这条消息较旧，已切到该房间，向上翻找');
  }

  $('#input-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
  });

  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#btn-image').addEventListener('click', () => $('#image-input').click());
  $('#file-input').addEventListener('change', (e) => { sendFiles(e.target.files); e.target.value = ''; });
  $('#image-input').addEventListener('change', (e) => { sendFiles(e.target.files); e.target.value = ''; });

  // ---------- 表情 / 自定义表情 ----------
  const EMOJIS = ['😀','😂','😅','😊','😍','😘','😜','🤔','😭','😤','😴','🤯','👍','👎','👏','🙏','💪','🤝','❤️','💔','🔥','✨','🎉','🍀','☀️','🌙','⭐','⚡','🎁','🎂','🙌','👀','🤗','😎','🥳','😇','🤣','😉','🫡','🚀','💯','😱','🤩','🆗','👌','✌️','🤙','🖐️'];
  function initEmoji() {
    const grid = $('#emoji-grid');
    grid.innerHTML = '';
    EMOJIS.forEach(ch => {
      const b = document.createElement('button'); b.className = 'emoji-cell'; b.textContent = ch;
      b.addEventListener('click', () => {
        const t = $('#input-text');
        t.value += ch; t.focus();
      });
      grid.appendChild(b);
    });
    renderStickers();
    $('#btn-emoji').addEventListener('click', () => { $('#emoji-panel').classList.toggle('hidden'); });
    $('#btn-add-sticker').addEventListener('click', () => $('#sticker-input').click());
    $('#sticker-input').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const small = await downscaleImage(f, 220);
      const list = state.stickers || (state.stickers = load('cu.stickers', []));
      list.push({ id: String(Date.now()), dataUrl: small });
      store('cu.stickers', list);
      renderStickers();
      toast('已加入自定义表情');
    });
  }
  function renderStickers() {
    const row = $('#sticker-row');
    row.innerHTML = '';
    (state.stickers || (state.stickers = load('cu.stickers', []))).forEach(s => {
      const b = document.createElement('button'); b.className = 'sticker-cell';
      const img = document.createElement('img'); img.src = s.dataUrl; img.alt = '表情';
      b.appendChild(img);
      b.addEventListener('click', () => sendSticker(s.dataUrl));
      row.appendChild(b);
    });
  }
  function downscaleImage(file, maxPx) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/png'));
      };
      img.onerror = () => rej(new Error('图片读取失败'));
      img.src = url;
    });
  }
  async function sendSticker(dataUrl) {
    if (!state.currentRoom) { toast('请先加入房间'); return; }
    const buf = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
    const r = await C.sendFile(state.currentRoom, buf, 'sticker.png', 'image/png');
    if (!r.ok) toast(r.err);
  }
  initEmoji();

  $('#messages').addEventListener('dragover', (e) => { e.preventDefault(); });
  $('#messages').addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
  });

  const vb = $('#btn-voice');
  vb.addEventListener('mousedown', (e) => { e.preventDefault(); startVoice(); });
  vb.addEventListener('mouseup', stopVoice);
  vb.addEventListener('mouseleave', stopVoice);
  vb.addEventListener('contextmenu', (e) => { e.preventDefault(); stopVoice(); });

  $('#modal-mask').addEventListener('click', (e) => { if (e.target.id === 'modal-mask') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

init();
