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
  audio: { videoVolume: 1, bgmVolume: 0.6, bgmFadeIn: 0.5, bgmFadeOut: 1, bgmName: '', bgmKind: '', bgmPreset: '' },
  sfx: [],
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

const A = { ctx: null, master: null, streamDest: null, bgmGain: null, sfxBus: null };
/* AG: 타임라인 오디오(BGM·효과음) 재생 상태 */
const AG = {
  bgmBuffer: null,     // 지금 BGM 트랙의 오디오 버퍼(내장 생성 또는 내 파일 디코딩)
  bgmKind: '',         // 'preset' | 'file' | ''
  bgmKey: '',          // 내장 BGM 프리셋 키
  bgmNode: null,       // 재생 중인 BGM 소스 노드
  sfxNodes: [],        // 예약된 효과음 소스 노드
  started: false,
  wallStart: 0
};
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
    A.sfxBus = A.ctx.createGain();
    A.sfxBus.gain.value = 1;
    A.sfxBus.connect(A.master);
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

/* ---------------- 3-2. 타임라인 오디오 재생(BGM + 효과음) ---------------- */
function stopNode(n) {
  if (!n) return;
  try { n.stop(); } catch (e) {}
  try { n.disconnect(); } catch (e) {}
}
function audioStop() {
  if (AG.bgmNode) { stopNode(AG.bgmNode); AG.bgmNode = null; }
  AG.sfxNodes.forEach(stopNode);
  AG.sfxNodes = [];
  AG.started = false;
}

/** 타임라인 t초부터 오디오를 켠다. 반환값은 그 시점의 performance.now() 기준 시각. */
function audioStartAt(t, lead) {
  const ctx = ensureAudio();
  const now = performance.now();
  if (!ctx) return now;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  audioStop();
  const wait = lead == null ? 0.04 : lead;
  const startAt = ctx.currentTime + wait;
  AG.started = true;
  AG.wallStart = now + wait * 1000;

  if (AG.bgmBuffer && AG.bgmBuffer.duration > 0.06) {
    const src = ctx.createBufferSource();
    src.buffer = AG.bgmBuffer;
    src.loop = true;
    src.connect(A.bgmGain);
    const off = t % AG.bgmBuffer.duration;
    try { src.start(startAt, clamp(off, 0, AG.bgmBuffer.duration - 0.001)); }
    catch (e) { try { src.start(startAt); } catch (e2) {} }
    AG.bgmNode = src;
  }

  // 앞으로 나올 효과음만 미리 예약(지나간 것은 울리지 않게)
  S.sfx.forEach((ev) => {
    if (ev.time < t - 0.02) return;
    scheduleSfx(ev, startAt + Math.max(0, ev.time - t));
  });
  return AG.wallStart;
}

function scheduleSfx(ev, whenCtx) {
  const ctx = A.ctx;
  if (!ctx) return;
  const buf = audioBufferFor('sfx:' + ev.key);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = clamp(ev.vol == null ? 0.8 : ev.vol, 0, 2);
  src.connect(g);
  g.connect(A.sfxBus);
  try { src.start(Math.max(ctx.currentTime, whenCtx)); } catch (e) { return; }
  AG.sfxNodes.push(src);
  src.onended = () => {
    try { g.disconnect(); } catch (e) {}
    const i = AG.sfxNodes.indexOf(src);
    if (i >= 0) AG.sfxNodes.splice(i, 1);
  };
}

/** 효과음 하나를 지금 바로 울린다(미리듣기). */
function playSfxNow(key, vol) {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const buf = audioBufferFor('sfx:' + key);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = clamp(vol == null ? 0.8 : vol, 0, 2);
  src.connect(g);
  g.connect(A.sfxBus);
  try { src.start(); } catch (e) { return; }
  src.onended = () => { try { g.disconnect(); } catch (e) {} };
}

/* ---------------- 3-3. 내장 사운드 합성기 (외부 음원·네트워크 없이 100% 코드로 생성) ---------------- */
const SR = 44100;
const RAW = {};    // key → Float32Array (합성 결과)
const ABUF = {};   // key → AudioBuffer (재생용 캐시)

