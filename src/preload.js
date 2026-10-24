'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatUSB', {
  /* 资料与主题 */
  getProfile: () => ipcRenderer.invoke('profile:get'),
  saveProfile: (p) => ipcRenderer.invoke('profile:save', p),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  /* 账户登录 */
  accountStatus: () => ipcRenderer.invoke('account:status'),
  accountRegister: (acc, pwd) => ipcRenderer.invoke('account:register', acc, pwd),
  accountLogin: (acc, pwd) => ipcRenderer.invoke('account:login', acc, pwd),
  accountReset: () => ipcRenderer.invoke('account:reset'),
  accountChangePwd: (oldp, newp) => ipcRenderer.invoke('account:changePwd', oldp, newp),

  /* 自定义标题栏窗口控制 */
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  /* 背景图 */
  bgList: () => ipcRenderer.invoke('bg:list'),
  bgPick: () => ipcRenderer.invoke('bg:pick'),
  bgOpen: () => ipcRenderer.invoke('bg:open'),

  /* 头像 */
  avatarSet: (payload) => ipcRenderer.invoke('avatar:set', payload),
  avatarGet: () => ipcRenderer.invoke('avatar:get'),
  avatarGetThumb: () => ipcRenderer.invoke('avatar:getThumb'),
  avatarClear: () => ipcRenderer.invoke('avatar:clear'),
  avatarSavePeer: (uid, dataUrl) => ipcRenderer.invoke('avatar:savePeer', uid, dataUrl),
  avatarGetPeer: (uid) => ipcRenderer.invoke('avatar:getPeer', uid),
  sendAvatar: () => ipcRenderer.invoke('msg:sendAvatar'),

  /* 房间 */
  getRooms: () => ipcRenderer.invoke('rooms:list'),
  createRoom: (name, password) => ipcRenderer.invoke('rooms:create', name, password),
  joinRoom: (id, password) => ipcRenderer.invoke('rooms:join', id, password),
  updateRoom: (id, patch) => ipcRenderer.invoke('rooms:update', id, patch),
  deleteRoom: (id) => ipcRenderer.invoke('rooms:delete', id),

  /* 好友 */
  friendsList: () => ipcRenderer.invoke('friends:list'),
  friendsAdd: (peerId) => ipcRenderer.invoke('friends:add', peerId),
  friendsRequest: (peerId, msg) => ipcRenderer.invoke('friends:request', peerId, msg),
  friendsRemove: (peerId) => ipcRenderer.invoke('friends:remove', peerId),
  friendsRename: (peerId, nickname) => ipcRenderer.invoke('friends:rename', peerId, nickname),
  noticesList: () => ipcRenderer.invoke('notices:list'),
  noticesStatus: (id, status) => ipcRenderer.invoke('notices:status', id, status),

  /* 网络 */
  connect: (roomId) => ipcRenderer.invoke('net:connect', roomId),
  disconnect: () => ipcRenderer.invoke('net:disconnect'),
  lanHost: (roomId) => ipcRenderer.invoke('lan:host', roomId),
  lanJoin: (roomId, url) => ipcRenderer.invoke('lan:join', roomId, url),
  lanStop: () => ipcRenderer.invoke('lan:stop'),

  /* 消息 */
  sendText: (roomId, text, opts) => ipcRenderer.invoke('msg:sendText', roomId, text, opts),
  sendFile: (roomId, bytes, name, mime) => ipcRenderer.invoke('msg:sendFile', roomId, bytes, name, mime),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  sendVoice: (roomId, bytes, duration, transcript) => ipcRenderer.invoke('msg:sendVoice', roomId, bytes, duration, transcript),
  transcribe: (pcm, sampleRate) => ipcRenderer.invoke('asr:transcribe', pcm, sampleRate),
  recall: (roomId, msgId) => ipcRenderer.invoke('msg:recall', roomId, msgId),
  loadHistory: (roomId, limit, skip) => ipcRenderer.invoke('history:load', roomId, limit, skip),
  historyCount: (roomId) => ipcRenderer.invoke('history:count', roomId),
  searchHistory: (roomId, query) => ipcRenderer.invoke('history:search', roomId, query),

  /* 文件 */
  fileDataUrl: (rel) => ipcRenderer.invoke('file:dataUrl', rel),
  saveFileDialog: (rel, name) => ipcRenderer.invoke('file:saveDialog', rel, name),
  openFile: (rel) => ipcRenderer.invoke('file:open', rel),

  /* 截图 */
  startScreenshot: () => ipcRenderer.invoke('shot:start'),
  shotFinish: (result) => ipcRenderer.invoke('shot:finish', result),
  shotGet: () => ipcRenderer.invoke('shot:get'),

  /* 其他 */
  notify: (title, body) => ipcRenderer.invoke('app:notify', title, body),
  version: () => ipcRenderer.invoke('app:version'),

  onEvent: (cb) => {
    ipcRenderer.on('event', (_e, ev) => cb(ev));
  }
});
