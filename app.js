/* =========================================================
   쇼츠 에디터 — 40초 세로(9:16) 영상 편집기
   100% 브라우저 로컬(CANVAS + MediaRecorder) · 백엔드 없음
   ========================================================= */
'use strict';

/* ---------------- 1. 유틸 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 9);
const pad2 = (n) => String(n).padStart(2, '0');
const FONT_STACK = '"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Malgun Gothic",system-ui,-apple-system,sans-serif';
const LIMIT = 40;                 // 쇼츠·릴스 권장 길이(초)
const PREVIEW_W = 540, PREVIEW_H = 960;

function fmtSec(t) { return (Math.round((t || 0) * 10) / 10).toFixed(1) + '초'; }
function fmtClock(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + s.toFixed(1).padStart(4, '0');
}
function fmtSize(bytes) {
  if (!bytes) return '0MB';
  const mb = bytes / 1048576;
  return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + 'MB';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------- 2. 상태 ---------------- */
const FILTERS = {
  original:  { label: '원본',     css: 'none', tint: null },
  vivid:     { label: '선명하게', css: 'saturate(1.42) contrast(1.1)', tint: null },
  warm:      { label: '따뜻하게', css: 'sepia(.22) saturate(1.18) brightness(1.04)', tint: null },
  cool:      { label: '시원하게', css: 'saturate(1.1) brightness(1.04)', tint: { c: 'rgba(70,150,255,.18)', m: 'soft-light' } },
  mono:      { label: '흑백',     css: 'grayscale(1) contrast(1.06)', tint: { c: '#808080', m: 'saturation' } },
  cinematic: { label: '시네마틱', css: 'contrast(1.2) saturate(.86) brightness(.94)', tint: { c: 'rgba(0,60,90,.16)', m: 'screen' } },
  swatch:    { original: 'linear-gradient(135deg,#889,#556)', vivid: 'linear-gradient(135deg,#ff9a3c,#ff4d6d)', warm: 'linear-gradient(135deg,#ffbf6b,#e2653a)', cool: 'linear-gradient(135deg,#63b8ff,#3a5bd9)', mono: 'linear-gradient(135deg,#eee,#666)', cinematic: 'linear-gradient(135deg,#2b4a5a,#c08a5a)' }
};

const S = {
  clips: [],
  selectedClipId: null,
  captions: [],
  selectedCapId: null,
  title: { on: false, text: '', mode: 'all', start: 0, end: 3, size: 34, color: '#ffffff', bg: '#7c5cff' },
  audio: { videoVolume: 1, bgmVolume: 0.6, bgmFadeIn: 0.5, bgmFadeOut: 1, bgmName: '', bgmUrl: '' },
  fillMode: 'cover',         // cover | contain
  bgMode: 'blur',            // blur | color
  bgColor: '#000000',
  offX: 0, offY: 0,
  filter: 'original',
  transition: 'fade',
  transDur: 0.4,
  fadeIn: 0, fadeOut: 0,
  globalSpeed: 1
};

const A = { ctx: null, master: null, streamDest: null, bgmGain: null, bgmSrc: null, bgmEl: null };
const P = { playing: false, time: 0, base: 0, t0: 0, raf: 0, loop: false, muted: false };
const X = { running: false, cancel: false, rec: null, raf: 0, cam: null };

const previewCanvas = $('#previewCanvas');
const previewCtx = previewCanvas.getContext('2d', { alpha: false });
let scratch = null;

/* ---------------- 3. 오디오 엔진 ---------------- */
function ensureAudio() {
  if (A.ctx) {
    if (A.ctx.state === 'suspended') A.ctx.resume().catch(() => {});
    return A.ctx;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    A.ctx = new Ctx();
    A.master = A.ctx.createGain();
    A.master.gain.value = 1;
    A.master.connect(A.ctx.destination);
    A.streamDest = A.ctx.createMediaStreamDestination();
    A.master.connect(A.streamDest);
    A.bgmGain = A.ctx.createGain();
    A.bgmGain.gain.value = 0;
    A.bgmGain.connect(A.master);
    return A.ctx;
  } catch (e) {
    A.ctx = null;
    return null;
  }
}
function attachVideoAudio(clip) {
  if (!A.ctx || clip.__gain) return;
  try {
    const src = A.ctx.createMediaElementSource(clip.video);
    const g = A.ctx.createGain();
    g.gain.value = S.audio.videoVolume;
    src.connect(g);
    g.connect(A.master);
    clip.__gain = g;
  } catch (e) { /* 이미 연결된 경우 무시 */ }
}
function attachAllAudio() {
  if (!A.ctx) return;
  S.clips.forEach(attachVideoAudio);
  if (A.bgmEl && !A.bgmSrc) {
    try {
      A.bgmSrc = A.ctx.createMediaElementSource(A.bgmEl);
      A.bgmSrc.connect(A.bgmGain);
    } catch (e) { /* ignore */ }
  }
}
function applyVideoVolume() {
  S.clips.forEach((c) => { if (c.__gain) c.__gain.gain.value = S.audio.videoVolume; });
}
function bgmFade(t) {
  const total = layout().total || 0;
  let f = 1;
  if (S.audio.bgmFadeIn > 0) f = Math.min(f, clamp(t / S.audio.bgmFadeIn, 0, 1));
  if (S.audio.bgmFadeOut > 0) f = Math.min(f, clamp((total - t) / S.audio.bgmFadeOut, 0, 1));
  return clamp(f, 0, 1);
}

/* ---------------- 4. 클립 ---------------- */
function once(el, ev, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
    const fail = () => { if (done) return; done = true; cleanup(); reject(new Error('timeout')); };
    const cleanup = () => { el.removeEventListener(ev, ok); clearTimeout(tm); };
    const tm = setTimeout(fail, ms || 10000);
    el.addEventListener(ev, ok, { once: true });
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (f) => /^video\//i.test(f.type) || /\.(mp4|mov|webm|m4v|ogv)$/i.test(f.name)
  );
  if (!files.length) { toast('영상 파일이 아니에요. MP4 · MOV · WebM 을 선택해 주세요.'); return; }
  let added = 0;
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.preload = 'auto';
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:.01;pointer-events:none';
    video.addEventListener('seeked', () => { if (!P.playing && !X.running) requestDraw(); });
    video.addEventListener('loadeddata', () => { if (!P.playing && !X.running) requestDraw(); });
    $('#videoBank').appendChild(video);

    try {
      await once(video, 'loadedmetadata', 12000);
      const d = video.duration;
      if (!isFinite(d) || d <= 0) throw new Error('bad duration');
    } catch (e) {
      toast('"' + file.name + '" 을(를) 읽지 못했어요. 다른 형식(MP4 권장)으로 변환해 주세요.', 4200);
      video.remove();
      URL.revokeObjectURL(url);
      continue;
    }
    const dur = Math.max(0.3, video.duration);
    const clip = {
      id: uid(), file, name: file.name, url, video,
      duration: dur, trimStart: 0, trimEnd: dur, speed: 1, poster: '', __active: false
    };
    S.clips.push(clip);
    attachVideoAudio(clip);
    added++;
    makePoster(clip);
  }
  if (added) {
    if (!S.selectedClipId) S.selectedClipId = S.clips[S.clips.length - 1].id;
    refreshAll();
    const total = layout().total;
    if (total > LIMIT) toast('전체 길이가 ' + fmtSec(total) + ' — 40초를 넘었어요.', 3500);
  }
}

