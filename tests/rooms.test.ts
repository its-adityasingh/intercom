import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { io as ioc, type Socket } from "socket.io-client";
import { buildApp } from "../server/index.js";
import { createGnani, GnaniError } from "../server/gnani.js";
import { RoomStore, RoomError, RateLimiter } from "../server/rooms.js";

describe("RoomStore", () => {
  it("enforces capacity and auth", () => {
    const s = new RoomStore();
    const { room, participant } = s.create("A", "en-IN", true);
    const b = s.join(room.code, "B", "hi-IN");
    expect(() => s.join(room.code, "C", "en-IN")).toThrowError(RoomError);
    expect(() => s.auth(room.code, participant.id, "bad")).toThrow();
    expect(s.auth(room.code, b.participant.id, b.participant.token).participant.name).toBe("B");
  });
  it("is idempotent per clientMsgId unless failed", () => {
    const s = new RoomStore(); const { room, participant } = s.create("A", "en-IN", true);
    const a = s.beginMessage(room, participant, "client-id-1", "voice");
    expect(s.beginMessage(room, participant, "client-id-1", "voice").duplicate).toBe(true);
    a.message.deliveryStatus = "failed";
    const retry = s.beginMessage(room, participant, "client-id-1", "voice");
    expect(retry.duplicate).toBe(false); expect(retry.message.id).toBe(a.message.id);
  });
  it("rate limiter blocks bursts", () => {
    const l = new RateLimiter(2); expect([l.allow("a"), l.allow("a"), l.allow("a")]).toEqual([true, true, false]);
  });
});

describe("two-user flow (mock provider, test fixture only)", () => {
  let ctx: ReturnType<typeof buildApp>; let base: string; const sockets: Socket[] = [];
  let failTts = false;
  beforeAll(async () => {
    const real = createGnani({ apiKey: "x", baseUrl: "", ttsModel: "m", ttsVoice: "v", timeoutMs: 100, mock: true });
    const gnani = { ...real, synthesizeSpeech: async (...a: Parameters<typeof real.synthesizeSpeech>) => { if (failTts) throw new GnaniError("provider_unavailable", "down"); return real.synthesizeSpeech(...a); } };
    ctx = buildApp(gnani as any);
    await new Promise<void>((r) => ctx.server.listen(0, r));
    base = `http://localhost:${(ctx.server.address() as any).port}`;
  });
  afterAll(() => { sockets.forEach((s) => s.close()); ctx.close(); });
  const post = (p: string, body: any, h: any = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const hdr = (s: any) => ({ "x-participant-id": s.participantId, "x-token": s.token });
  const connect = (code: string, s: any) => new Promise<Socket>((res) => { const so = ioc(base, { auth: { code, participantId: s.participantId, token: s.token } }); sockets.push(so); so.on("connect", () => res(so)); });
  const voice = (code: string, s: any, id: string) => { const f = new FormData(); f.append("audio", new Blob([new Uint8Array(4000)], { type: "audio/wav" }), "a.wav"); f.append("clientMsgId", id); f.append("durationMs", "1500"); return fetch(`${base}/api/rooms/${code}/messages/voice`, { method: "POST", headers: hdr(s), body: f }).then(async (r) => ({ status: r.status, body: await r.json() })); };

  it("create, join, full room, message delivery, duplicate prevention, TTS retry, disconnect", async () => {
    const a = (await post("/api/rooms", { name: "Asha", language: "en-IN", spokenPlayback: true })).body;
    const b = (await post(`/api/rooms/${a.code}/join`, { name: "Ravi", language: "hi-IN" })).body;
    expect((await post(`/api/rooms/${a.code}/join`, { name: "Z", language: "en-IN" })).status).toBe(409);
    expect((await post(`/api/rooms/NOPE12/join`, { name: "Z", language: "en-IN" })).status).toBe(404);

    const sa = await connect(a.code, a); const sb = await connect(a.code, b);
    const got: any[] = []; const updates: any[] = [];
    sb.on("message", (m) => got.push(m)); sb.on("message:update", (m) => updates.push(structuredClone(m)));

    const r1 = await voice(a.code, a, "client-msg-1");
    expect(r1.status).toBe(200); expect(r1.body.message.transcriptionStatus).toBe("done");
    expect((await voice(a.code, a, "client-msg-1")).body.duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toHaveLength(1); expect(got[0].senderName).toBe("Asha");
    expect(updates.some((u) => u.speechStatus === "ready" && u.audioId)).toBe(true);

    const audio = updates.find((u) => u.audioId).audioId;
    expect((await fetch(`${base}/api/rooms/${a.code}/audio/${audio}`, { headers: hdr(b) })).status).toBe(200);
    expect((await fetch(`${base}/api/rooms/${a.code}/audio/${audio}`, { headers: { "x-participant-id": "x", "x-token": "y" } })).status).toBe(403);

    failTts = true;
    const t = await post(`/api/rooms/${a.code}/messages/text`, { clientMsgId: "client-msg-2", text: "Valve 14 closed" }, hdr(b));
    await new Promise((r) => setTimeout(r, 100));
    const state = await (await fetch(`${base}/api/rooms/${a.code}/state`, { headers: hdr(a) })).json();
    const m2 = state.messages.find((m: any) => m.id === t.body.message.id);
    expect(m2.transcript).toBe("Valve 14 closed"); expect(m2.speechStatus).toBe("failed"); // transcript survives TTS failure
    failTts = false;
    const retry = await post(`/api/rooms/${a.code}/messages/${m2.id}/speech`, {}, hdr(a));
    expect(retry.body.message.speechStatus).toBe("ready");

    const presenceSeen: any[] = []; sa.on("presence", (p) => presenceSeen.push(p));
    sb.close(); await new Promise((r) => setTimeout(r, 150));
    expect(presenceSeen.at(-1).find((p: any) => p.name === "Ravi").connected).toBe(false);
  });
});
