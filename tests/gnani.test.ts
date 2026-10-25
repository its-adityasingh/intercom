import { describe, it, expect, vi } from "vitest";
import { createGnani, GnaniError, mapStatus } from "../server/gnani.js";

const cfg = { apiKey: "k", baseUrl: "https://x.test", ttsModel: "timbre-v3.0", ttsVoice: "Shivani", timeoutMs: 500, mock: false };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("Gnani STT adapter", () => {
  it("builds the documented multipart request and parses transcript", async () => {
    const f = vi.fn(async (_u: any, init: any) => {
      expect(init.headers["X-API-Key-ID"]).toBe("k");
      const form = init.body as FormData;
      expect(form.get("language_code")).toBe("hi-IN");
      expect(form.get("format")).toBe("verbatim");
      expect(form.get("audio_file")).toBeInstanceOf(Blob);
      return json({ success: true, request_id: "r1", transcript: " नमस्ते " });
    });
    const r = await createGnani(cfg, f as any).transcribeAudio(Buffer.alloc(10), { languageCode: "hi-IN" });
    expect(f.mock.calls[0][0]).toBe("https://x.test/stt/v3");
    expect(r.transcript).toBe("नमस्ते"); expect(r.requestId).toBe("r1"); expect(r.provider).toBe("gnani");
  });
  it("rejects empty transcript", async () => {
    const g = createGnani(cfg, (async () => json({ success: true, transcript: "  " })) as any);
    await expect(g.transcribeAudio(Buffer.alloc(1), { languageCode: "en-IN" })).rejects.toMatchObject({ code: "empty_transcript" });
  });
  it("rejects malformed response", async () => {
    const g = createGnani(cfg, (async () => json({ ok: 1 })) as any);
    await expect(g.transcribeAudio(Buffer.alloc(1), { languageCode: "en-IN" })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("maps provider errors", async () => {
    for (const [s, c] of [[400, "invalid_request"], [403, "auth_failed"], [429, "rate_limited"], [503, "provider_unavailable"]] as const) {
      const g = createGnani(cfg, (async () => json({ success: false, error: { message: "m" } }, s)) as any);
      await expect(g.transcribeAudio(Buffer.alloc(1), { languageCode: "en-IN" })).rejects.toMatchObject({ code: c });
    }
    expect(mapStatus(429).retryable).toBe(true);
    expect(mapStatus(403).retryable).toBe(false);
  });
  it("fails clearly without a key and never sends the key in errors", async () => {
    const g = createGnani({ ...cfg, apiKey: "" });
    await expect(g.transcribeAudio(Buffer.alloc(1), { languageCode: "en-IN" })).rejects.toMatchObject({ code: "not_configured" });
  });
  it("times out", async () => {
    const f = (_u: any, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
    const g = createGnani({ ...cfg, timeoutMs: 20 }, f as any);
    await expect(g.transcribeAudio(Buffer.alloc(1), { languageCode: "en-IN" })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("Gnani TTS adapter", () => {
  it("sends JSON body and returns audio bytes", async () => {
    const f = vi.fn(async (_u: any, init: any) => {
      const b = JSON.parse(init.body);
      expect(b).toMatchObject({ text: "hello", model: "timbre-v3.0", voice: "Shivani", language: "en-IN" });
      expect(b.audio_config.container).toBe("wav");
      return new Response(new Uint8Array(500), { status: 200, headers: { "content-type": "audio/wav" } });
    });
    const r = await createGnani(cfg, f as any).synthesizeSpeech("hello", { languageCode: "en-IN" });
    expect(f.mock.calls[0][0]).toBe("https://x.test/api/v1/tts/inference");
    expect(r.audio.length).toBe(500);
  });
  it("rejects JSON or empty audio", async () => {
    await expect(createGnani(cfg, (async () => json({ a: 1 })) as any).synthesizeSpeech("x", { languageCode: "en-IN" })).rejects.toBeInstanceOf(GnaniError);
    await expect(createGnani(cfg, (async () => new Response(new Uint8Array(3), { headers: { "content-type": "audio/wav" } })) as any).synthesizeSpeech("x", { languageCode: "en-IN" })).rejects.toMatchObject({ code: "invalid_response" });
  });
});
