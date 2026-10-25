// Records microphone audio and encodes 16 kHz mono 16-bit WAV (a format Gnani accepts) entirely in the browser.
export class Recorder {
  constructor() { this.chunks = []; this.rate = 0; this.level = 0; }
  async start(deviceId) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC(); this.rate = this.ac.sampleRate;
    this.src = this.ac.createMediaStreamSource(this.stream);
    this.node = this.ac.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0); this.chunks.push(new Float32Array(d));
      let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; this.level = Math.min(1, Math.sqrt(s / d.length) * 4);
    };
    this.src.connect(this.node); this.node.connect(this.ac.destination); // destination is silent: output buffer is zeroed
    this.t0 = performance.now();
  }
  get elapsed() { return performance.now() - this.t0; }
  async stop() {
    const ms = this.elapsed; this.teardown();
    const n = this.chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(n); let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    return { blob: encodeWav(downsample(all, this.rate, 16000), 16000), durationMs: Math.round(ms) };
  }
  cancel() { this.teardown(); }
  teardown() {
    try { this.node && (this.node.onaudioprocess = null); this.src?.disconnect(); this.node?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop()); this.ac?.close().catch(() => {});
  }
}
function downsample(buf, from, to) {
  if (from === to) return buf; const ratio = from / to, n = Math.floor(buf.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.floor(i * ratio), b = Math.min(buf.length, Math.floor((i + 1) * ratio)); let s = 0; for (let j = a; j < b; j++) s += buf[j]; out[i] = s / Math.max(1, b - a); }
  return out;
}
function encodeWav(f, rate) {
  const b = new ArrayBuffer(44 + f.length * 2), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + f.length * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, f.length * 2, true);
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([b], { type: "audio/wav" });
}