const NOTE_IDX = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
function hz(name) {
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!m) return 440;
  const midi = (parseInt(m[2], 10) + 1) * 12 + NOTE_IDX[m[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* 단음(오실레이터) 한 개를 버퍼에 더한다. harm=[[배음, 세기],...]으로 음색 결정
   ※ 사인 테이블 + 곱셈 감쇠로 샘플당 exp·sin 호출 없이 처리(아이폰에서도 즉시 생성) */
const SINE_N = 8192;
const SINE = new Float32Array(SINE_N);
for (let i = 0; i < SINE_N; i++) SINE[i] = Math.sin((2 * Math.PI * i) / SINE_N);
const TAU = Math.PI * 2;

function voice(buf, o) {
  const t0 = Math.round((o.t || 0) * SR);
  const dur = o.dur || 0.4;
  const n = Math.round(dur * SR);
  const f0 = o.f || 440;
  const fEnd = o.f1 == null ? f0 : o.f1;
  const amp = o.amp == null ? 0.2 : o.amp;
  const attN = Math.max(1, Math.round((o.att == null ? 0.004 : o.att) * SR));
  const decN = Math.max(1, (o.dec == null ? dur : o.dec) * SR);
  const fall = Math.exp(-1 / decN);
  const relN = o.rel ? Math.round(o.rel * SR) : 0;
  const vib = o.vib || 0, vibStep = TAU * (o.vibRate || 5) / SR;
  const harm = (o.harm && o.harm.length) ? o.harm : [[1, 1]];
  const nh = harm.length;
  const wrap = o.wrap !== false;
  const len = buf.length;
  const step = n > 1 && Math.abs(fEnd - f0) > 0.01 ? Math.pow(fEnd / f0, 1 / n) : 1;
  let f = f0;
  let phase = o.phase || 0;
  let env = 1;
  let vibP = 0;
  const k = SINE_N / TAU;
  for (let i = 0; i < n; i++) {
    if (step !== 1) f *= step;
    let fi = f;
    if (vib) { vibP += vibStep; fi *= 1 + vib * Math.sin(vibP); }
    phase += TAU * fi / SR;
    if (phase >= TAU) phase -= TAU;
    const ph = (phase * k) | 0;
    let v = 0;
    for (let h = 0; h < nh; h++) {
      const mul = harm[h][0] | 0;
      let idx = (ph * mul) % SINE_N;
      v += harm[h][1] * SINE[idx];
    }
    env *= fall;
    let e = env;
    if (i < attN) e *= i / attN;
    if (relN && i > n - relN) e *= (n - i) / relN;
    const idx2 = t0 + i;
    const j = wrap ? idx2 % len : idx2;
    if (j < len) buf[j] += v * amp * e;
  }
}

/* 노이즈(로우패스 계수 lp0→lp1로 스윘, hp면 하이패스) */
function noise(buf, o) {
  const t0 = Math.round((o.t || 0) * SR);
  const dur = o.dur || 0.2;
  const n = Math.round(dur * SR);
  const amp = o.amp == null ? 0.2 : o.amp;
  const attN = Math.max(1, Math.round((o.att == null ? 0.002 : o.att) * SR));
  const decN = Math.max(1, (o.dec == null ? dur : o.dec) * SR);
  const fall = Math.exp(-1 / decN);
  const c0 = o.lp0 == null ? (o.lp == null ? 1 : o.lp) : o.lp0;
  const c1 = o.lp1 == null ? c0 : o.lp1;
  const dc = n > 1 ? (c1 - c0) / n : 0;
  const hp = !!o.hp;
  const relN = o.rel ? Math.round(o.rel * SR) : 0;
  const wrap = o.wrap !== false;
  const len = buf.length;
  let lp = 0, lp2 = 0, env = 1, c = c0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    c += dc;
    lp += (w - lp) * c;
    let s = lp;
    if (hp) { lp2 += (lp - lp2) * 0.02; s = (lp - lp2) * 2.4; }
    env *= fall;
    let e = env;
    if (i < attN) e *= i / attN;
    if (relN && i > n - relN) e *= (n - i) / relN;
    const idx = t0 + i;
    const j = wrap ? idx % len : idx;
    if (j < len) buf[j] += s * amp * e;
  }
}

/* 드럼 몇 가지 */
function kick(buf, t, amp, o) {
  o = o || {};
  voice(buf, { t: t, dur: o.dur || 0.42, f: o.f || 152, f1: o.f1 || 44, dec: o.dec || 0.10,
    att: 0.0015, amp: amp, harm: [[1, 1], [2, 0.16]], wrap: o.wrap });
}
function hat(buf, t, amp, open) {
  noise(buf, { t: t, dur: open ? 0.18 : 0.06, amp: amp, att: 0.001,
    dec: open ? 0.055 : 0.012, lp: 0.88, hp: true });
}
function snare(buf, t, amp) {
  noise(buf, { t: t, dur: 0.2, amp: amp * 1.5, att: 0.001, dec: 0.055, lp: 0.75 });
  voice(buf, { t: t, dur: 0.12, f: 196, f1: 150, dec: 0.045, amp: amp * 0.8, harm: [[1, 1], [2, 0.4]] });
}
function clap(buf, t, amp) {
  [0, 0.011, 0.024, 0.038].forEach((d, i) => {
    noise(buf, { t: t + d, dur: 0.14, amp: amp * (i === 3 ? 1.1 : 0.65), att: 0.001, dec: 0.035, lp: 0.82 });
  });
}

/* 마무리: 정규화 + 부드러운 리미터 */
function finish(buf, peak) {
  let mx = 0;
  for (let i = 0; i < buf.length; i++) { const a = buf[i] < 0 ? -buf[i] : buf[i]; if (a > mx) mx = a; }
  if (mx < 1e-5) return buf;
  const g = (peak || 0.84) / mx;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] * g;
    buf[i] = v / (1 + (v < 0 ? -v : v) * 0.22);
  }
  return buf;
}
/* 전체에 1차 로우패스(따뜻한 소리) */
function soften(buf, cutoff) {
  const c = 1 - Math.exp(-2 * Math.PI * cutoff / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y += (buf[i] - y) * c; buf[i] = y; }
  return buf;
}

