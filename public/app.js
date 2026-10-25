import { MultilingualDotWordmark } from "./wordmark.js";
import { Recorder } from "./recorder.js";
import { io } from "/socket.io/socket.io.esm.min.js";

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
let cleanup = null, config = null;
const getSession = () => { try { return JSON.parse(sessionStorage.getItem("cs_session")); } catch { return null; } };
const setSession = (s) => (s ? sessionStorage.setItem("cs_session", JSON.stringify(s)) : sessionStorage.removeItem("cs_session"));
const prefs = { auto: false, vol: 1, mode: "hold", mic: "", voice: "" };
const loadConfig = async () => (config ??= await (await fetch("/api/config")).json());
const mount = (id) => { view.replaceChildren($(id).content.cloneNode(true)); document.body.classList.remove("in-room", "on-landing"); window.scrollTo(0, 0); };
const fillLangs = (sel, v = "en-IN") => { config.languages.forEach((l) => sel.append(new Option(`${l.label} (${l.code})`, l.code))); sel.value = v; };
async function api(path, opts = {}, s = getSession()) {
  const headers = { ...(opts.headers || {}) };
  if (s) { headers["x-participant-id"] = s.participantId; headers["x-token"] = s.token; }
  if (opts.json) { headers["content-type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || "Request failed"), { status: r.status, data });
  return data;
}

async function route() {
  cleanup?.(); cleanup = null;
  await loadConfig();
  const [, a, b] = location.hash.split("/");
  if (!a) return landing();
  if (a === "start") return start();
  if (a === "join") return join(b);
  if (a === "how") { mount("#t-how"); return; }
  if (a === "gallery") { mount("#t-gallery"); return; }
  if (a === "problem") { mount("#t-problem"); return; }
  if (a === "diagnostics") return diagnostics();
  if (a === "room") return room(b);
  landing();
}
addEventListener("hashchange", route); route();

function landing() {
  mount("#t-landing"); document.body.classList.add("on-landing");
  const wm = new MultilingualDotWordmark($("#wordmark"), { onChange: (w) => ($("#wordmark-text").textContent = w.label + ": " + w.text) });
  cleanup = () => wm.destroy();
}

function start() {
  mount("#t-start"); fillLangs($("#lang-create"));
  $("#create-form").onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target), btn = e.target.querySelector("button"); btn.disabled = true; $("#create-err").textContent = "";
    try {
      const r = await api("/api/rooms", { method: "POST", json: { name: f.get("name"), language: f.get("language"), spokenPlayback: f.get("spoken") === "on" } }, null);
      setSession({ code: r.code, participantId: r.participantId, token: r.token, name: f.get("name"), language: f.get("language") });
      location.hash = `#/room/${r.code}`;
    } catch (err) { $("#create-err").textContent = err.message; btn.disabled = false; }
  };
}
function join(code = "") {
  mount("#t-join"); fillLangs($("#lang-join")); const form = $("#join-form"); form.code.value = code.toUpperCase();
  form.onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(form), btn = form.querySelector("button"), c = String(f.get("code")).trim().toUpperCase(); btn.disabled = true; $("#join-err").textContent = "";
    try {
      const r = await api(`/api/rooms/${encodeURIComponent(c)}/join`, { method: "POST", json: { name: f.get("name"), language: f.get("language") } }, null);
      setSession({ code: r.code, participantId: r.participantId, token: r.token, name: f.get("name"), language: f.get("language") });
      location.hash = `#/room/${r.code}`;
    } catch (err) { $("#join-err").textContent = err.status === 404 ? "No room with that code. Check it and try again." : err.status === 409 ? "That room already has two people." : err.message; btn.disabled = false; }
  };
}
async function diagnostics() {
  mount("#t-diag");
  const [s, c] = await Promise.all([fetch("/api/status").then((r) => r.json()), fetch("/api/config").then((r) => r.json())]);
  const row = (k, v) => `${k.padEnd(26)} ${v}`;
  $("#diag").style.whiteSpace = "pre-wrap";
  $("#diag").textContent = [
    row("Mode", c.mode === "mock" ? "MOCK (not Gnani)" : "live"), row("API key configured", s.configured ? "yes" : "NO"),
    row("STT verified this run", s.stt.verified ? "yes" : "no real request has succeeded yet"), row("STT ok / failed", `${s.stt.ok} / ${s.stt.failed}`),
    row("STT last latency", s.stt.ok ? s.stt.lastMs + " ms" : "n/a"), row("STT last error", s.stt.lastError || "none"),
    row("TTS verified this run", s.tts.verified ? "yes" : "no real request has succeeded yet"), row("TTS ok / failed", `${s.tts.ok} / ${s.tts.failed}`),
    row("TTS last latency", s.tts.ok ? s.tts.lastMs + " ms" : "n/a"), row("TTS last error", s.tts.lastError || "none"),
    row("TTS model / voice", `${c.tts.model} / ${c.tts.voice}`), row("Max audio", Math.round(c.limits.maxAudioBytes / 1024) + " KB"),
    "", "Data flow: browser → this server → Gnani Prisma (STT) → transcript → other user.", "If spoken playback is on: transcript → Gnani Timbre (TTS) → audio → other user.",
  ].join("\n");
}