function makePoster(clip) {
  const v = clip.video;
  let done = false;
  const grab = () => {
    if (done) return;
    try {
      if (v.readyState < 2 || !v.videoWidth) return;   // 프레임이 아직 없으면 다음 기회에
      const c = document.createElement('canvas');
      c.width = 90; c.height = 160;
      const x = c.getContext('2d');
      const vw = v.videoWidth, vh = v.videoHeight;
      const s = Math.max(90 / vw, 160 / vh);
      x.fillStyle = '#000'; x.fillRect(0, 0, 90, 160);
      x.drawImage(v, (90 - vw * s) / 2, (160 - vh * s) / 2, vw * s, vh * s);
      clip.poster = c.toDataURL('image/jpeg', 0.6);
      done = true;
      renderClips();
      renderTimeline();
    } catch (e) { /* 썸네일 실패는 무시 */ }
  };
  const target = Math.min(Math.max(0.1, v.duration / 2), Math.max(0.1, v.duration - 0.1));
  v.addEventListener('seeked', grab);
  v.addEventListener('loadeddata', grab);
  const kick = () => { try { v.currentTime = target; } catch (e) {} };
  if (v.readyState >= 1) kick();
  else v.addEventListener('loadedmetadata', kick, { once: true });
  setTimeout(grab, 1500);
  setTimeout(grab, 3500);
}

function removeClip(id) {
  const i = S.clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = S.clips[i];
  try { c.video.pause(); } catch (e) {}
  c.video.remove();
  URL.revokeObjectURL(c.url);
  S.clips.splice(i, 1);
  if (S.selectedClipId === id) S.selectedClipId = S.clips[Math.max(0, i - 1)] ? S.clips[Math.max(0, i - 1)].id : null;
  refreshAll();
}
function moveClip(id, dir) {
  const i = S.clips.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.clips.length) return;
  const [c] = S.clips.splice(i, 1);
  S.clips.splice(j, 0, c);
  refreshAll();
}

/* ---------------- 5. 타임라인 계산 ---------------- */
function effSpeed(c) { return clamp((c.speed || 1) * S.globalSpeed, 0.25, 4); }
function clipDur(c) { return Math.max(0.05, (c.trimEnd - c.trimStart) / effSpeed(c)); }

function layout() {
  const segs = [];
  const n = S.clips.length;
  const wantTd = (S.transition === 'fade' && n > 1) ? Math.max(0, S.transDur) : 0;
  for (let i = 0; i < n; i++) {
    const c = S.clips[i];
    const d = clipDur(c);
    let start = 0, fadeIn = 0;
    if (i > 0) {
      const prev = segs[i - 1];
      const ov = Math.min(wantTd, prev.dur * 0.5, d * 0.5);
      start = prev.start + prev.dur - ov;
      fadeIn = ov;
      prev.fadeOut = ov;
    }
    segs.push({ clip: c, start, dur: d, end: start + d, fadeIn, fadeOut: 0, i });
  }
  const total = segs.length ? segs[segs.length - 1].end : 0;
  return { segs, total };
}
function localTime(seg, t) {
  const c = seg.clip;
  return clamp(c.trimStart + (t - seg.start) * effSpeed(c), c.trimStart, c.trimEnd);
}
function activeSegs(segs, t) {
  const out = [];
  for (const s of segs) {
    if (t >= s.start - 1e-4 && t <= s.end + 1e-4) {
      let a = 1;
      if (s.fadeIn > 1e-4 && t < s.start + s.fadeIn) a = Math.min(a, (t - s.start) / s.fadeIn);
      if (s.fadeOut > 1e-4 && t > s.end - s.fadeOut) a = Math.min(a, (s.end - t) / s.fadeOut);
      out.push(Object.assign({}, s, { alpha: clamp(a, 0, 1) }));
    }
  }
  if (!out.length && segs.length) {
    // 경계 밖(끝 지점) 보정
    const last = segs[segs.length - 1];
    if (t > last.end - 1e-3) out.push(Object.assign({}, last, { alpha: 1 }));
  }
  return out;
}

/* ---------------- 6. 그리기 ---------------- */
function filterSupported() {
  if (filterSupported._v !== undefined) return filterSupported._v;
  let ok = false;
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (c && 'filter' in c) { c.filter = 'grayscale(1)'; ok = c.filter !== 'none' && c.filter !== undefined && c.filter !== ''; }
  } catch (e) { ok = false; }
  filterSupported._v = ok;
  return ok;
}
function getScratch(W, H) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H; }
  return scratch;
}
function fitRect(vw, vh, W, H, mode, offX, offY) {
  const s = mode === 'cover' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  let dx = (W - dw) / 2 + (offX / 100) * W;
  let dy = (H - dh) / 2 + (offY / 100) * H;
  if (mode === 'cover') {
    if (dw >= W) dx = clamp(dx, W - dw, 0);
    if (dh >= H) dy = clamp(dy, H - dh, 0);
  }
  return { sx: 0, sy: 0, sw: vw, sh: vh, dx, dy, dw, dh };
}