/* ---------- 무료 BGM 5종 ---------- */
function buildVlog() {
  const bpm = 120, beat = 60 / bpm, bar = beat * 4, bars = 8;
  const buf = new Float32Array(Math.round(bar * bars * SR));
  const prog = [['C4', 'E4', 'G4'], ['G3', 'B3', 'D4'], ['A3', 'C4', 'E4'], ['F3', 'A3', 'C4']];
  const seq = [0, 1, 2, 1, 0, 2, 1, 2];
  for (let b = 0; b < bars; b++) {
    const chord = prog[Math.floor(b / 2) % 4];
    const t0 = b * bar;
    chord.forEach((nn) => voice(buf, {
      t: t0, f: hz(nn), dur: bar * 1.05, dec: bar * 1.1, amp: 0.055, att: 0.06,
      harm: [[1, 1], [2, 0.16], [3, 0.05]]
    }));
    voice(buf, { t: t0, f: hz(chord[0]) / 2, dur: bar * 0.9, dec: 0.85, amp: 0.20, harm: [[1, 1], [2, 0.24]] });
    voice(buf, { t: t0 + 2 * beat, f: hz(chord[0]) / 2, dur: bar * 0.45, dec: 0.5, amp: 0.15, harm: [[1, 1], [2, 0.22]] });
    for (let i = 0; i < 8; i++) {
      voice(buf, {
        t: t0 + i * beat / 2, f: hz(chord[seq[i] % 3]) * 2, dur: 0.42, dec: 0.12,
        amp: 0.085, harm: [[1, 1], [2, 0.32], [3, 0.10], [4, 0.04]]
      });
    }
    for (let k = 0; k < 4; k++) {
      const tt = t0 + k * beat;
      if (k === 0 || k === 2) kick(buf, tt, 0.5);
      if (k === 1 || k === 3) snare(buf, tt, 0.12);
      hat(buf, tt + beat / 2, 0.06);
      hat(buf, tt, 0.03);
    }
    if (b % 4 === 3) {
      [0, 1, 2].forEach((i) => voice(buf, {
        t: t0 + bar - beat + i * beat / 3, f: hz(chord[2]) * (i === 2 ? 4 : 2), dur: 0.5, dec: 0.16,
        amp: 0.07, harm: [[1, 1], [2, 0.3], [3, 0.12]]
      }));
    }
  }
  return finish(buf, 0.82);
}

function buildLofi() {
  const bpm = 75, beat = 60 / bpm, bar = beat * 4, bars = 4;
  const buf = new Float32Array(Math.round(bar * bars * SR));
  const prog = [['F3', 'A3', 'C4', 'E4'], ['E3', 'G3', 'B3', 'D4'], ['D3', 'F3', 'A3', 'C4'], ['C3', 'E3', 'G3', 'B3']];
  for (let b = 0; b < bars; b++) {
    const chord = prog[b % 4];
    const t0 = b * bar;
    [0, 2.5].forEach((bt, k) => {
      chord.forEach((nn, i) => voice(buf, {
        t: t0 + bt * beat + i * 0.012, f: hz(nn), dur: 2.4, dec: 1.15, amp: 0.075,
        att: 0.01, harm: [[1, 1], [2, 0.30], [3, 0.10], [4, 0.05]]
      }));
      if (k === 1) chord.slice(1, 3).forEach((nn) => voice(buf, {
        t: t0 + bt * beat + 0.02, f: hz(nn) * 2, dur: 1.6, dec: 0.7, amp: 0.035, att: 0.02,
        harm: [[1, 1], [2, 0.2]]
      }));
    });
    voice(buf, { t: t0, f: hz(chord[0]) / 2, dur: bar, dec: 1.5, amp: 0.17, harm: [[1, 1], [2, 0.2]] });
    voice(buf, { t: t0 + 2.5 * beat, f: hz(chord[1]) / 2, dur: bar * 0.5, dec: 0.8, amp: 0.11 });
    kick(buf, t0, 0.34, { dec: 0.12, f: 120 });
    kick(buf, t0 + 2.5 * beat, 0.26, { dec: 0.12, f: 110 });
    noise(buf, { t: t0 + 2 * beat, dur: 0.24, amp: 0.045, att: 0.002, dec: 0.07, lp: 0.45 });
    for (let i = 0; i < 8; i++) hat(buf, t0 + i * beat / 2, i % 2 ? 0.016 : 0.026, false);
  }
  // 바이닐 잡음 + 살짝 흔들리는 피아노
  noise(buf, { t: 0, dur: bar * bars, amp: 0.010, att: 0.4, dec: bar * bars, lp: 0.22, rel: 0.3 });
  for (let i = 0; i < 26; i++) {
    noise(buf, { t: Math.random() * bar * bars, dur: 0.02, amp: 0.03 + Math.random() * 0.03, att: 0.001, dec: 0.006, lp: 0.95, hp: true });
  }
  soften(buf, 3600);
  return finish(buf, 0.78);
}

function buildPop() {
  const bpm = 128, beat = 60 / bpm, bar = beat * 4, bars = 8;
  const buf = new Float32Array(Math.round(bar * bars * SR));
  const prog = [['C4', 'E4', 'G4'], ['G3', 'B3', 'D4'], ['A3', 'C4', 'E4'], ['F3', 'A3', 'C4']];
  const saw = [[1, 1], [2, 0.52], [3, 0.34], [4, 0.24], [5, 0.17], [6, 0.12], [7, 0.08]];
  for (let b = 0; b < bars; b++) {
    const chord = prog[Math.floor(b / 2) % 4];
    const t0 = b * bar;
    for (let k = 0; k < 4; k++) {
      const tt = t0 + k * beat;
      kick(buf, tt, 0.52, { dec: 0.085 });
      if (k === 1 || k === 3) clap(buf, tt, 0.16);
      hat(buf, tt + beat / 2, 0.05, true);
      hat(buf, tt, 0.03, false);
      // 오프비트 신스 코드
      chord.forEach((nn) => voice(buf, {
        t: tt + beat / 2, f: hz(nn) * 2, dur: 0.3, dec: 0.14, amp: 0.035, att: 0.006, harm: saw
      }));
      // 베이스 8분
      voice(buf, { t: tt + beat / 2, f: hz(chord[0]) / 2, dur: 0.3, dec: 0.16, amp: 0.16, harm: [[1, 1], [2, 0.3], [3, 0.12]] });
    }
    chord.forEach((nn) => voice(buf, {
      t: t0, f: hz(nn) * 2, dur: bar * 0.9, dec: 0.6, amp: 0.03, att: 0.02, harm: saw
    }));
    voice(buf, { t: t0, f: hz(chord[0]) / 2, dur: bar * 0.45, dec: 0.4, amp: 0.14 });
    // 리드 아르페지오 16분
    for (let i = 0; i < 8; i++) {
      voice(buf, {
        t: t0 + i * beat / 2, f: hz(chord[i % 3]) * 4, dur: 0.22, dec: 0.1, amp: 0.045,
        harm: [[1, 1], [2, 0.4], [3, 0.18]]
      });
    }
  }
  return finish(buf, 0.8);
}