// ---------------- room ----------------
async function room(code) {
  const s = getSession();
  if (!s || s.code !== code) { location.hash = `#/join/${code}`; return; }
  let state;
  try { state = await api(`/api/rooms/${code}/state`); } catch { setSession(null); location.hash = `#/join/${code}`; return; }
  mount("#t-room"); document.body.classList.add("in-room");
  $("#room-code").textContent = code;
  const msgs = new Map(), blobs = new Map(), urls = new Map(), played = new Set(), pending = new Map();
  let participants = state.participants, errors = 0, recorder = null, sending = false, tick = 0;
  const convo = $("#convo"), notice = (t) => ($("#notice").textContent = t || "");

  // settings
  fillLangs($("#s-lang"), s.language);
  $("#s-lang").onchange = () => { s.language = $("#s-lang").value; setSession(s); };
  $("#s-auto").onchange = (e) => (prefs.auto = e.target.checked); $("#s-vol").oninput = (e) => (prefs.vol = +e.target.value);
  $("#s-mode").onchange = (e) => { prefs.mode = e.target.value; setRecLabel(); };
  $("#s-mic").onchange = (e) => (prefs.mic = e.target.value);
  $("#open-settings").onclick = (e) => { const h = $("#settings").hidden; $("#settings").hidden = !h; e.target.setAttribute("aria-expanded", String(h)); };
  $("#copy-link").onclick = async () => {
    const link = `${location.origin}/#/join/${code}`;
    try { await navigator.clipboard.writeText(link); notice("Invite link copied."); } catch { prompt("Copy this invite link", link); }
  };
  $("#leave").onclick = async () => { try { await api(`/api/rooms/${code}/leave`, { method: "POST" }); } catch {} setSession(null); location.hash = "#/"; };

  // realtime
  const socket = io({ auth: { code, participantId: s.participantId, token: s.token }, reconnectionDelayMax: 4000 });
  const setConn = (t) => ($("#conn").textContent = t);
  socket.on("connect", () => { setConn("Connected"); refresh(); });
  socket.on("disconnect", () => setConn("Reconnecting"));
  socket.io.on("reconnect_attempt", () => setConn("Reconnecting"));
  socket.on("connect_error", (e) => setConn(e.message === "forbidden" ? "Disconnected" : "Reconnecting"));
  socket.on("presence", (p) => { participants = p; renderPresence(); });
  socket.on("message", upsert); socket.on("message:update", upsert);
  async function refresh() { try { const st = await api(`/api/rooms/${code}/state`); participants = st.participants; st.messages.forEach(upsert); renderPresence(); } catch {} }

  function renderPresence() {
    const other = participants.find((p) => p.id !== s.participantId);
    $("#presence").textContent = other ? `${other.name} (${other.language}) is ${other.connected ? "connected" : "disconnected"}` : "Waiting for someone to join. Share the invite link.";
    notice(other && !other.connected ? `${other.name} lost connection. Messages will arrive when they return.` : "");
    renderEmpty();
  }
  function renderEmpty() {
    let e = $(".empty", convo);
    if (msgs.size) return e?.remove();
    if (!e) { e = document.createElement("li"); e.className = "empty"; convo.append(e); }
    e.textContent = "No messages yet. Hold the button below and speak, or type a message.";
  }

  function upsert(m) {
    if (m.transcriptionStatus === "failed") errors++;
    msgs.set(m.id, m); if (m.clientMsgId) pending.delete(m.clientMsgId);
    let li = $(`[data-id="${m.id}"]`, convo); if (!li) { li = document.createElement("li"); li.dataset.id = m.id; convo.append(li); $(".empty", convo)?.remove(); }
    render(li, m); convo.scrollTop = convo.scrollHeight; roomDiag();
    if (prefs.auto && m.audioId && m.senderId !== s.participantId && !played.has(m.audioId)) { played.add(m.audioId); play(m).catch(() => notice("Autoplay was blocked by the browser. Press Play.")); }
  }
  const el = (t, cls, text) => { const x = document.createElement(t); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const btn = (label, fn) => { const b = el("button", "btn", label); b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { notice(e.message); } b.disabled = false; }; return b; };

  function render(li, m) {
    const mine = m.senderId === s.participantId; li.className = "msg" + (mine ? " me" : ""); li.replaceChildren();
    const meta = el("div", "meta"); meta.append(el("span", "", mine ? "You" : m.senderName), el("time", "mono", new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), el("span", "", m.kind === "voice" ? "Voice" : "Text"));
    if (m.provider === "mock") meta.append(el("span", "tag", "MOCK"));
    li.append(meta);
    if (m.transcriptionStatus === "processing") li.append(el("p", "tr", "Transcribing…"));
    else if (m.transcriptionStatus === "failed") li.append(el("p", "tr", "Could not transcribe."), el("p", "status", m.errorMessage || "Transcription failed."));
    else li.append(el("p", "tr", m.transcript));
    const st = [];
    if (m.deliveryStatus === "delivered") st.push("Delivered");
    if (m.speechStatus === "pending") st.push("Generating audio…"); if (m.speechStatus === "ready") st.push("Audio ready"); if (m.speechStatus === "failed") st.push("Audio failed: " + (m.speechError || "unknown"));
    if (m.timings?.sttMs) st.push(`STT ${m.timings.sttMs} ms`); if (m.timings?.ttsMs) st.push(`TTS ${m.timings.ttsMs} ms`);
    if (st.length) li.append(el("p", "status mono", st.join(" · ")));
    const row = el("div", "row");
    if (m.audioId) row.append(btn("Play", () => play(m)));
    if (m.transcriptionStatus === "done" && (m.speechStatus === "off" || m.speechStatus === "failed")) row.append(btn(m.speechStatus === "failed" ? "Retry audio" : "Generate speech", () => api(`/api/rooms/${code}/messages/${m.id}/speech`, { method: "POST" })));
    if (m.transcriptionStatus === "failed" && mine && blobs.has(m.clientMsgId)) row.append(btn("Retry transcription", () => sendVoice(m.clientMsgId)));
    if (m.transcriptionStatus === "done" && !mine) {
      row.append(btn("Unclear: repeat", () => api(`/api/rooms/${code}/messages/${m.id}/response`, { method: "POST", json: { kind: "unclear" } })), btn("Confirm", () => api(`/api/rooms/${code}/messages/${m.id}/response`, { method: "POST", json: { kind: "confirmed" } })));
    }
    (m.responses || []).forEach((r) => row.append(el("span", "tag", `${r.by}: ${r.kind === "unclear" ? "Unclear, please repeat" : "Confirmed"}`)));
    if (row.children.length) li.append(row);
  }
  async function play(m) {
    let url = urls.get(m.audioId);
    if (!url) { const r = await fetch(`/api/rooms/${code}/audio/${m.audioId}`, { headers: { "x-participant-id": s.participantId, "x-token": s.token } }); if (!r.ok) throw new Error("Audio expired. Use Generate speech again."); url = URL.createObjectURL(await r.blob()); urls.set(m.audioId, url); }
    const a = new Audio(url); a.volume = prefs.vol; await a.play();
  }
  function roomDiag() {
    const last = [...msgs.values()].reverse().find((m) => m.timings?.totalMs);
    $("#room-diag").textContent = `Mode: ${config.mode} · errors this session: ${errors}` + (last ? ` · last message: STT ${last.timings.sttMs ?? "n/a"} ms, TTS ${last.timings.ttsMs ?? "n/a"} ms, to-delivered ${last.timings.totalMs} ms` : "");
  }

  // voice choice (Gnani Timbre voice used when your messages are spoken to the other person)
  config.voices.forEach((v) => $("#voice-sel").append(new Option(v, v))); prefs.voice = config.tts.voice; $("#voice-sel").value = prefs.voice;
  $("#voice-sel").onchange = (e) => (prefs.voice = e.target.value);

  // text
  $("#text-form").onsubmit = async (e) => {
    e.preventDefault(); const t = $("#text-in").value.trim(); if (!t) return; $("#text-in").value = "";
    try { await api(`/api/rooms/${code}/messages/text`, { method: "POST", json: { clientMsgId: crypto.randomUUID(), text: t, voice: prefs.voice } }); } catch (err) { notice(err.message); $("#text-in").value = t; }
  };

  // voice
  const recBtn = $("#rec"), setRecLabel = () => { $("#rec-label").textContent = recorder ? (prefs.mode === "hold" ? "Release to send" : "Tap to send") : prefs.mode === "hold" ? "Hold to talk" : "Tap to record"; };
  setRecLabel();
  async function begin() {
    if (recorder || sending) return; recorder = new Recorder();
    try { await recorder.start(prefs.mic); } catch (e) {
      recorder = null; notice(e.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in your browser's site settings, then try again." : e.name === "NotFoundError" ? "No microphone found. Connect one and try again." : "Could not start the microphone: " + e.message); return;
    }
    recBtn.classList.add("live"); recBtn.setAttribute("aria-label", "Recording. Stop and send"); $("#cancel-rec").hidden = false; setRecLabel(); notice("");
    tick = setInterval(() => { $("#timer").textContent = fmt(recorder.elapsed); meter(); if (recorder.elapsed > 55000) finish(); }, 80);
    if (!$("#s-mic").options.length) loadMics();
  }
  const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  function meter() { const c = $("#level"), g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height); g.fillStyle = "#111"; const w = (recorder?.level ?? 0) * c.width; g.fillRect(0, 10, Math.max(2, w), 8); }
  function resetRec() { clearInterval(tick); recorder = null; recBtn.classList.remove("live"); recBtn.setAttribute("aria-label", "Record a message"); $("#cancel-rec").hidden = true; $("#timer").textContent = "0:00"; meter(); setRecLabel(); }
  async function finish() {
    if (!recorder) return; const r = recorder; const { blob, durationMs } = await r.stop(); resetRec();
    if (durationMs < 400 || blob.size < 2000) return notice("That recording was too short. Hold the button while you speak.");
    const id = crypto.randomUUID(); blobs.set(id, { blob, durationMs }); sendVoice(id);
  }
  async function sendVoice(id) {
    if (pending.has(id)) return; pending.set(id, true); const { blob, durationMs } = blobs.get(id);
    const f = new FormData(); f.append("audio", blob, "recording.wav"); f.append("clientMsgId", id); f.append("durationMs", String(durationMs)); f.append("language", s.language); f.append("voice", prefs.voice);
    try { await api(`/api/rooms/${code}/messages/voice`, { method: "POST", body: f }); blobs.delete(id); }
    catch (err) { notice(err.message + (err.data?.retryable ? " You can retry." : "")); if (err.data?.message_) { upsert(err.data.message_); } }
    finally { pending.delete(id); }
  }
  recBtn.addEventListener("pointerdown", (e) => { if (prefs.mode === "hold") { e.preventDefault(); recBtn.setPointerCapture(e.pointerId); begin(); } });
  recBtn.addEventListener("pointerup", () => { if (prefs.mode === "hold" && recorder) finish(); });
  recBtn.addEventListener("pointercancel", () => { if (prefs.mode === "hold" && recorder) finish(); });
  recBtn.addEventListener("click", () => { if (prefs.mode === "tap") (recorder ? finish() : begin()); });
  recBtn.addEventListener("keydown", (e) => { if (prefs.mode === "hold" && (e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); begin(); } });
  recBtn.addEventListener("keyup", (e) => { if (prefs.mode === "hold" && (e.key === " " || e.key === "Enter")) finish(); });
  $("#cancel-rec").onclick = () => { recorder?.cancel(); resetRec(); notice("Recording discarded."); };
  async function loadMics() { try { const d = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === "audioinput"); const sel = $("#s-mic"); sel.replaceChildren(new Option("Default", "")); d.forEach((x, i) => sel.append(new Option(x.label || `Microphone ${i + 1}`, x.deviceId))); } catch {} }

  state.messages.forEach(upsert); renderPresence(); renderEmpty(); roomDiag();
  cleanup = () => { socket.close(); recorder?.cancel(); clearInterval(tick); urls.forEach((u) => URL.revokeObjectURL(u)); };
}