function drawClipInto(g, clip, local, W, H) {
  const v = clip.video;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.filter = 'none';
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  const vw = v.videoWidth || 720, vh = v.videoHeight || 1280;
  const contain = S.fillMode !== 'cover';

  if (contain) {
    if (S.bgMode === 'blur') {
      const br = fitRect(vw, vh, W, H, 'cover', 0, 0);
      g.save();
      if (filterSupported()) g.filter = 'blur(26px) brightness(.55)';
      g.drawImage(v, br.sx, br.sy, br.sw, br.sh, br.dx - 30, br.dy - 30, br.dw + 60, br.dh + 60);
      g.restore();
      if (!filterSupported()) { g.globalAlpha = 0.55; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    } else {
      g.fillStyle = S.bgColor;
      g.fillRect(0, 0, W, H);
    }
  }

  if (v.readyState >= 2) {
    const rect = fitRect(vw, vh, W, H, contain ? 'contain' : 'cover', S.offX, S.offY);
    const f = FILTERS[S.filter] || FILTERS.original;
    g.save();
    if (filterSupported() && f.css !== 'none') g.filter = f.css;
    g.drawImage(v, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
    g.restore();

    if (f.tint) {
      g.save();
      if (!filterSupported() && S.filter === 'mono') {
        g.globalCompositeOperation = 'saturation';
      } else {
        g.globalCompositeOperation = f.tint.m;
      }
      g.fillStyle = f.tint.c;
      g.fillRect(0, 0, W, H);
      g.restore();
    }
    if (!filterSupported() && (S.filter === 'vivid' || S.filter === 'cinematic')) {
      g.save();
      g.globalCompositeOperation = S.filter === 'vivid' ? 'overlay' : 'multiply';
      g.globalAlpha = S.filter === 'vivid' ? 0.16 : 0.12;
      g.drawImage(g.canvas, 0, 0);
      g.restore();
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
}

function wrapText(g, text, maxW) {
  const out = [];
  const paras = String(text == null ? '' : text).split('\n');
  for (const para of paras) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    const tokens = para.split(/(\s+)/);
    for (const tk of tokens) {
      const test = line + tk;
      if (line && g.measureText(test).width > maxW) {
        out.push(line.replace(/\s+$/, ''));
        line = tk.replace(/^\s+/, '');
      } else {
        line = test;
      }
      // 공백 없는 긴 문자열 강제 줄바꿈
      let guard = 0;
      while (g.measureText(line).width > maxW && line.length > 1 && guard++ < 200) {
        let cut = line.length;
        while (cut > 1 && g.measureText(line.slice(0, cut)).width > maxW) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out.length ? out : [''];
}

function drawTextBlock(g, W, H, o) {
  const size = o.size;
  g.save();
  g.font = '800 ' + size + 'px ' + FONT_STACK;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = wrapText(g, o.text, W * (o.maxWidth || 0.88));
  const lh = size * (o.lineGap || 1.26);
  const blockH = lines.length * lh;
  let top;
  if (o.pos === 'top') top = H * (o.inTop || 0.085);
  else if (o.pos === 'middle') top = (H - blockH) / 2;
  else top = H * (1 - (o.inBottom || 0.235)) - blockH;

  if (o.bgColor) {
    let wmax = 0;
    lines.forEach((l) => { wmax = Math.max(wmax, g.measureText(l).width); });
    const padX = size * 0.52, padY = size * 0.34;
    const bw = Math.min(W * 0.95, wmax + padX * 2);
    const bh = blockH + padY * 2;
    g.fillStyle = o.bgColor;
    rr(g, (W - bw) / 2, top - padY, bw, bh, Math.min(size * 0.42, bh / 2));
    g.fill();
  }
  lines.forEach((l, i) => {
    const y = top + lh * i + lh / 2;
    if (!l) return;
    if (o.outline) {
      g.lineWidth = Math.max(2, size * 0.14);
      g.strokeStyle = o.outlineColor || 'rgba(0,0,0,.9)';
      g.lineJoin = 'round';
      g.miterLimit = 2;
      g.strokeText(l, W / 2, y);
    }
    g.shadowColor = 'rgba(0,0,0,.45)';
    g.shadowBlur = size * 0.22;
    g.shadowOffsetY = size * 0.05;
    g.fillStyle = o.color || '#fff';
    g.fillText(l, W / 2, y);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
  });
  g.restore();
}

function drawCaptions(g, W, H, t) {
  const scale = H / 1280;
  for (const c of S.captions) {
    if (!c.text || !c.text.trim()) continue;
    if (t < c.start - 1e-4 || t > c.end + 1e-4) continue;
    drawTextBlock(g, W, H, {
      text: c.text,
      size: Math.max(10, c.size * scale),
      color: c.color,
      bgColor: c.bg ? c.bgColor : null,
      outline: c.outline,
      outlineColor: 'rgba(0,0,0,.9)',
      pos: c.pos,
      maxWidth: 0.86,
      inTop: 0.13,
      inBottom: 0.235
    });
  }
}

function drawHookTitle(g, W, H, t) {
  const T = S.title;
  if (!T.on || !T.text || !T.text.trim()) return;
  if (T.mode === 'intro' && (t < T.start || t > T.end)) return;
  const scale = H / 1280;
  const size = Math.max(12, T.size * scale);
  g.save();
  g.font = '800 ' + size + 'px ' + FONT_STACK;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = wrapText(g, T.text, W * 0.84);
  const lh = size * 1.22;
  const blockH = lines.length * lh;
  let wmax = 0;
  lines.forEach((l) => { wmax = Math.max(wmax, g.measureText(l).width); });
  const padX = size * 0.55, padY = size * 0.42;
  const bw = Math.min(W * 0.92, wmax + padX * 2);
  const bh = blockH + padY * 2;
  const bx = (W - bw) / 2, by = H * 0.055;
  g.shadowColor = 'rgba(0,0,0,.4)';
  g.shadowBlur = size * 0.5;
  g.shadowOffsetY = size * 0.12;
  g.fillStyle = T.bg;
  rr(g, bx, by, bw, bh, Math.min(size * 0.5, bh / 2));
  g.fill();
  g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
  g.fillStyle = T.color;
  lines.forEach((l, i) => {
    g.fillText(l, W / 2, by + padY + lh * i + lh / 2);
  });
  g.restore();
}

function drawFrame(g, W, H, t) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  const { segs, total } = layout();
  if (segs.length) {
    const act = activeSegs(segs, t);
    const sc = getScratch(W, H);
    const sg = sc.getContext('2d');
    act.forEach((s, idx) => {
      const a = idx === 0 ? 1 : clamp(s.alpha, 0, 1);
      if (a <= 0.001) return;
      drawClipInto(sg, s.clip, localTime(s, t), W, H);
      g.globalAlpha = a;
      g.drawImage(sc, 0, 0, W, H);
      g.globalAlpha = 1;
    });

    // 전체 페이드 인/아웃
    let fade = 0;
    if (S.fadeIn > 0) fade = Math.max(fade, 1 - clamp(t / S.fadeIn, 0, 1));
    if (S.fadeOut > 0) fade = Math.max(fade, 1 - clamp((total - t) / S.fadeOut, 0, 1));
    if (fade > 0.001) {
      g.fillStyle = 'rgba(0,0,0,' + fade.toFixed(3) + ')';
      g.fillRect(0, 0, W, H);
    }
  }

  drawCaptions(g, W, H, t);
  drawHookTitle(g, W, H, t);
}

function requestDraw() {
  if (X.running) return;
  drawFrame(previewCtx, PREVIEW_W, PREVIEW_H, P.time);
}

/* ---------------- 7. 재생 ---------------- */
function resetVideos() {
  S.clips.forEach((c) => { c.__active = false; try { c.video.pause(); } catch (e) {} });
}
function syncMedia(t, playing) {
  const { segs } = layout();
  const act = activeSegs(segs, t);
  const ids = {};
  act.forEach((s) => { ids[s.clip.id] = s; });

  segs.forEach((s) => {
    const c = s.clip, v = c.video;
    const active = ids[c.id];
    if (active) {
      const local = localTime(active, t);
      const rate = clamp(effSpeed(c), 0.0625, 16);
      if (Math.abs(v.playbackRate - rate) > 0.01) { try { v.playbackRate = rate; } catch (e) {} }
      if (playing) {
        if (!c.__active) {
          c.__active = true;
          try { v.currentTime = local; } catch (e) {}
          const pr = v.play();
          if (pr && pr.catch) pr.catch(() => {});
        } else if (Math.abs(v.currentTime - local) > 0.35) {
          try { v.currentTime = local; } catch (e) {}
        }
      } else {
        c.__active = false;
        if (Math.abs(v.currentTime - local) > 0.03) { try { v.currentTime = local; } catch (e) {} }
        if (!v.paused) { try { v.pause(); } catch (e) {} }
      }
    } else if (c.__active || !v.paused) {
      c.__active = false;
      try { v.pause(); } catch (e) {}
    }
  });

  // BGM
  const el = A.bgmEl;
  if (A.bgmGain) A.bgmGain.gain.value = P.muted && !X.running ? 0 : (S.audio.bgmVolume * bgmFade(t));
  if (el) {
    if (playing) {
      if (el.paused) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
      if (isFinite(el.duration) && el.duration > 0) {
        const want = t % el.duration;
        if (Math.abs(el.currentTime - want) > 0.45) { try { el.currentTime = want; } catch (e) {} }
      }
    } else {
      if (!el.paused) el.pause();
      if (isFinite(el.duration) && el.duration > 0) {
        const want = Math.min(t % el.duration, el.duration - 0.05);
        if (Math.abs(el.currentTime - want) > 0.1) { try { el.currentTime = Math.max(0, want); } catch (e) {} }
      }
    }
  }
}

function startPlayback() {
  const { total } = layout();
  if (total <= 0) { toast('먼저 영상을 추가해 주세요.'); return; }
  if (X.running) return;
  ensureAudio();
  attachAllAudio();
  if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume().catch(() => {});
  if (A.master) A.master.gain.value = P.muted ? 0 : 1;
  if (P.time >= total - 0.03) P.time = 0;
  P.playing = true;
  P.base = P.time;
  P.t0 = performance.now();
  updatePlayBtn();
  tick();
}

function pausePlayback() {
  P.playing = false;
  cancelAnimationFrame(P.raf);
  resetVideos();
  if (A.bgmEl && !A.bgmEl.paused) { try { A.bgmEl.pause(); } catch (e) {} }
  updatePlayBtn();
  drawFrame(previewCtx, PREVIEW_W, PREVIEW_H, P.time);
  updateTransport(P.time);
}

function tick() {
  if (!P.playing) return;
  const { total } = layout();
  let t = P.base + (performance.now() - P.t0) / 1000;
  if (t >= total) {
    if (P.loop) {
      P.base = 0; P.t0 = performance.now(); t = 0;
      resetVideos();
    } else {
      P.time = total;
      syncMedia(total, false);
      drawFrame(previewCtx, PREVIEW_W, PREVIEW_H, total);
      updateTransport(total);
      pausePlayback();
      return;
    }
  }
  P.time = t;
  syncMedia(t, true);
  drawFrame(previewCtx, PREVIEW_W, PREVIEW_H, t);
  updateTransport(t);
  P.raf = requestAnimationFrame(tick);
}

function seekTo(t) {
  const { total } = layout();
  P.time = clamp(t, 0, total);
  P.base = P.time;
  P.t0 = performance.now();
  if (!P.playing) syncMedia(P.time, false);
  drawFrame(previewCtx, PREVIEW_W, PREVIEW_H, P.time);
  updateTransport(P.time);
}

function updatePlayBtn() {
  const b = $('#btnPlay');
  b.textContent = P.playing ? '❚❚' : '▶';
  b.setAttribute('aria-label', P.playing ? '일시정지' : '재생');
}

function updateTransport(t) {
  $('#timeNow').textContent = fmtClock(t);
  const total = layout().total;
  const sc = $('#scrub');
  if (document.activeElement !== sc) sc.value = String(clamp(t, 0, Math.max(0.01, total)));
  updatePlayhead(t);
}
function updatePlayhead(t) {
  const total = layout().total;
  const ph = $('#tlPlayhead');
  ph.style.left = total > 0 ? (clamp(t / total, 0, 1) * 100) + '%' : '0%';
}

/* ---------------- 8. UI 그리기 ---------------- */
function updateExpSummary(total) {
  const res = +$('#expRes').value || 720;
  const mime = pickMime();
  const label = formatLabel(mime);
  const bitrate = res >= 1080 ? 8 : res >= 720 ? 5 : 3;
  const est = (bitrate * 1e6 / 8) * total;
  $('#expSummary').innerHTML =
    '<li>길이 <b>' + fmtSec(total) + '</b>' + (total > LIMIT ? ' <span style="color:#ff8095">(40초 초과)</span>' : '') + '</li>' +
    '<li>해상도 <b>' + res + ' × ' + Math.round(res * 16 / 9) + '</b> · 9:16</li>' +
    '<li>형식 <b>' + label + '</b> · 이 브라우저가 지원하는 최상 형식</li>' +
    '<li>예상 용량 <b>' + fmtSize(est) + '</b> 내외</li>';
}

function renderClips() {
  const box = $('#clipList');
  if (!S.clips.length) {
    box.innerHTML = '<div class="emptyBox">아직 클립이 없어요.<br>‘+ 영상 추가’로 MP4 · MOV · WebM 을 불러오세요.</div>';
    return;
  }
  box.innerHTML = S.clips.map((c, i) => {
    const dur = clipDur(c);
    return '<div class="clipItem ' + (c.id === S.selectedClipId ? 'sel' : '') + '" data-id="' + c.id + '">' +
      (c.poster ? '<img class="thumb" src="' + c.poster + '" alt="" draggable="false">' : '<div class="thumb"></div>') +
      '<div class="meta">' +
        '<div class="name">' + (i + 1) + '. ' + escapeHtml(c.name) + '</div>' +
        '<div class="sub">' + c.duration.toFixed(1) + '초 중 ' + (c.trimEnd - c.trimStart).toFixed(1) + '초 · 배속 ' + c.speed + 'x → <b>' + dur.toFixed(1) + '초</b></div>' +
      '</div>' +
      '<div class="ops">' +
        '<button class="miniBtn" data-act="up" title="위로">▲</button>' +
        '<button class="miniBtn" data-act="down" title="아래로">▼</button>' +
        '<button class="miniBtn del" data-act="del" title="삭제">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderClipProps() {
  const box = $('#clipProps');
  const c = S.clips.find((x) => x.id === S.selectedClipId);
  if (!c) { box.innerHTML = ''; return; }
  const dur = c.duration;
  box.innerHTML =
  '<div class="propCard">' +
    '<div class="propTitle">선택한 클립 · ' + escapeHtml(c.name) + '</div>' +
    '<label class="sliderRow"><span>시작 지점</span><input type="range" data-c="trimStart" min="0" max="' + dur.toFixed(2) + '" step="0.05" value="' + c.trimStart + '"><output>' + c.trimStart.toFixed(1) + 's</output></label>' +
    '<label class="sliderRow"><span>끝 지점</span><input type="range" data-c="trimEnd" min="0" max="' + dur.toFixed(2) + '" step="0.05" value="' + c.trimEnd + '"><output>' + c.trimEnd.toFixed(1) + 's</output></label>' +
    '<div class="timeInputs">' +
      '<label>시작(초)<input type="number" data-c="trimStartNum" min="0" max="' + dur.toFixed(2) + '" step="0.1" value="' + c.trimStart.toFixed(1) + '"></label>' +
      '<label>끝(초)<input type="number" data-c="trimEndNum" min="0" max="' + dur.toFixed(2) + '" step="0.1" value="' + c.trimEnd.toFixed(1) + '"></label>' +
    '</div>' +
    '<div class="pickRow">' +
      '<button class="btn small ghost" data-cact="inAt">현재 위치 = 시작</button>' +
      '<button class="btn small ghost" data-cact="outAt">현재 위치 = 끝</button>' +
    '</div>' +
    '<label class="sliderRow"><span>배속</span><input type="range" data-c="speed" min="0.5" max="2" step="0.05" value="' + c.speed + '"><output>' + c.speed.toFixed(2) + 'x</output></label>' +
    '<div class="segRow" style="margin-top:8px">' +
      [0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => '<button class="seg ' + (Math.abs(c.speed - s) < 0.01 ? 'on' : '') + '" data-cact="speed" data-v="' + s + '">' + s + 'x</button>').join('') +
    '</div>' +
    '<p class="hint" data-hint>사용 구간 ' + (c.trimEnd - c.trimStart).toFixed(1) + '초 → 재생 ' + clipDur(c).toFixed(1) + '초</p>' +
  '</div>';
}

function renderCaptions() {
  const box = $('#capList');
  $('#capCount').textContent = S.captions.length + '개';
  $('#capEmptyHint').hidden = S.captions.length > 0;
  if (!S.captions.length) { box.innerHTML = ''; return; }
  box.innerHTML = S.captions.map((c) => {
    return '<div class="capCard ' + (c.id === S.selectedCapId ? 'sel' : '') + '" data-id="' + c.id + '">' +
      '<div class="capHead">' +
        '<span class="capBadge" data-badge>' + fmtSec(c.start) + ' → ' + fmtSec(c.end) + '</span>' +
        '<div class="capTools">' +
          '<button class="miniBtn" data-cap="setStart" title="현재 위치를 시작으로">⇤</button>' +
          '<button class="miniBtn" data-cap="setEnd" title="현재 위치를 끝으로">⇥</button>' +
          '<button class="miniBtn del" data-cap="del" title="삭제">✕</button>' +
        '</div>' +
      '</div>' +
      '<textarea data-f="text" rows="2" placeholder="자막 내용을 입력하세요">' + escapeHtml(c.text) + '</textarea>' +
      '<div class="capGrid">' +
        '<label>시작(초)<input type="number" data-f="start" min="0" step="0.1" value="' + c.start.toFixed(1) + '"></label>' +
        '<label>끝(초)<input type="number" data-f="end" min="0" step="0.1" value="' + c.end.toFixed(1) + '"></label>' +
      '</div>' +
      '<div class="capGrid">' +
        '<label>크기 <input type="range" data-f="size" min="16" max="72" step="1" value="' + c.size + '"></label>' +
        '<label>글자색 <input type="color" data-f="color" value="' + c.color + '"></label>' +
      '</div>' +
      '<div class="inlineChecks">' +
        '<label><input type="checkbox" data-f="bg" ' + (c.bg ? 'checked' : '') + '> 배경</label>' +
        '<label><input type="checkbox" data-f="outline" ' + (c.outline ? 'checked' : '') + '> 외곽선</label>' +
        '<label style="gap:4px">배경색 <input type="color" data-f="bgColor" value="' + (/^#[0-9a-f]{6}$/i.test(c.bgColor) ? c.bgColor : '#000000') + '"></label>' +
      '</div>' +
      '<div class="posRow">' +
        ['top', 'middle', 'bottom'].map((p) => '<button class="seg ' + (c.pos === p ? 'on' : '') + '" data-cap="pos" data-pos="' + p + '">' + (p === 'top' ? '상단' : p === 'middle' ? '중앙' : '하단') + '</button>').join('') +
      '</div>' +
    '</div>';
  }).join('');
}

function renderTimeline() {
  const { segs, total } = layout();
  const tlClips = $('#tlClips');
  const tlCaps = $('#tlCaps');
  const tlEmpty = $('#tlEmpty');
  tlEmpty.hidden = S.clips.length > 0;

  if (!total) { tlClips.innerHTML = ''; tlCaps.innerHTML = ''; return; }
  tlClips.innerHTML = segs.map((s, i) =>
    '<div class="tlclip" style="flex:0 0 ' + ((s.dur / total) * 100).toFixed(3) + '%" data-id="' + s.clip.id + '">' +
      (s.clip.poster ? '<img src="' + s.clip.poster + '" alt="" draggable="false">' : '') +
      '<span>' + (i + 1) + '</span>' +
    '</div>'
  ).join('');
  tlCaps.innerHTML = S.captions.map((c) => {
    const l = clamp((c.start / total) * 100, 0, 100);
    const w = clamp(((c.end - c.start) / total) * 100, 0.6, 100 - l);
    return '<div class="tlcap" style="left:' + l.toFixed(3) + '%;width:' + w.toFixed(3) + '%" title="' + escapeHtml(c.text) + '"></div>';
  }).join('') +
  (S.title.on && S.title.mode === 'intro' ? '<div class="tltitle" style="left:' + clamp((S.title.start / total) * 100, 0, 100).toFixed(3) + '%;width:' + clamp(((S.title.end - S.title.start) / total) * 100, 0.6, 100).toFixed(3) + '%"></div>' : '');
  updatePlayhead(P.time);
}

let overWarned = false;
function refreshTime() {
  const { total } = layout();
  $('#totalDuration').textContent = fmtSec(total);
  if (total > LIMIT && !overWarned) {
    overWarned = true;
    toast('40초를 넘었어요. 쇼츠·릴스에서 뒷부분이 잘릴 수 있어요.', 3800);
  } else if (total <= LIMIT) {
    overWarned = false;
  }
  const fill = $('#limitFill');
  fill.style.width = Math.min(100, (total / LIMIT) * 100) + '%';
  fill.classList.toggle('over', total > LIMIT);
  $('#limitWarn').hidden = total <= LIMIT;
  const sc = $('#scrub');
  sc.max = String(Math.max(0.01, total));
  sc.value = String(clamp(P.time, 0, Math.max(0.01, total)));
  if (P.time > total) P.time = total;
  $('#clipCount').textContent = S.clips.length + '개';
  $('#capCount').textContent = S.captions.length + '개';
  $('#previewEmpty').hidden = S.clips.length > 0;
  $('#titleStart').max = total.toFixed(1);
  $('#titleEnd').max = total.toFixed(1);
  updateExpSummary(total);
}

function refreshAll() {
  renderClips();
  renderClipProps();
  renderCaptions();
  renderTimeline();
  refreshTime();
  requestDraw();
}

/* ---------------- 9. 자막·제목 조작 ---------------- */
function addCaption() {
  const { total } = layout();
  if (total <= 0) { toast('먼저 영상을 추가해 주세요.'); return; }
  const start = clamp(P.time, 0, Math.max(0, total - 0.5));
  const end = clamp(start + 2, start + 0.5, Math.max(start + 0.5, total));
  const c = {
    id: uid(), start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10,
    text: '', size: 42, color: '#ffffff', bg: true, bgColor: 'rgba(0,0,0,0.55)',
    outline: true, pos: 'bottom'
  };
  S.captions.push(c);
  S.selectedCapId = c.id;
  renderCaptions();
  renderTimeline();
  switchTab('captions');
  const el = $('.capCard[data-id="' + c.id + '"] textarea');
  if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function updateCaptionFromEl(card, input) {
  const c = S.captions.find((x) => x.id === card.dataset.id);
  if (!c) return;
  const f = input.dataset.f;
  if (!f) return;
  let v;
  if (input.type === 'checkbox') v = input.checked;
  else if (input.type === 'number' || input.type === 'range') v = parseFloat(input.value);
  else v = input.value;
  if (v === undefined || (typeof v === 'number' && isNaN(v))) return;

  if (f === 'start' || f === 'end') {
    v = clamp(v, 0, Math.max(0.2, layout().total));
    if (f === 'start') c.start = Math.min(v, c.end - 0.2);
    else c.end = Math.max(v, c.start + 0.2);
    const badge = $('[data-badge]', card);
    if (badge) badge.textContent = fmtSec(c.start) + ' → ' + fmtSec(c.end);
    renderTimeline();
  } else if (f === 'size') {
    c.size = clamp(v, 10, 90);
    const out = input.parentElement.querySelector('output');
    if (out) out.textContent = v;
  } else {
    c[f] = v;
    if (f === 'text') { renderTimeline(); }
  }
  requestDraw();
}

/* ---------------- 10. 미디어 선택 ---------------- */
function pickBgmFile(file) {
  if (!file) return;
  if (S.audio.bgmUrl) URL.revokeObjectURL(S.audio.bgmUrl);
  S.audio.bgmUrl = URL.createObjectURL(file);
  S.audio.bgmName = file.name;
  $('#bgmName').textContent = file.name;

  if (A.bgmEl) {
    try { A.bgmEl.pause(); } catch (e) {}
    try { A.bgmEl.src = ''; } catch (e) {}
  }
  A.bgmSrc = null;
  const el = new Audio();
  el.src = S.audio.bgmUrl;
  el.loop = true;
  el.preload = 'auto';
  A.bgmEl = el;
  if (A.ctx) {
    try {
      A.bgmSrc = A.ctx.createMediaElementSource(el);
      A.bgmSrc.connect(A.bgmGain);
    } catch (e) {}
  }
  toast('배경음악: ' + file.name);
}
function clearBgm() {
  if (A.bgmEl) { try { A.bgmEl.pause(); } catch (e) {} A.bgmEl.src = ''; A.bgmEl = null; }
  A.bgmSrc = null;
  if (S.audio.bgmUrl) URL.revokeObjectURL(S.audio.bgmUrl);
  S.audio.bgmUrl = ''; S.audio.bgmName = '';
  $('#bgmName').textContent = '선택 안 함';
}

/* ---------------- 11. 내보내기 ---------------- */
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',   // MP4 · H.264 + AAC (아이폰/인스타 호환 최상)
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,opus',
    'video/mp4;codecs=avc1.42E01E',             // MP4 · H.264
    'video/mp4',                                // MP4 · 브라우저 기본 코덱
    'video/webm;codecs=vp9,opus',               // WebM 폴백
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const m of list) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return '';
}
function formatLabel(mime) {
  if (!mime) return '기본 형식';
  const mp4 = mime.indexOf('mp4') >= 0;
  const h264 = /avc1|h264|avc3/i.test(mime);
  const vp9 = /vp9|vp09/i.test(mime);
  const vp8 = /vp8|vp08/i.test(mime);
  if (mp4) return 'MP4' + (h264 ? ' · H.264' : vp9 ? ' · VP9' : '');
  return 'WebM' + (vp9 ? ' · VP9' : vp8 ? ' · VP8' : '');
}

function setProgress(p, status) {
  $('#expBar').style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%';
  if (status) $('#expStatus').textContent = status;
}
function showExportModal(show) { $('#exportModal').hidden = !show; }

function primeVideosForIOS() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  S.clips.forEach((c) => {
    const v = c.video;
    try {
      v.muted = true;
      const p = v.play();
      if (p && p.then) p.then(() => { v.pause(); v.muted = false; }).catch(() => { v.muted = false; });
      else { v.pause(); v.muted = false; }
    } catch (e) { v.muted = false; }
  });
}

async function doExport() {
  if (X.running) return;
  const { total } = layout();
  if (!total) { toast('먼저 영상을 추가해 주세요.'); return; }
  if (typeof MediaRecorder === 'undefined') {
    toast('이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않아요. iOS 17 이상 Safari 또는 최신 Chrome을 사용해 주세요.', 6000);
    return;
  }
  const mime = pickMime();
  if (mime === null) { toast('이 브라우저에서는 내보내기를 지원하지 않아요.', 5000); return; }
  if (total > LIMIT) {
    if (!window.confirm('전체 길이가 ' + fmtSec(total) + ' 로 40초를 넘었어요.\n쇼츠·릴스에서 잘릴 수 있습니다. 그대로 내보낼까요?')) return;
  }

  pausePlayback();
  primeVideosForIOS();
  ensureAudio();
  attachAllAudio();
  if (A.ctx && A.ctx.state === 'suspended') { try { await A.ctx.resume(); } catch (e) {} }
  if (A.master) A.master.gain.value = 1;   // 녹화에는 항상 소리를 담는다

  const res = clamp(+$('#expRes').value || 720, 360, 1080);
  const W = res, H = Math.round(res * 16 / 9);
  const fps = clamp(+$('#expFps').value || 30, 15, 60);

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { alpha: false });

  let stream = null;
  try {
    if (cv.captureStream) stream = cv.captureStream(fps);
  } catch (e) { stream = null; }
  if (!stream || !stream.getVideoTracks().length) {
    try { stream = cv.captureStream(0); } catch (e) { stream = null; }
  }
  if (!stream || !stream.getVideoTracks().length) {
    toast('이 브라우저에서는 캔버스 녹화를 지원하지 않아요. iOS는 Safari 최신 버전에서 시도해 주세요.', 6000);
    return;
  }
  if (A.streamDest) {
    A.streamDest.stream.getAudioTracks().forEach((tr) => { try { stream.addTrack(tr); } catch (e) {} });
  }

  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? {
      mimeType: mime,
      videoBitsPerSecond: res >= 1080 ? 8000000 : res >= 720 ? 5000000 : 3000000,
      audioBitsPerSecond: 128000
    } : undefined);
  } catch (e) {
    try { rec = new MediaRecorder(stream); }
    catch (e2) { toast('녹화기를 시작할 수 없어요: ' + e2.message, 5000); return; }
  }

  const chunks = [];
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };

  X.running = true; X.cancel = false; X.rec = rec;
  $('#btnExport').disabled = true;
  showExportModal(true);
  setProgress(0, '녹화 준비 중…');

  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  try { rec.start(400); } catch (e) { toast('녹화 시작 실패: ' + e.message, 5000); X.running = false; showExportModal(false); $('#btnExport').disabled = false; return; }

  // 첫 프레임
  S.clips.forEach((c) => { c.__active = false; });
  drawFrame(ctx, W, H, 0);

  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      if (X.cancel) { resolve(); return; }
      const el = (performance.now() - t0) / 1000;
      const t = Math.min(el, total);
      syncMedia(t, true);
      drawFrame(ctx, W, H, t);
      setProgress(t / total, '녹화 중… ' + Math.round((t / total) * 100) + '% · ' + fmtClock(t) + ' / ' + fmtClock(total));
      if (el >= total) { resolve(); return; }
      X.raf = requestAnimationFrame(step);
    };
    X.raf = requestAnimationFrame(step);
  });

  // 종료
  cancelAnimationFrame(X.raf);
  resetVideos();
  if (A.bgmEl && !A.bgmEl.paused) { try { A.bgmEl.pause(); } catch (e) {} }
  setProgress(1, '마무리 중…');
  try { rec.stop(); } catch (e) {}
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 4000))]);

  stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });

  const cancelled = X.cancel;
  X.running = false; X.cancel = false; X.rec = null;
  if (A.master) A.master.gain.value = P.muted ? 0 : 1;   // 미리보기 음소거 상태 복원
  $('#btnExport').disabled = false;
  showExportModal(false);

  if (cancelled) { toast('내보내기를 중단했어요.'); return; }

  const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
  const blob = new Blob(chunks, { type: type });
  if (!blob.size || blob.size < 2000) {
    toast('영상이 만들어지지 않았어요. 다시 시도하거나 해상도를 낮춰 주세요.', 5000);
    return;
  }
  const ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
  const d = new Date();
  const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  const name = 'shorts-' + stamp + '.' + ext;
  const url = URL.createObjectURL(blob);

  const rv = $('#resultVideo');
  rv.src = url;
  const a = $('#btnDownload');
  a.href = url;
  a.download = name;
  a.textContent = ext.toUpperCase() + ' 다운로드';
  $('#resultInfo').textContent = name + ' · ' + fmtSize(blob.size) + ' · ' + fmtSec(total) + ' · ' + W + '×' + H + ' · ' + formatLabel(rec.mimeType || mime);
  $('#resultCard').hidden = false;
  switchTab('export');
  setTimeout(() => { $('#resultCard').scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60);
  toast('내보내기 완료! 다운로드 버튼을 눌러 저장하세요.', 4000);
  P.time = 0;
  seekTo(0);
}