function buildHiphop() {
  const bpm = 92, beat = 60 / bpm, bar = beat * 4, bars = 4;
  const buf = new Float32Array(Math.round(bar * bars * SR));
  const prog = [['A3', 'C4', 'E4'], ['F3', 'A3', 'C4'], ['C3', 'E3', 'G3'], ['G3', 'B3', 'D4']];
  for (let b = 0; b < bars; b++) {
    const chord = prog[b % 4];
    const t0 = b * bar;
    chord.forEach((nn, i) => voice(buf, {
      t: t0 + i * 0.01, f: hz(nn), dur: bar * 0.95, dec: 1.1, amp: 0.05, att: 0.02,
      harm: [[1, 1], [2, 0.22], [3, 0.08]]
    }));
    // 808 베이스(글라이드)
    voice(buf, { t: t0, dur: bar * 0.55, f: hz(chord[0]) / 2, f1: hz(chord[0]) / 2 * 0.94, dec: 0.55, amp: 0.34, harm: [[1, 1], [2, 0.28], [3, 0.08]] });
    voice(buf, { t: t0 + 2.5 * beat, dur: bar * 0.4, f: hz(chord[0]) / 2, dec: 0.4, amp: 0.26, harm: [[1, 1], [2, 0.24]] });
    kick(buf, t0, 0.44, { f: 130, dec: 0.13 });
    kick(buf, t0 + 1.75 * beat, 0.4, { f: 120, dec: 0.12 });
    kick(buf, t0 + 2.5 * beat, 0.36, { f: 120, dec: 0.12 });
    snare(buf, t0 + 2 * beat, 0.2);
    for (let i = 0; i < 8; i++) hat(buf, t0 + i * beat / 2, i % 2 ? 0.03 : 0.055, false);
    if (b % 2 === 1) for (let i = 0; i < 4; i++) hat(buf, t0 + 3.5 * beat + i * beat / 4, 0.028, false);
  }
  return finish(buf, 0.8);
}

function buildCalm() {
  const bpm = 60, beat = 60 / bpm, bar = beat * 4, bars = 4;
  const buf = new Float32Array(Math.round(bar * bars * SR));
  const prog = [['C3', 'G3', 'C4', 'E4'], ['A2', 'E3', 'A3', 'C4'], ['F2', 'C3', 'F3', 'A3'], ['G2', 'D3', 'G3', 'B3']];
  for (let b = 0; b < bars; b++) {
    const chord = prog[b % 4];
    const t0 = b * bar;
    chord.forEach((nn, i) => {
      voice(buf, { t: t0 + i * 0.05, f: hz(nn), dur: bar * 2, dec: bar * 1.8, amp: 0.06, att: 1.3, harm: [[1, 1], [2, 0.14], [3, 0.04]] });
      voice(buf, { t: t0 + i * 0.05, f: hz(nn) * 1.004, dur: bar * 2, dec: bar * 1.8, amp: 0.045, att: 1.5, harm: [[1, 1], [2, 0.10]] });
    });
    for (let i = 0; i < 4; i++) {
      voice(buf, {
        t: t0 + i * beat + 0.02, f: hz(chord[(i + 1) % chord.length]) * 4, dur: 1.5, dec: 0.5, amp: 0.028, att: 0.01,
        harm: [[1, 1], [2, 0.25], [3, 0.08]]
      });
    }
  }
  noise(buf, { t: 0, dur: bar * bars, amp: 0.008, att: 2, dec: bar * bars, lp: 0.12, rel: 0.6 });
  soften(buf, 5200);
  return finish(buf, 0.76);
}

