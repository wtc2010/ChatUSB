'use strict';
/* ================= ChatUSB 截图组件：全屏框选 + 标注 ================= */
const C = window.chatUSB;
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let baseImg = null;          // 原始整屏图
let cropCanvas = null;       // 框选裁剪后的工作画布
let selectRect = null;       // {x,y,w,h} 设备像素坐标
let selecting = false;
let startPt = null;
let tool = 'pen';
let color = '#f5222d';
let lineWidth = 3;
let history = [];
let mapX = 1, mapY = 1;      // CSS px -> 设备 px

function pt(e) { return { x: (e.clientX) * mapX, y: (e.clientY) * mapY }; }

async function init() {
  try {
    const cap = await C.shotGet();
    if (!cap || !cap.dataUrl) { finish('cancel'); return; }
    const img = new Image();
    img.onload = () => {
      baseImg = img;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      mapX = canvas.width / window.innerWidth;
      mapY = canvas.height / window.innerHeight;
      drawFull();
      bindSelect();
    };
    img.onerror = () => { finish('cancel'); };
    img.src = cap.dataUrl;
  } catch (e) {
    finish('cancel');
  }
}

function drawFull() {
  ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
  // 提示边框
  ctx.strokeStyle = 'rgba(51,112,255,.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
}

function drawDim() {
  ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  if (selectRect) {
    const r = selectRect;
    ctx.fillRect(0, 0, canvas.width, r.y);
    ctx.fillRect(0, r.y + r.h, canvas.width, canvas.height - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, canvas.width - r.x - r.w, r.h);
    ctx.strokeStyle = '#3370ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    const sz = ctx.measureText(''); // noop
    ctx.fillStyle = '#3370ff';
    ctx.font = '13px "Microsoft YaHei"';
    ctx.fillText(`${Math.round(r.w / mapX)} × ${Math.round(r.h / mapY)}`, r.x, Math.max(14, r.y - 6));
  } else {
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

/* ---------- 框选 ---------- */
function bindSelect() {
  canvas.addEventListener('mousedown', (e) => {
    if (selecting) return;
    selecting = true;
    startPt = pt(e);
    selectRect = { x: startPt.x, y: startPt.y, w: 0, h: 0 };
  });
  window.addEventListener('mousemove', (e) => {
    if (!selecting) return;
    const p = pt(e);
    selectRect = {
      x: Math.min(startPt.x, p.x), y: Math.min(startPt.y, p.y),
      w: Math.abs(p.x - startPt.x), h: Math.abs(p.y - startPt.y)
    };
    drawDim();
  });
  window.addEventListener('mouseup', () => {
    if (!selecting) return;
    selecting = false;
    const r = selectRect;
    if (!r || r.w < 8 || r.h < 8) { selectRect = null; drawDim(); return; }
    enterEdit();
  });
}

/* ---------- 进入标注编辑 ---------- */
function enterEdit() {
  const r = selectRect;
  cropCanvas = document.createElement('canvas');
  cropCanvas.width = Math.round(r.w);
  cropCanvas.height = Math.round(r.h);
  const cctx = cropCanvas.getContext('2d');
  cctx.drawImage(baseImg, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  // 编辑画布铺满窗口，保持缩放
  canvas.width = cropCanvas.width;
  canvas.height = cropCanvas.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cropCanvas, 0, 0);
  mapX = canvas.width / window.innerWidth;
  mapY = canvas.height / window.innerHeight;
  document.getElementById('tipbar').textContent = '在截图区域上标注 · 点击「发送」直接发到聊天 · Esc 取消';
  document.getElementById('tipbar').style.display = 'none';
  const tb = document.getElementById('toolbar');
  tb.classList.remove('hidden');
  bindTools();
  history = [snapshot()];
  // 扩大窗口？不需要，canvas 铺满即可
}

function snapshot() {
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
function pushHistory() {
  history.push(snapshot());
  if (history.length > 20) history.shift();
}
function undo() {
  if (history.length <= 1) return;
  history.pop();
  ctx.putImageData(history[history.length - 1], 0, 0);
  syncCrop();
}

function syncCrop() {
  const snap = snapshot();
  cropCanvas.width = canvas.width;
  cropCanvas.height = canvas.height;
  cropCanvas.getContext('2d').putImageData(snap, 0, 0);
}

/* ---------- 标注工具 ---------- */
let drawing = false, lastP = null;

function bindTools() {
  const tb = document.getElementById('toolbar');
  tb.querySelectorAll('[data-tool]').forEach(b => {
    b.addEventListener('click', () => {
      tb.querySelectorAll('[data-tool]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      tool = b.dataset.tool;
      if (tool === 'text') hideTextInput();
    });
  });
  tb.querySelectorAll('.colors i').forEach(i => {
    i.addEventListener('click', () => {
      tb.querySelectorAll('.colors i').forEach(x => x.classList.remove('sel'));
      i.classList.add('sel');
      color = i.dataset.c;
    });
  });
  const sizeBtn = (b, w) => { b.addEventListener('click', () => {
    tb.querySelectorAll('#btn-size-s, #btn-size-m, #btn-size-l').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel'); lineWidth = w;
  }); };
  sizeBtn(document.getElementById('btn-size-s'), 2);
  sizeBtn(document.getElementById('btn-size-m'), 4);
  sizeBtn(document.getElementById('btn-size-l'), 8);
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', () => { document.getElementById('toolbar').classList.add('hidden'); resetToFull(); });
  document.getElementById('btn-cancel').addEventListener('click', () => finish('cancel'));
  document.getElementById('btn-save').addEventListener('click', () => finish('save'));
  document.getElementById('btn-send').addEventListener('click', () => finish('send'));

  canvas.addEventListener('mousedown', (e) => {
    if (tool === 'text') { placeText(e); return; }
    drawing = true;
    lastP = pt(e);
    pushHistory();
    if (tool === 'rect') { ctx.strokeStyle = color; ctx.lineWidth = lineWidth; }
    else if (tool === 'arrow') { ctx.strokeStyle = color; ctx.lineWidth = lineWidth; }
    else { ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; }
    if (tool === 'pen') {
      ctx.beginPath(); ctx.moveTo(lastP.x, lastP.y);
      ctx.lineTo(lastP.x + 0.1, lastP.y + 0.1); ctx.stroke();
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!drawing) return;
    const p = pt(e);
    if (tool === 'pen') {
      ctx.beginPath(); ctx.moveTo(lastP.x, lastP.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastP = p;
    } else if (tool === 'rect') {
      restoreLast();
      ctx.strokeRect(lastP.x, lastP.y, p.x - lastP.x, p.y - lastP.y);
    } else if (tool === 'arrow') {
      restoreLast();
      drawArrow(lastP.x, lastP.y, p.x, p.y);
    }
  });
  window.addEventListener('mouseup', () => {
    if (!drawing) return;
    drawing = false;
    syncCrop();
  });
}

function restoreLast() {
  ctx.putImageData(history[history.length - 1], 0, 0);
}
function drawArrow(x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hs = 10 + lineWidth;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - hs * Math.cos(ang - Math.PI / 6), y2 - hs * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(x2 - hs * Math.cos(ang + Math.PI / 6), y2 - hs * Math.sin(ang + Math.PI / 6));
  ctx.closePath(); ctx.fillStyle = color; ctx.fill();
}

/* ---------- 文字标注 ---------- */
function placeText(e) {
  const p = pt(e);
  const wrap = document.getElementById('text-input-wrap');
  const ta = document.getElementById('text-input');
  wrap.style.left = e.clientX + 'px';
  wrap.style.top = e.clientY + 'px';
  wrap.classList.remove('hidden');
  ta.value = '';
  ta.style.fontSize = Math.max(16, Math.round(22 * window.innerWidth / 1200)) + 'px';
  ta.focus();
  ta.onblur = () => commitText(p, ta.value);
  ta.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(p, ta.value); }
    else if (ev.key === 'Escape') { hideTextInput(); }
  };
  // 阻止画布 mousedown 干扰
  setTimeout(() => ta.addEventListener('mousedown', (e) => e.stopPropagation()), 0);
}
function commitText(p, text) {
  if (!text.trim()) { hideTextInput(); return; }
  pushHistory();
  ctx.fillStyle = color;
  const fs = Math.max(14, Math.round(24 * (canvas.width / window.innerWidth)));
  ctx.font = `600 ${fs}px "Microsoft YaHei", sans-serif`;
  ctx.lineWidth = Math.max(4, fs / 6);
  ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.strokeText(text, p.x, p.y + fs * 0.8);
  ctx.fillText(text, p.x, p.y + fs * 0.8);
  syncCrop();
  hideTextInput();
}
function hideTextInput() { document.getElementById('text-input-wrap').classList.add('hidden'); }

/* ---------- 重新框选 / 结束 ---------- */
function resetToFull() {
  selectRect = null;
  cropCanvas = null;
  history = [];
  canvas.width = baseImg.naturalWidth;
  canvas.height = baseImg.naturalHeight;
  mapX = canvas.width / window.innerWidth;
  mapY = canvas.height / window.innerHeight;
  drawDim();
  document.getElementById('tipbar').style.display = '';
  document.getElementById('tipbar').textContent = '按住鼠标左键拖拽框选截图区域 · Esc 取消';
}

async function finish(action) {
  if (action === 'send' || action === 'save') {
    let out = canvas;
    if (action === 'save' && selectRect) {
      // 保存未标注的框选图
      const c = document.createElement('canvas');
      c.width = Math.round(selectRect.w); c.height = Math.round(selectRect.h);
      c.getContext('2d').drawImage(baseImg, selectRect.x, selectRect.y, selectRect.w, selectRect.h, 0, 0, selectRect.w, selectRect.h);
      out = c;
    }
    const png = out.toDataURL('image/png');
    await C.shotFinish({ action, png });
  } else {
    await C.shotFinish({ action: 'cancel' });
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideTextInput(); finish('cancel'); }
  else if (e.key === 'Enter' && !document.getElementById('text-input-wrap').classList.contains('hidden')) return;
  else if (e.key === 'Enter') finish('send');
});

init();
