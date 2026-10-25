import express, { type Request, type Response } from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import multer from "multer";
import { Server as IOServer } from "socket.io";
import { z } from "zod";
import { config, LANGUAGES, LANGUAGE_CODES, TTS_VOICES } from "./config.js";
import { createGnani, GnaniError } from "./gnani.js";
import { RoomStore, RoomError, RateLimiter, type Message, type Room, type Participant } from "./rooms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function buildApp(gnani = createGnani(config.gnani)) {
  const app = express();
  const server = http.createServer(app);
  const io = new IOServer(server, { maxHttpBufferSize: 1e5 });
  const store = new RoomStore();
  const limiter = new RateLimiter(config.limits.requestsPerMinute);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.limits.maxAudioBytes, files: 1 } });
  const audio = new Map<string, { buf: Buffer; type: string; roomId: string; exp: number }>();
  const stats = {
    stt: { ok: 0, failed: 0, lastMs: 0, lastError: "" }, tts: { ok: 0, failed: 0, lastMs: 0, lastError: "" },
    lastRealSuccess: { stt: 0, tts: 0 },
  };

  app.use(express.json({ limit: "20kb" }));
  app.use(express.static(path.join(__dirname, "../public")));

  const sweeper = setInterval(() => {
    store.sweep();
    for (const [k, v] of audio) if (v.exp < Date.now()) audio.delete(k);
  }, 60_000);
  sweeper.unref();

  const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e) { sendError(res, e); }
  };
  function sendError(res: Response, e: unknown) {
    if (e instanceof z.ZodError) return void res.status(400).json({ error: "invalid", message: e.issues.map((i) => i.message).join("; ") });
    if (e instanceof RoomError) return void res.status(e.code === "not_found" ? 404 : e.code === "full" ? 409 : e.code === "forbidden" ? 403 : 400).json({ error: e.code, message: e.message });
    if (e instanceof GnaniError) return void res.status(502).json({ error: e.code, message: e.message, retryable: e.retryable });
    console.error("unhandled error:", (e as Error)?.message);
    res.status(500).json({ error: "internal", message: "Something went wrong on the server." });
  }
  const authReq = (req: Request) => {
    const code = String(req.params.code ?? "");
    const r = store.auth(code, String(req.header("x-participant-id") ?? ""), String(req.header("x-token") ?? ""));
    return r;
  };
  const nameS = z.string().trim().min(1, "Enter a display name").max(30);
  const voiceS = z.string().refine((v) => TTS_VOICES.includes(v), "Unknown voice").optional();
  const langS = z.string().refine((v) => LANGUAGE_CODES.includes(v), "Unsupported language");

  const presence = (room: Room) => io.to(room.code).emit("presence", store.publicParticipants(room));
  const pushMsg = (room: Room, m: Message) => io.to(room.code).emit("message:update", m);

  // ---- configuration & status (real config only; no fabricated health) ----
  app.get("/api/config", (_req, res) => res.json({
    languages: LANGUAGES, mode: config.gnani.mock ? "mock" : "live",
    limits: { maxAudioBytes: config.limits.maxAudioBytes, maxTextChars: config.limits.maxTextChars },
    tts: { model: config.gnani.ttsModel, voice: config.gnani.ttsVoice }, voices: TTS_VOICES,
  }));
  app.get("/api/status", (_req, res) => res.json({
    configured: gnani.isConfigured(), mode: config.gnani.mock ? "mock" : "live",
    note: "Configured means a key is present. Verified means a real request has succeeded since the server started.",
    stt: { ...stats.stt, verified: stats.lastRealSuccess.stt > 0 }, tts: { ...stats.tts, verified: stats.lastRealSuccess.tts > 0 },
  }));

  // ---- rooms ----
  app.post("/api/rooms", wrap((req, res) => {
    const b = z.object({ name: nameS, language: langS, spokenPlayback: z.boolean().default(true) }).parse(req.body);
    const { room, participant } = store.create(b.name, b.language, b.spokenPlayback);
    res.json({ code: room.code, participantId: participant.id, token: participant.token, spokenPlayback: room.spokenPlayback });
  }));
  app.post("/api/rooms/:code/join", wrap((req, res) => {
    const b = z.object({ name: nameS, language: langS }).parse(req.body);
    const { room, participant } = store.join(String(req.params.code), b.name, b.language);
    res.json({ code: room.code, participantId: participant.id, token: participant.token, spokenPlayback: room.spokenPlayback });
  }));
  app.get("/api/rooms/:code/state", wrap((req, res) => {
    const { room } = authReq(req);
    res.json({ code: room.code, spokenPlayback: room.spokenPlayback, participants: store.publicParticipants(room), messages: room.messages });
  }));
  app.post("/api/rooms/:code/leave", wrap((req, res) => {
    const { room, participant } = authReq(req);
    for (const sid of participant.sockets) io.sockets.sockets.get(sid)?.disconnect(true);
    store.leave(room, participant.id);
    if (store.rooms.has(room.code)) presence(room);
    res.json({ ok: true });
  }));

  // ---- messaging ----
  async function speak(room: Room, m: Message) {
    if (m.speechStatus === "pending" || m.speechStatus === "ready") return; // never pay twice for one message
    m.speechStatus = "pending"; m.speechError = undefined; pushMsg(room, m);
    try {
      const r = await gnani.synthesizeSpeech(m.transcript, { languageCode: m.language, voice: m.voice });
      const id = randomBytes(10).toString("hex");
      audio.set(id, { buf: r.audio, type: r.contentType, roomId: room.code, exp: Date.now() + 30 * 60_000 });
      m.audioId = id; m.speechStatus = "ready"; m.timings.ttsMs = r.latencyMs;
      stats.tts.ok++; stats.tts.lastMs = r.latencyMs; if (r.provider === "gnani") stats.lastRealSuccess.tts = Date.now();
    } catch (e) {
      m.speechStatus = "failed"; m.speechError = e instanceof GnaniError ? e.message : "Speech generation failed.";
      stats.tts.failed++; stats.tts.lastError = e instanceof GnaniError ? e.code : "unknown";
    }
    m.timings.totalMs = Date.now() - m.createdAt;
    pushMsg(room, m);
  }

  app.post("/api/rooms/:code/messages/voice", upload.single("audio"), wrap(async (req, res) => {
    const { room, participant } = authReq(req);
    if (!limiter.allow(participant.id)) throw Object.assign(new GnaniError("rate_limited", "Too many messages. Wait a few seconds."), {});
    const b = z.object({ clientMsgId: z.string().min(8).max(64), durationMs: z.coerce.number().int().min(0).max(120000).default(0), language: langS.optional(), voice: voiceS }).parse(req.body);
    const file = req.file;
    if (!file || file.size < 2000) throw new z.ZodError([{ code: "custom", path: [], message: "Recording is empty or too short. Hold the button and speak." }]);
    if (b.durationMs > 60000) throw new z.ZodError([{ code: "custom", path: [], message: "Recording is longer than 60 seconds." }]);
    if (b.language) participant.language = b.language;
    const { message: m, duplicate } = store.beginMessage(room, participant, b.clientMsgId, "voice");
    if (duplicate) return void res.json({ message: m, duplicate: true });
    m.transcriptionStatus = "processing"; m.deliveryStatus = "processing"; m.errorCode = m.errorMessage = undefined;
    m.durationMs = b.durationMs; m.language = participant.language; m.voice = b.voice;
    io.to(room.code).emit("message", m);
    try {
      const r = await gnani.transcribeAudio(file.buffer, { languageCode: participant.language, mime: file.mimetype, filename: "recording.wav" });
      m.transcript = r.transcript; m.transcriptionStatus = "done"; m.deliveryStatus = "delivered";
      m.timings.sttMs = r.latencyMs; m.provider = r.provider;
      stats.stt.ok++; stats.stt.lastMs = r.latencyMs; if (r.provider === "gnani") stats.lastRealSuccess.stt = Date.now();
      m.timings.totalMs = Date.now() - m.createdAt;
      pushMsg(room, m);
      res.json({ message: m });
      if (room.spokenPlayback) void speak(room, m);
    } catch (e) {
      const g = e instanceof GnaniError ? e : new GnaniError("provider_unavailable", "Transcription failed.");
      m.transcriptionStatus = "failed"; m.deliveryStatus = "failed"; m.errorCode = g.code; m.errorMessage = g.message;
      stats.stt.failed++; stats.stt.lastError = g.code;
      pushMsg(room, m);
      res.status(502).json({ error: g.code, message: g.message, retryable: g.retryable, message_: m });
    }
  }));

  app.post("/api/rooms/:code/messages/text", wrap(async (req, res) => {
    const { room, participant } = authReq(req);
    if (!limiter.allow(participant.id)) throw new GnaniError("rate_limited", "Too many messages. Wait a few seconds.");
    const b = z.object({ clientMsgId: z.string().min(8).max(64), text: z.string().trim().min(1).max(config.limits.maxTextChars), voice: voiceS }).parse(req.body);
    const { message: m, duplicate } = store.beginMessage(room, participant, b.clientMsgId, "text");
    if (duplicate) return void res.json({ message: m, duplicate: true });
    m.voice = b.voice; m.transcript = b.text; m.transcriptionStatus = "done"; m.deliveryStatus = "delivered";
    io.to(room.code).emit("message", m);
    res.json({ message: m });
    if (room.spokenPlayback) void speak(room, m);
  }));

  app.post("/api/rooms/:code/messages/:id/speech", wrap(async (req, res) => {
    const { room, participant } = authReq(req);
    if (!limiter.allow(participant.id)) throw new GnaniError("rate_limited", "Too many requests. Wait a few seconds.");
    const m = room.messages.find((x) => x.id === req.params.id);
    if (!m || m.transcriptionStatus !== "done") throw new RoomError("not_found", "Message not found.");
    if (m.speechStatus === "failed" || m.speechStatus === "off") m.speechStatus = "off";
    await speak(room, m);
    res.json({ message: m });
  }));

  app.post("/api/rooms/:code/messages/:id/response", wrap((req, res) => {
    const { room, participant } = authReq(req);
    const b = z.object({ kind: z.enum(["unclear", "confirmed"]) }).parse(req.body);
    const m = room.messages.find((x) => x.id === req.params.id);
    if (!m) throw new RoomError("not_found", "Message not found.");
    m.responses.push({ by: participant.name, kind: b.kind, at: Date.now() });
    pushMsg(room, m);
    res.json({ message: m });
  }));

  app.get("/api/rooms/:code/audio/:audioId", wrap((req, res) => {
    const { room } = authReq(req);
    const a = audio.get(String(req.params.audioId));
    if (!a || a.roomId !== room.code) throw new RoomError("not_found", "Audio expired. Generate it again.");
    res.type(a.type).send(a.buf);
  }));

  // ---- sockets: presence + auth ----
  io.use((socket, next) => {
    try {
      const { code, participantId, token } = socket.handshake.auth ?? {};
      const { room, participant } = store.auth(String(code), String(participantId), String(token));
      socket.data = { code: room.code, pid: participant.id };
      next();
    } catch { next(new Error("forbidden")); }
  });
  io.on("connection", (socket) => {
    const room = store.rooms.get(socket.data.code); const p = room?.participants.get(socket.data.pid);
    if (!room || !p) return socket.disconnect(true);
    socket.join(room.code); p.sockets.add(socket.id); p.connected = true; presence(room);
    socket.on("disconnect", () => {
      p.sockets.delete(socket.id); p.connected = p.sockets.size > 0;
      if (store.rooms.has(room.code)) presence(room);
    });
  });

  return { app, server, io, store, close: () => { clearInterval(sweeper); io.close(); server.close(); } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server } = buildApp();
  server.listen(config.port, () => {
    console.log(`Intercom on http://localhost:${config.port} (${config.gnani.mock ? "MOCK provider" : config.gnani.apiKey ? "Gnani key configured" : "NO Gnani key"})`);
  });
}