/* ---------- 무료 효과음 6종 ---------- */
function sfxRing() {
  const buf = new Float32Array(Math.round(1.4 * SR));
  voice(buf, { t: 0, f: hz('E6'), dur: 1.2, dec: 0.34, amp: 0.34, att: 0.002, harm: [[1, 1], [2, 0.5], [3, 0.22], [4, 0.10], [5, 0.05]], wrap: false });
  voice(buf, { t: 0.14, f: hz('B6'), dur: 1.1, dec: 0.30, amp: 0.22, att: 0.002, harm: [[1, 1], [2, 0.42], [3, 0.18]], wrap: false });
  noise(buf, { t: 0, dur: 0.05, amp: 0.05, att: 0.001, dec: 0.012, lp: 0.9, hp: true, wrap: false });
  return finish(buf, 0.9);
}
function sfxWhoosh() {
  const buf = new Float32Array(Math.round(0.75 * SR));
  noise(buf, { t: 0, dur: 0.7, amp: 0.5, att: 0.30, dec: 0.30, lp0: 0.05, lp1: 0.55, hp: true, rel: 0.12, wrap: false });
  voice(buf, { t: 0.05, dur: 0.5, f: 900, f1: 220, amp: 0.06, att: 0.14, dec: 0.3, harm: [[1, 1], [2, 0.3]], wrap: false });
  return finish(buf, 0.85);
}
function sfxPop() {
  const buf = new Float32Array(Math.round(0.3 * SR));
  voice(buf, { t: 0, dur: 0.16, f: 1100, f1: 240, dec: 0.045, amp: 0.6, att: 0.002, harm: [[1, 1], [2, 0.22]], wrap: false });
  noise(buf, { t: 0, dur: 0.03, amp: 0.18, att: 0.001, dec: 0.008, lp: 0.9, hp: true, wrap: false });
  return finish(buf, 0.92);
}
function sfxTada() {
  const buf = new Float32Array(Math.round(1.9 * SR));
  const notes = [['C5', 0], ['E5', 0.10], ['G5', 0.20], ['C6', 0.32]];
  notes.forEach(([nn, t]) => voice(buf, {
    t: t, f: hz(nn), dur: 1.4, dec: 0.45, amp: 0.22, att: 0.003,
    harm: [[1, 1], [2, 0.45], [3, 0.2], [4, 0.1], [5, 0.05]], wrap: false
  }));
  ['E5', 'G5', 'C6', 'E6'].forEach((nn) => voice(buf, {
    t: 0.32, f: hz(nn), dur: 1.2, dec: 0.7, amp: 0.075, att: 0.02, harm: [[1, 1], [2, 0.2]], wrap: false
  }));
  noise(buf, { t: 0.30, dur: 0.5, amp: 0.10, att: 0.005, dec: 0.16, lp: 0.85, hp: true, wrap: false });
  return finish(buf, 0.9);
}
function sfxDun() {
  const buf = new Float32Array(Math.round(2.2 * SR));
  voice(buf, { t: 0, dur: 1.6, f: 104, f1: 33, dec: 0.55, amp: 0.55, att: 0.004, harm: [[1, 1], [2, 0.38], [3, 0.18]], wrap: false });
  noise(buf, { t: 0, dur: 0.8, amp: 0.30, att: 0.004, dec: 0.18, lp0: 0.35, lp1: 0.05, wrap: false });
  voice(buf, { t: 0.33, dur: 1.2, f: 78, f1: 34, dec: 0.45, amp: 0.16, att: 0.004, harm: [[1, 1], [2, 0.3]], wrap: false });
  return finish(buf, 0.92);
}
function sfxBoing() {
  const buf = new Float32Array(Math.round(0.7 * SR));
  voice(buf, { t: 0, dur: 0.16, f: 240, f1: 760, dec: 0.12, amp: 0.34, att: 0.003, harm: [[1, 1], [2, 0.18]], wrap: false });
  voice(buf, { t: 0.15, dur: 0.4, f: 780, f1: 300, dec: 0.16, amp: 0.3, att: 0.004, vib: 0.05, vibRate: 14, harm: [[1, 1], [2, 0.2]], wrap: false });
  return finish(buf, 0.9);
}

/* ---------- 목록과 접근자 ---------- */
const BGM_PRESETS = [
  { key: 'vlog', name: '경쾌한 브이로그', desc: '120 BPM · 밝은 플럭 + 가벼운 드럼', build: buildVlog },
  { key: 'lofi', name: '감성 로파이 피아노', desc: '75 BPM · 따뜻한 피아노 + 바이닐 잡음', build: buildLofi },
  { key: 'pop', name: '신나는 팝 신스', desc: '128 BPM · 신스 코드 + 클랩', build: buildPop },
  { key: 'hiphop', name: '힙한 리듬 비트', desc: '92 BPM · 808 베이스 + 트랩 햇', build: buildHiphop },
  { key: 'calm', name: '차분한 앰비언트', desc: '60 BPM · 넓은 패드 + 잔잔한 벨', build: buildCalm }
];
const SFX_PRESETS = [
  { key: 'ring', name: '띠링', desc: '알림 벨', build: sfxRing },
  { key: 'whoosh', name: '휘릭', desc: '전환 우쉬', build: sfxWhoosh },
  { key: 'pop', name: '팝', desc: '말풍선 톡', build: sfxPop },
  { key: 'tada', name: '짠!', desc: '성공 팡파레', build: sfxTada },
  { key: 'dun', name: '두둥', desc: '강조 임팩트', build: sfxDun },
  { key: 'boing', name: '뿅', desc: '레트로 튕김', build: sfxBoing }
];
const BGM_MAP = {}, SFX_MAP = {};
BGM_PRESETS.forEach((p) => { BGM_MAP[p.key] = p; });
SFX_PRESETS.forEach((p) => { SFX_MAP[p.key] = p; });

function rawFor(key) {
  if (RAW[key]) return RAW[key];
  const parts = key.split(':');
  const map = parts[0] === 'bgm' ? BGM_MAP : SFX_MAP;
  const def = map[parts[1]];
  if (!def) return new Float32Array(SR * 0.1);
  RAW[key] = def.build();
  return RAW[key];
}
function audioBufferFor(key) {
  if (!A.ctx) return null;
  if (!ABUF[key]) {
    const raw = rawFor(key);
    const b = A.ctx.createBuffer(1, raw.length, SR);
    b.getChannelData(0).set(raw);
    ABUF[key] = b;
  }
  return ABUF[key];
}