/* ---------------- 12. 탭 ---------------- */
function switchTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  $('#panes').scrollTop = 0;
}

/* ---------------- 13. 이벤트 배선 ---------------- */
function bindUI() {
  // 파일 선택
  const fileInput = $('#fileInput');
  const openPicker = () => fileInput.click();
  ['#btnAddTop', '#btnAddClip', '#btnAddEmpty'].forEach((sel) => { const el = $(sel); if (el) el.onclick = openPicker; });
  fileInput.onchange = (e) => { addFiles(e.target.files); fileInput.value = ''; };

  // 드래그 앤 드롭
  const frame = $('#previewFrame');
  ['dragenter', 'dragover'].forEach((ev) => frame.addEventListener(ev, (e) => { e.preventDefault(); frame.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => frame.addEventListener(ev, (e) => { e.preventDefault(); frame.classList.remove('dragover'); }));
  frame.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

  // 재생 컨트롤
  $('#btnPlay').onclick = () => (P.playing ? pausePlayback() : startPlayback());
  $('#btnBack').onclick = () => seekTo(P.time - 1);
  $('#scrub').oninput = (e) => { seekTo(parseFloat(e.target.value) || 0); };
  $('#btnLoop').onclick = () => { P.loop = !P.loop; $('#btnLoop').classList.toggle('on', P.loop); };

  const syncSafe = (on) => {
    $('#safeZone').hidden = !on;
    $('#btnSafe').classList.toggle('on', on);
    $('#safeToggle').checked = on;
  };
  $('#btnSafe').onclick = () => syncSafe($('#safeZone').hidden);
  $('#safeToggle').onchange = (e) => syncSafe(e.target.checked);

  // 탭
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  // 클립 목록
  $('#clipList').addEventListener('click', (e) => {
    const item = e.target.closest('.clipItem');
    if (!item) return;
    const id = item.dataset.id;
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const act = btn.dataset.act;
      if (act === 'del') { if (window.confirm('이 클립을 삭제할까요?')) removeClip(id); return; }
      if (act === 'up') { moveClip(id, -1); return; }
      if (act === 'down') { moveClip(id, 1); return; }
    }
    S.selectedClipId = id;
    renderClips();
    renderClipProps();
  });

  // 클립 속성
  const props = $('#clipProps');
  props.addEventListener('input', (e) => {
    const c = S.clips.find((x) => x.id === S.selectedClipId);
    if (!c) return;
    const f = e.target.dataset.c;
    if (!f) return;
    const v = parseFloat(e.target.value);
    if (isNaN(v)) return;
    if (f === 'trimStart') c.trimStart = clamp(v, 0, c.trimEnd - 0.1);
    else if (f === 'trimEnd') c.trimEnd = clamp(v, c.trimStart + 0.1, c.duration);
    else if (f === 'trimStartNum') c.trimStart = clamp(v, 0, c.trimEnd - 0.1);
    else if (f === 'trimEndNum') c.trimEnd = clamp(v, c.trimStart + 0.1, c.duration);
    else if (f === 'speed') c.speed = clamp(v, 0.5, 2);
    // 표시 갱신(재렌더 없이)
    const row = e.target.closest('.sliderRow');
    if (row && row.querySelector('output')) {
      row.querySelector('output').textContent = f === 'speed' ? c.speed.toFixed(2) + 'x' : (f.indexOf('trimStart') === 0 ? c.trimStart : c.trimEnd).toFixed(1) + 's';
    }
    const hint = props.querySelector('[data-hint]');
    if (hint) hint.textContent = '사용 구간 ' + (c.trimEnd - c.trimStart).toFixed(1) + '초 → 재생 ' + clipDur(c).toFixed(1) + '초';
    refreshTime(); renderTimeline();
    if (!P.playing) syncMedia(P.time, false);
    requestDraw();
  });
  props.addEventListener('click', (e) => {
    const c = S.clips.find((x) => x.id === S.selectedClipId);
    if (!c) return;
    const btn = e.target.closest('[data-cact]');
    if (!btn) return;
    const act = btn.dataset.cact;
    if (act === 'inAt') {
      c.trimStart = clamp(P.time >= 0 ? Math.min(P.time, c.trimEnd - 0.1) : 0, 0, c.trimEnd - 0.1);
    } else if (act === 'outAt') {
      c.trimEnd = clamp(Math.max(P.time, c.trimStart + 0.1), c.trimStart + 0.1, c.duration);
    } else if (act === 'speed') {
      c.speed = parseFloat(btn.dataset.v);
    }
    renderClipProps(); renderClips(); refreshTime(); renderTimeline(); requestDraw();
  });
  props.addEventListener('change', (e) => { if (e.target.dataset.c) renderClips(); });

  // 전환/페이드
  $('#transitionRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-trans]');
    if (!b) return;
    S.transition = b.dataset.trans;
    $$('#transitionRow .seg').forEach((x) => x.classList.toggle('on', x.dataset.trans === S.transition));
    refreshTime(); renderTimeline(); requestDraw();
  });
  const bindRange = (id, out, apply, suffix) => {
    const el = $(id);
    el.oninput = () => {
      const v = parseFloat(el.value);
      apply(v);
      $(out).textContent = (suffix ? v.toFixed(suffix === 'x' ? 2 : 1) + suffix : v.toFixed(1) + '초');
      refreshTime(); renderTimeline(); requestDraw();
    };
  };
  bindRange('#transDur', '#transDurOut', (v) => { S.transDur = v; }, null);
  bindRange('#fadeIn', '#fadeInOut', (v) => { S.fadeIn = v; }, null);
  bindRange('#fadeOut', '#fadeOutOut', (v) => { S.fadeOut = v; }, null);

  // 자막
  $('#btnAddCap').onclick = addCaption;
  const capList = $('#capList');
  const capEvent = (e) => {
    const card = e.target.closest('.capCard');
    if (!card) return;
    updateCaptionFromEl(card, e.target);
  };
  capList.addEventListener('input', capEvent);
  capList.addEventListener('change', (e) => {
    capEvent(e);
    if (e.target.dataset.f === 'bg' || e.target.dataset.f === 'outline') return;
  });
  capList.addEventListener('click', (e) => {
    const card = e.target.closest('.capCard');
    if (!card) return;
    const id = card.dataset.id;
    const c = S.captions.find((x) => x.id === id);
    if (!c) return;
    const btn = e.target.closest('[data-cap]');
    if (!btn) { S.selectedCapId = id; return; }
    const act = btn.dataset.cap;
    if (act === 'del') {
      S.captions = S.captions.filter((x) => x.id !== id);
      renderCaptions(); renderTimeline(); requestDraw();
    } else if (act === 'setStart') {
      c.start = clamp(P.time, 0, c.end - 0.2);
      renderCaptions(); renderTimeline(); requestDraw();
    } else if (act === 'setEnd') {
      c.end = Math.max(P.time, c.start + 0.2);
      renderCaptions(); renderTimeline(); requestDraw();
    } else if (act === 'pos') {
      c.pos = btn.dataset.pos;
      $$('.posRow .seg', card).forEach((x) => x.classList.toggle('on', x.dataset.pos === c.pos));
      requestDraw();
    }
  });

  // 상단 제목
  const titleIds = ['#titleOn', '#titleText', '#titleMode', '#titleSize', '#titleStart', '#titleEnd', '#titleColor', '#titleBg'];
  const syncTitle = () => {
    S.title.on = $('#titleOn').checked;
    S.title.text = $('#titleText').value;
    S.title.mode = $('#titleMode').value;
    S.title.size = parseFloat($('#titleSize').value) || 34;
    S.title.start = parseFloat($('#titleStart').value) || 0;
    S.title.end = parseFloat($('#titleEnd').value) || 0;
    S.title.color = $('#titleColor').value;
    S.title.bg = $('#titleBg').value;
    $('#titleRange').style.display = S.title.mode === 'intro' ? 'grid' : 'none';
    renderTimeline();
    requestDraw();
  };
  titleIds.forEach((id) => { const el = $(id); el.addEventListener('input', syncTitle); el.addEventListener('change', syncTitle); });

  // 사운드
  const vv = $('#videoVol');
  vv.oninput = () => {
    S.audio.videoVolume = parseFloat(vv.value) / 100;
    $('#videoVolOut').textContent = vv.value + '%';
    applyVideoVolume();
  };
  const bv = $('#bgmVol');
  bv.oninput = () => {
    S.audio.bgmVolume = parseFloat(bv.value) / 100;
    $('#bgmVolOut').textContent = bv.value + '%';
  };
  $('#bgmFadeIn').oninput = (e) => { S.audio.bgmFadeIn = Math.max(0, parseFloat(e.target.value) || 0); };
  $('#bgmFadeOut').oninput = (e) => { S.audio.bgmFadeOut = Math.max(0, parseFloat(e.target.value) || 0); };
  $('#btnBgmPick').onclick = () => $('#bgmInput').click();
  $('#bgmInput').onchange = (e) => { pickBgmFile(e.target.files[0]); e.target.value = ''; };
  $('#btnBgmClear').onclick = clearBgm;
  $('#mutePreview').onchange = (e) => {
    P.muted = e.target.checked;
    if (A.master) A.master.gain.value = P.muted ? 0 : 1;
  };

  // 스타일
  const syncFill = () => {
    $$('#fillRow .seg').forEach((b) => {
      const f = b.dataset.fill;
      const on = (f === 'cover' && S.fillMode === 'cover') ||
                 (f === 'contain' && S.fillMode === 'contain' && S.bgMode === 'blur') ||
                 (f === 'containColor' && S.fillMode === 'contain' && S.bgMode === 'color');
      b.classList.toggle('on', on);
    });
  };
  $('#fillRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fill]');
    if (!b) return;
    const f = b.dataset.fill;
    if (f === 'cover') { S.fillMode = 'cover'; }
    else if (f === 'contain') { S.fillMode = 'contain'; S.bgMode = 'blur'; }
    else { S.fillMode = 'contain'; S.bgMode = 'color'; }
    syncFill(); requestDraw();
  });
  const bindOffset = (id, out, key) => {
    const el = $(id);
    el.oninput = () => { S[key] = parseFloat(el.value); $(out).textContent = el.value; requestDraw(); };
  };
  bindOffset('#offX', '#offXOut', 'offX');
  bindOffset('#offY', '#offYOut', 'offY');
  $('#bgColor').oninput = (e) => { S.bgColor = e.target.value; requestDraw(); };
  $('#btnResetFit').onclick = () => {
    S.offX = 0; S.offY = 0;
    $('#offX').value = 0; $('#offY').value = 0;
    $('#offXOut').textContent = '0'; $('#offYOut').textContent = '0';
    requestDraw();
  };
  $('#filterRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    S.filter = b.dataset.filter;
    $$('#filterRow .filterBtn').forEach((x) => x.classList.toggle('on', x.dataset.filter === S.filter));
    requestDraw();
  });
  $('#speedRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-speed]');
    if (!b) return;
    S.globalSpeed = parseFloat(b.dataset.speed);
    $$('#speedRow .seg').forEach((x) => x.classList.toggle('on', parseFloat(x.dataset.speed) === S.globalSpeed));
    refreshTime(); renderTimeline(); renderClips(); renderClipProps(); requestDraw();
  });

  // 타임라인 시크
  const tl = $('#timeline');
  let dragging = false;
  const seekFromEvent = (e) => {
    const r = tl.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    pauseIfPlaying();
    seekTo(x * layout().total);
  };
  let wasPlaying = false;
  const pauseIfPlaying = () => { if (P.playing) { wasPlaying = true; pausePlayback(); } };
  const resumeIfWas = () => { if (wasPlaying) { wasPlaying = false; startPlayback(); } };
  tl.addEventListener('pointerdown', (e) => {
    e.preventDefault();            // 이미지 네이티브 드래그가 포인터 이벤트를 끊지 않도록
    dragging = true;
    seekFromEvent(e);
    try { tl.setPointerCapture(e.pointerId); } catch (err) {}
  });
  tl.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e); });
  tl.addEventListener('pointerup', (e) => { dragging = false; resumeIfWas(); });
  tl.addEventListener('pointercancel', () => { dragging = false; resumeIfWas(); });
  tl.addEventListener('click', (e) => {
    const clipEl = e.target.closest('.tlclip');
    if (clipEl) { S.selectedClipId = clipEl.dataset.id; renderClips(); renderClipProps(); switchTab('clips'); }
  });

  // 내보내기
  $('#btnExport').onclick = doExport;
  $('#btnExportTop').onclick = () => { switchTab('export'); doExport(); };

  $('#expRes').onchange = () => updateExpSummary(layout().total);
  $('#expFps').onchange = () => updateExpSummary(layout().total);
  $('#expCancel').onclick = () => { X.cancel = true; };
  $('#btnExportAgain').onclick = () => { doExport(); };

  // 키보드
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.code === 'Space') { e.preventDefault(); P.playing ? pausePlayback() : startPlayback(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(P.time - (e.shiftKey ? 1 : 0.1)); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(P.time + (e.shiftKey ? 1 : 0.1)); }
  });

  // 화면 회전/리사이즈 시 다시 그리기
  window.addEventListener('resize', () => { requestDraw(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && P.playing) pausePlayback(); });
}

