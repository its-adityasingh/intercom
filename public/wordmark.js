// MultilingualDotWordmark: canvas dot-matrix wordmark that dissolves and re-forms across scripts.
// Text is rendered by the browser's shaping engine (so Indic conjuncts are correct), downsampled to a
// coverage grid, and each lit cell becomes one circular dot. Particle i is paired with target i after
// sorting both layouts by x, so assignment is deterministic.
export const WORDS = [
  { text: "INTERCOM", label: "Intercom in English", font: "Inter", weight: 800 },
  { text: "इंटरकॉम", label: "Intercom in Hindi", font: "Noto Sans Devanagari" },
  { text: "ఇంటర్‌కామ్", label: "Intercom in Telugu", font: "Noto Sans Telugu" },
  { text: "இன்டர்காம்", label: "Intercom in Tamil", font: "Noto Sans Tamil" },
  { text: "ಇಂಟರ್‌ಕಾಮ್", label: "Intercom in Kannada", font: "Noto Sans Kannada" },
  { text: "ഇന്റർകോം", label: "Intercom in Malayalam", font: "Noto Sans Malayalam" },
  { text: "ইন্টারকম", label: "Intercom in Bengali", font: "Noto Sans Bengali" },
  { text: "ઇન્ટરકોમ", label: "Intercom in Gujarati", font: "Noto Sans Gujarati" },
  { text: "ਇੰਟਰਕਾਮ", label: "Intercom in Punjabi", font: "Noto Sans Gurmukhi" },
  { text: "ଇଣ୍ଟରକମ୍", label: "Intercom in Odia", font: "Noto Sans Oriya" },
];
const HOLD_FIRST = 1800, HOLD = 1500, DISPERSE = 650, REASSEMBLE = 900, STAGGER = 280, COLS = 100;
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t));
const hash = (i, k) => { let x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

export class MultilingualDotWordmark {
  constructor(canvas, { words = WORDS, onChange } = {}) {
    this.c = canvas; this.ctx = canvas.getContext("2d"); this.words = words; this.onChange = onChange;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.cur = 0; this.phase = "hold"; this.dead = false; this.timer = 0; this.raf = 0;
    this.onVis = () => (document.hidden ? this.pause() : this.resume());
    document.addEventListener("visibilitychange", this.onVis);
    this.ro = new ResizeObserver(() => this.layout()); this.ro.observe(canvas);
    this.init();
  }
  async init() {
    try { await Promise.all(this.words.map((w) => document.fonts.load(`${w.weight ?? 700} 80px "${w.font}"`, w.text))); } catch {}
    if (this.dead) return;
    this.layout(); this.start();
  }
  layout() {
    const r = this.c.getBoundingClientRect(); if (!r.width || !r.height || this.dead) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = r.width; this.H = r.height; this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pitch = this.W / COLS; this.rows = Math.max(8, Math.floor(this.H / this.pitch)); this.radius = this.pitch * 0.38;
    this.targets = this.words.map((w) => this.sample(w));
    this.N = Math.max(...this.targets.map((t) => t.length));
    this.pos = this.arrange(this.cur); this.draw(this.pos); this.announce();
  }
  sample(w) {
    const S = 4, cw = COLS * S, ch = this.rows * S, o = document.createElement("canvas"); o.width = cw; o.height = ch;
    const g = o.getContext("2d"); g.textBaseline = "alphabetic"; g.fillStyle = "#000";
    let size = 100; g.font = `${w.weight ?? 700} ${size}px "${w.font}", sans-serif`;
    const m = g.measureText(w.text); const bw = m.width, asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
    size *= Math.min((cw * 0.9) / bw, (ch * 0.78) / (asc + desc));
    g.font = `${w.weight ?? 700} ${size}px "${w.font}", sans-serif`;
    const m2 = g.measureText(w.text);
    g.fillText(w.text, (cw - m2.width) / 2, (ch + m2.actualBoundingBoxAscent - m2.actualBoundingBoxDescent) / 2);
    const s = document.createElement("canvas"); s.width = COLS; s.height = this.rows; const sg = s.getContext("2d");
    sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = "high"; sg.drawImage(o, 0, 0, COLS, this.rows);
    const d = sg.getImageData(0, 0, COLS, this.rows).data, pts = [];
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < COLS; x++) if (d[(y * COLS + x) * 4 + 3] > 120) pts.push([(x + 0.5) * this.pitch, (y + 0.5) * this.pitch]);
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return pts;
  }
  // N particles for word k: first n_k visible at their target, the rest hidden at a deterministic spot
  arrange(k) {
    const t = this.targets[k], out = new Float32Array(this.N * 3);
    for (let i = 0; i < this.N; i++) {
      const p = t[i] ?? t[(i * 7) % t.length] ?? [this.W / 2, this.H / 2];
      out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = i < t.length ? 1 : 0;
    }
    return out;
  }
  draw(a, alphaOverride) {
    const ctx = this.ctx; ctx.clearRect(0, 0, this.W, this.H); ctx.fillStyle = "#111";
    for (let i = 0; i < this.N; i++) {
      const al = a[i * 3 + 2]; if (al < 0.02) continue;
      ctx.globalAlpha = al; ctx.beginPath(); ctx.arc(a[i * 3], a[i * 3 + 1], this.radius, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  announce() { const w = this.words[this.cur]; this.onChange?.(w, this.cur); }
  start() { this.schedule(HOLD_FIRST); }
  schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.next(), ms); this.holdLeft = ms; this.holdStart = performance.now(); }
  next() {
    if (this.dead) return;
    const to = (this.cur + 1) % this.words.length;
    if (this.reduced) { this.cur = to; this.pos = this.arrange(to); this.draw(this.pos); this.announce(); return this.schedule(2600); }
    const from = this.pos, dest = this.arrange(to), N = this.N, cloud = new Float32Array(N * 2), ctl1 = new Float32Array(N * 2), ctl2 = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const sx = from[i * 3], sy = from[i * 3 + 1], tx = dest[i * 3], ty = dest[i * 3 + 1];
      const cx = sx + (hash(i, 1) - 0.5) * this.W * 0.22, cy = sy + (hash(i, 2) - 0.5) * this.H * 0.7;
      cloud[i * 2] = cx; cloud[i * 2 + 1] = cy;
      const kind = i % 3; // 0 horizontal, 1 vertical, 2 curved
      ctl1[i * 2] = kind === 0 ? cx : kind === 1 ? sx : (sx + cx) / 2 + (cy - sy) * 0.3; ctl1[i * 2 + 1] = kind === 0 ? sy : kind === 1 ? cy : (sy + cy) / 2 - (cx - sx) * 0.3;
      ctl2[i * 2] = kind === 0 ? tx : kind === 1 ? cx : (cx + tx) / 2 + (ty - cy) * 0.3; ctl2[i * 2 + 1] = kind === 0 ? cy : kind === 1 ? ty : (cy + ty) / 2 - (tx - cx) * 0.3;
    }
    const total = DISPERSE + REASSEMBLE + STAGGER, t0 = performance.now(), out = new Float32Array(N * 3);
    this.phase = "move"; this.cur = to; this.announce();
    const bez = (a, c, b, t) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
    const step = (now) => {
      if (this.dead) return;
      const el = now - t0;
      for (let i = 0; i < N; i++) {
        const delay = (i / N) * STAGGER, sx = from[i * 3], sy = from[i * 3 + 1], tx = dest[i * 3], ty = dest[i * 3 + 1];
        const e = el - delay; let x, y;
        if (e < DISPERSE) { const u = ease(e / DISPERSE); x = bez(sx, ctl1[i * 2], cloud[i * 2], u); y = bez(sy, ctl1[i * 2 + 1], cloud[i * 2 + 1], u); }
        else { const u = ease((e - DISPERSE) / REASSEMBLE); x = bez(cloud[i * 2], ctl2[i * 2], tx, u); y = bez(cloud[i * 2 + 1], ctl2[i * 2 + 1], ty, u); }
        const a0 = from[i * 3 + 2], a1 = dest[i * 3 + 2], ua = ease((e - DISPERSE * 0.5) / (REASSEMBLE * 0.8));
        out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = a0 + (a1 - a0) * ua;
      }
      this.draw(out);
      if (el < total) this.raf = requestAnimationFrame(step);
      else { this.pos = dest; this.draw(dest); this.phase = "hold"; this.schedule(HOLD); }
    };
    this.raf = requestAnimationFrame(step);
  }
  pause() { clearTimeout(this.timer); cancelAnimationFrame(this.raf); this.paused = true; }
  resume() { if (!this.paused || this.dead) return; this.paused = false; if (this.phase === "move") { this.phase = "hold"; this.pos = this.arrange(this.cur); this.draw(this.pos); } this.schedule(HOLD); }
  destroy() { this.dead = true; this.pause(); this.ro.disconnect(); document.removeEventListener("visibilitychange", this.onVis); }
}