/* 화면이 한가할 때 미리 합성해 두어 ‘듣기·적용’을 누를 때 바로 울리게 */
let warmIdx = 0;
function warmSounds() {
  const list = BGM_PRESETS.map((p) => 'bgm:' + p.key).concat(SFX_PRESETS.map((p) => 'sfx:' + p.key));
  const next = () => {
    if (warmIdx >= list.length) return;
    const key = list[warmIdx++];
    try { rawFor(key); } catch (e) {}
    setTimeout(next, 60);
  };
  setTimeout(next, 60);
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

/* WebM·MediaRecorder로 만든 파일은 메타데이터에 길이가 없어 duration=Infinity로 나온다.
   끝 지점으로 한 번 시크하면 브라우저가 실제 길이를 계산해 준다. */
async function resolveDuration(video) {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('durationchange', check);
      video.removeEventListener('timeupdate', check);
      video.removeEventListener('loadeddata', check);
      resolve();
    };
    const check = () => { if (isFinite(video.duration) && video.duration > 0) finish(); };
    video.addEventListener('durationchange', check);
    video.addEventListener('timeupdate', check);
    video.addEventListener('loadeddata', check);
    setTimeout(finish, 4000);
    try { video.currentTime = 1e6; } catch (e) { finish(); }
  });
  const d = video.duration;
  if (isFinite(d) && d > 0) {
    try { video.currentTime = 0; } catch (e) {}
    return d;
  }
  return 0;
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

    let dur = 0;
    try {
      await once(video, 'loadedmetadata', 15000);
      dur = await resolveDuration(video);
      if (!(dur > 0)) throw new Error('bad duration');
    } catch (e) {
      toast('"' + file.name + '" 을(를) 읽지 못했어요. 다른 형식(MP4 권장)으로 변환해 주세요.', 4200);
      video.remove();
      URL.revokeObjectURL(url);
      continue;
    }
    const usable = Math.max(0.3, dur);
    const clip = {
      id: uid(), file, name: file.name, url, video,
      duration: usable, trimStart: 0, trimEnd: usable, speed: 1, poster: '', __active: false
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

  // BGM·효과음 게인(재생·내보내기 공통)
  if (A.bgmGain) A.bgmGain.gain.value = (P.muted && !X.running) ? 0 : (S.audio.bgmVolume * bgmFade(t));
}

function startPlayback() {
  const { total } = layout();
  if (total <= 0) { toast('먼저 영상을 추가해 주세요.'); return; }
  if (X.running) return;
  stopBgmPreview();
  ensureAudio();
  attachAllAudio();
  if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume().catch(() => {});
  if (A.master) A.master.gain.value = P.muted ? 0 : 1;
  if (P.time >= total - 0.03) P.time = 0;
  P.playing = true;
  P.base = P.time;
  P.t0 = performance.now();
  audioStartAt(P.time);
  updatePlayBtn();
  tick();
}

function pausePlayback() {
  P.playing = false;
  cancelAnimationFrame(P.raf);
  resetVideos();
  audioStop();
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
      audioStartAt(0);
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
  if (P.playing) audioStartAt(P.time);
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
  syncSfxTimeInput(t);
  updatePlayhead(t);
}
function syncSfxTimeInput(t) {
  const el = $('#sfxTime');
  if (!el || document.activeElement === el) return;
  el.value = (Math.round(clamp(t || 0, 0, 999) * 10) / 10).toFixed(1);
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
    '<li>사운드 <b>' + (AG.bgmBuffer ? (AG.bgmKind === 'preset' ? '내장 BGM' : '내 음악') : 'BGM 없음') +
      ' · 효과음 <b>' + S.sfx.length + '개</b></li>' +
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
  S.sfx.map((ev) => '<div class="tlsfx" style="left:' + clamp((ev.time / total) * 100, 0, 100).toFixed(3) + '%" title="효과음"></div>').join('') +
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
  renderBgmLibrary();
  renderSfxLibrary();
  renderSfxList();
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

/* ---------------- 10. 사운드: BGM·효과음 관리 ---------------- */
function setBgm(buffer, name, kind, key) {
  AG.bgmBuffer = buffer;
  AG.bgmKind = kind || '';
  AG.bgmKey = key || '';
  S.audio.bgmName = name || '';
  S.audio.bgmKind = kind || '';
  S.audio.bgmPreset = key || '';
  $('#bgmName').textContent = name || '선택 안 함';
  if (P.playing) audioStartAt(P.time);
  renderBgmLibrary();
  updateExpSummary(layout().total);
}

async function pickBgmFile(file) {
  if (!file) return;
  const ctx = ensureAudio();
  if (!ctx) { toast('이 브라우저에서는 소리를 쓸 수 없어요. 최신 Safari로 열어 주세요.', 5000); return; }
  toast('음악을 불러오는 중…', 1600);
  try {
    const ab = await file.arrayBuffer();
    const buf = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (b) => { if (!settled) { settled = true; resolve(b); } };
      const fail = (e) => { if (!settled) { settled = true; reject(e || new Error('decode')); } };
      try {
        const p = ctx.decodeAudioData(ab, done, fail);
        if (p && p.then) p.then(done, fail);
      } catch (e) { fail(e); }
    });
    setBgm(buf, file.name, 'file', '');
    toast('배경음악: ' + file.name);
  } catch (e) {
    toast('음악 파일을 읽지 못했어요. MP3 · M4A · WAV 로 다시 시도해 주세요.', 5000);
  }
}

function clearBgm() {
  setBgm(null, '', '', '');
  stopBgmPreview();
  toast('BGM을 제거했어요.');
}

/* 내장 BGM 적용/해제 · 미리듣기 */
let bgmPreview = null, bgmPreviewTimer = 0;
function stopBgmPreview() {
  if (bgmPreview) { stopNode(bgmPreview.src); try { bgmPreview.gain.disconnect(); } catch (e) {} bgmPreview = null; }
  clearTimeout(bgmPreviewTimer);
  $$('#bgmPresets [data-prev]').forEach((b) => { b.textContent = '▶'; b.classList.remove('on'); });
}
function toggleBgmPreview(key, btn) {
  const wasSame = bgmPreview && bgmPreview.key === key;
  stopBgmPreview();
  if (wasSame) return;
  const ctx = ensureAudio();
  if (!ctx) { toast('이 브라우저에서는 미리듣기를 쓸 수 없어요.'); return; }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const buf = audioBufferFor('bgm:' + key);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const g = ctx.createGain();
  g.gain.value = clamp(S.audio.bgmVolume, 0.05, 1.5);
  src.connect(g);
  g.connect(A.master);
  try { src.start(); } catch (e) { return; }
  bgmPreview = { key: key, src: src, gain: g };
  if (btn) { btn.textContent = '❚❚'; btn.classList.add('on'); }
  bgmPreviewTimer = setTimeout(() => { stopBgmPreview(); }, 12000);
}
function applyBgmPreset(key) {
  if (AG.bgmKind === 'preset' && AG.bgmKey === key) { clearBgm(); return; }
  const ctx = ensureAudio();
  if (!ctx) { toast('이 브라우저에서는 소리를 쓸 수 없어요. 최신 Safari로 열어 주세요.', 5000); return; }
  stopBgmPreview();
  const buf = audioBufferFor('bgm:' + key);
  const def = BGM_MAP[key];
  if (!buf || !def) return;
  setBgm(buf, '무료 BGM · ' + def.name, 'preset', key);
  toast('배경음악으로 ‘' + def.name + '’을 넣었어요.');
}