function initStyleControls() {
  $$('#fillRow .seg').forEach((b) => {
    const f = b.dataset.fill;
    b.classList.toggle('on', (f === 'cover' && S.fillMode === 'cover') ||
      (f === 'contain' && S.fillMode === 'contain' && S.bgMode === 'blur') ||
      (f === 'containColor' && S.fillMode === 'contain' && S.bgMode === 'color'));
  });
  $$('#transitionRow .seg').forEach((b) => b.classList.toggle('on', b.dataset.trans === S.transition));
  $$('#speedRow .seg').forEach((b) => b.classList.toggle('on', parseFloat(b.dataset.speed) === S.globalSpeed));
  $('#filterRow').innerHTML = Object.keys(FILTERS).filter((k) => k !== 'swatch').map((k) =>
    '<button class="filterBtn ' + (S.filter === k ? 'on' : '') + '" data-filter="' + k + '">' +
      '<span class="sw" style="background:' + FILTERS.swatch[k] + '"></span>' + FILTERS[k].label +
    '</button>'
  ).join('');
}

/* ---------------- 14. 시작 ---------------- */
function init() {
  initStyleControls();
  bindUI();
  $('#titleRange').style.display = 'none';
  refreshAll();
  drawFrame(previewCtx, PREVIEW_W, PREVIEW_H, 0);
  // 콘솔에서 상태를 확인할 수 있게(디버그용)
  window.__shortsEditor = { S, A, P, layout, drawFrame, seekTo, refreshAll, drawPreview: requestDraw };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