/* 효과음 */
function addSfx(key) {
  const def = SFX_MAP[key];
  if (!def) return;
  const { total } = layout();
  if (total <= 0) { toast('먼저 영상을 추가해 주세요.'); return; }
  let t = parseFloat(($('#sfxTime') || {}).value);
  if (!isFinite(t)) t = P.time;
  t = clamp(t, 0, total);
  const ev = { id: uid(), key: key, time: Math.round(t * 10) / 10, vol: 0.8 };
  S.sfx.push(ev);
  S.sfx.sort((a, b) => a.time - b.time);
  renderSfxList();
  renderTimeline();
  updateExpSummary(total);
  if (P.playing) audioStartAt(P.time);
  toast('‘' + def.name + '’ 효과음을 ' + fmtSec(ev.time) + ' 지점에 넣었어요.');
}
function removeSfx(id) {
  S.sfx = S.sfx.filter((e) => e.id !== id);
  renderSfxList();
  renderTimeline();
  updateExpSummary(layout().total);
  if (P.playing) audioStartAt(P.time);
}

function renderBgmLibrary() {
  const box = $('#bgmPresets');
  if (!box) return;
  if (!box.dataset.ready) {
    box.innerHTML = BGM_PRESETS.map((p) =>
      '<div class="presetItem" data-key="' + p.key + '">' +
        '<div class="presetMain">' +
          '<div class="presetName">' + escapeHtml(p.name) + '</div>' +
          '<div class="presetDesc">' + escapeHtml(p.desc) + '</div>' +
        '</div>' +
        '<div class="presetOps">' +
          '<button class="miniBtn" type="button" data-prev="' + p.key + '" title="미리듣기">▶</button>' +
          '<button class="btn small applyBtn" type="button" data-apply="' + p.key + '">적용</button>' +
        '</div>' +
      '</div>'
    ).join('');
    box.dataset.ready = '1';
  }
  $$('.presetItem', box).forEach((el) => {
    const on = AG.bgmKind === 'preset' && AG.bgmKey === el.dataset.key;
    el.classList.toggle('on', on);
    const b = el.querySelector('[data-apply]');
    if (b) b.textContent = on ? '해제' : '적용';
  });
}

function renderSfxLibrary() {
  const box = $('#sfxPresets');
  if (!box || box.dataset.ready) return;
  box.innerHTML = SFX_PRESETS.map((p) =>
    '<div class="presetItem" data-key="' + p.key + '">' +
      '<div class="presetMain">' +
        '<div class="presetName">' + escapeHtml(p.name) + '</div>' +
        '<div class="presetDesc">' + escapeHtml(p.desc) + '</div>' +
      '</div>' +
      '<div class="presetOps">' +
        '<button class="miniBtn" type="button" data-sfxplay="' + p.key + '" title="미리듣기">▶</button>' +
        '<button class="btn small" type="button" data-sfxadd="' + p.key + '">추가</button>' +
      '</div>' +
    '</div>'
  ).join('');
  box.dataset.ready = '1';
}

function renderSfxList() {
  const box = $('#sfxList');
  if (!box) return;
  const hint = $('#sfxEmptyHint');
  if (hint) hint.hidden = S.sfx.length > 0;
  box.innerHTML = S.sfx.map((ev) => {
    const def = SFX_MAP[ev.key];
    const v = Math.round((ev.vol == null ? 0.8 : ev.vol) * 100);
    return '<div class="sfxItem" data-id="' + ev.id + '">' +
      '<div class="sfxHead">' +
        '<span class="sfxName">' + escapeHtml(def ? def.name : ev.key) + '</span>' +
        '<span class="sfxAt">' + fmtClock(ev.time) + '</span>' +
        '<button class="miniBtn" type="button" data-sfxact="play" title="미리듣기">▶</button>' +
        '<button class="miniBtn del" type="button" data-sfxact="del" title="삭제">✕</button>' +
      '</div>' +
      '<label class="sliderRow"><span>볼륨</span>' +
        '<input type="range" data-sfxvol="1" min="0" max="150" step="1" value="' + v + '">' +
        '<output>' + v + '%</output>' +
      '</label>' +
      '<div class="pickRow"><button class="btn small ghost" type="button" data-sfxact="now">현재 위치로 옮기기</button></div>' +
    '</div>';
  }).join('');
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

/* 내보낼 때마다 살아 있는 오디오 목적지를 보장한다.
   (한 번 stop()된 MediaStreamTrack은 다시 쓸 수 없어 두 번째 내보내기가 무음이 되는 걸 막는다) */
function freshAudioDest() {
  const ctx = ensureAudio();
  if (!ctx) return null;
  let live = false;
  try {
    const tr = A.streamDest && A.streamDest.stream.getAudioTracks();
    live = !!(tr && tr.length && tr[0].readyState === 'live');
  } catch (e) { live = false; }
  if (live) return A.streamDest;
  try { A.master.disconnect(A.streamDest); } catch (e) {}
  try {
    A.streamDest = ctx.createMediaStreamDestination();
    A.master.connect(A.streamDest);
    return A.streamDest;
  } catch (e) { return null; }
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
  stopBgmPreview();          // 미리듣기 중인 BGM이 녹음에 섞이지 않게
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
  const audioDest = freshAudioDest();
  if (audioDest) audioDest.stream.getAudioTracks().forEach((tr) => { try { stream.addTrack(tr); } catch (e) {} });

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

  // BGM·효과음을 녹화 시작 시점에 맞춰 한 번에 예약(녹음 스트림으로도 그대로 흘러간다)
  const t0 = audioStartAt(0, 0.07);
  await new Promise((resolve) => {
    const step = () => {
      if (X.cancel) { resolve(); return; }
      const el = (performance.now() - t0) / 1000;
      const t = clamp(el, 0, total);
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
  audioStop();
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
  }  const ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
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

/* 내보내기 진입점: 어떤 예외가 나도 화면이 멈추지 않고 안내를 띄운다 */
async function runExport() {
  if (X.running) return;
  try {
    await doExport();
  } catch (e) {
    try { console.error(e); } catch (e2) {}
    X.running = false;
    X.cancel = false;
    try { if (X.rec && X.rec.state !== 'inactive') X.rec.stop(); } catch (e2) {}
    X.rec = null;
    audioStop();
    showExportModal(false);
    $('#btnExport').disabled = false;
    toast('내보내기가 막혔어요: ' + ((e && e.message) ? e.message : '알 수 없는 오류') + ' — 다시 시도하거나 해상도를 낮춰 주세요.', 6000);
  }
}

/* ---------------- 12. 탭 ---------------- */
function switchTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  $('#panes').scrollTop = 0;
}

/* ---------------- 13. 이벤트 배선 ---------------- */
function bindUI() {
  // 파일 선택: 버튼(label) 위에 투명한 <input type=file>을 직접 덮어
  // iOS Safari/PWA에서 .click()이 먹지 않는 문제를 없앨다
  $$('.addFileBtn').forEach((label) => {
    const inp = label.querySelector('input[type="file"]');
    if (!inp) return;
    inp.addEventListener('change', (e) => {
      const fl = e.target.files;
      if (inp.id === 'bgmInput') pickBgmFile(fl && fl[0]);
      else addFiles(fl);
      inp.value = '';
    });
  });

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
  $('#btnBgmClear').onclick = clearBgm;

  // 내장 무료 BGM
  const bgmBox = $('#bgmPresets');
  if (bgmBox) bgmBox.addEventListener('click', (e) => {
    const p = e.target.closest('[data-prev]');
    if (p) { toggleBgmPreview(p.dataset.prev, p); return; }
    const a = e.target.closest('[data-apply]');
    if (a) applyBgmPreset(a.dataset.apply);
  });

  // 내장 효과음
  const sfxBox = $('#sfxPresets');
  if (sfxBox) sfxBox.addEventListener('click', (e) => {
    const p = e.target.closest('[data-sfxplay]');
    if (p) { playSfxNow(p.dataset.sfxplay, 0.8); return; }
    const a = e.target.closest('[data-sfxadd]');
    if (a) addSfx(a.dataset.sfxadd);
  });
  $('#btnSfxNow').onclick = () => {
    const el = $('#sfxTime');
    if (el) el.value = (Math.round(P.time * 10) / 10).toFixed(1);
    toast('효과음 위치를 ' + fmtSec(P.time) + '로 맞쳤어요.');
  };
  const sfxList = $('#sfxList');
  sfxList.addEventListener('click', (e) => {
    const item = e.target.closest('.sfxItem');
    if (!item) return;
    const ev = S.sfx.find((x) => x.id === item.dataset.id);
    if (!ev) return;
    const btn = e.target.closest('[data-sfxact]');
    if (!btn) return;
    const act = btn.dataset.sfxact;
    if (act === 'del') { removeSfx(ev.id); return; }
    if (act === 'play') { playSfxNow(ev.key, ev.vol); return; }
    if (act === 'now') {
      ev.time = Math.round(P.time * 10) / 10;
      S.sfx.sort((a, b) => a.time - b.time);
      renderSfxList();
      renderTimeline();
      if (P.playing) audioStartAt(P.time);
    }
  });
  sfxList.addEventListener('input', (e) => {
    const item = e.target.closest('.sfxItem');
    if (!item) return;
    const ev = S.sfx.find((x) => x.id === item.dataset.id);
    if (!ev || !e.target.hasAttribute('data-sfxvol')) return;
    ev.vol = clamp(parseFloat(e.target.value) / 100, 0, 1.5);
    const out = e.target.parentElement.querySelector('output');
    if (out) out.textContent = Math.round(parseFloat(e.target.value)) + '%';
  });
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
  $('#btnExport').onclick = () => { runExport(); };
  $('#btnExportTop').onclick = () => {
    switchTab('export');
    if (!S.clips.length) {
      toast('먼저 영상을 추가해 주세요. 위의 ‘+ 영상’을 누르면 됩니다.', 3200);
      const el = $('#btnAddTop');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      return;
    }
    runExport();
  };

  $('#expRes').onchange = () => updateExpSummary(layout().total);
  $('#expFps').onchange = () => updateExpSummary(layout().total);
  $('#expCancel').onclick = () => { X.cancel = true; };
  $('#btnExportAgain').onclick = () => { runExport(); };

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
  window.__shortsEditor = {
    S, A, AG, P, layout, drawFrame, seekTo, refreshAll, drawPreview: requestDraw,
    applyBgmPreset, addSfx, playSfxNow, audioStartAt, rawFor, audioBufferFor, BGM_PRESETS, SFX_PRESETS
  };
  // 내장 사운드는 백그라운드에서 미리 합성(첫 탭 때 지연 없게)
  setTimeout(warmSounds, 900);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
