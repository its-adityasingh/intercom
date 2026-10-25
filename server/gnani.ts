/**
 * Gnani Vachana adapter. Endpoints/fields verified against docs.gnani.ai:
 *  - STT (Prisma):  POST {base}/stt/v3, multipart: audio_file, language_code, format. Header X-API-Key-ID.
 *                   Response: { success, request_id, timestamp, transcript } (no confidence / language metadata).
 *  - TTS (Timbre):  POST {base}/api/v1/tts/inference, JSON body, binary audio response.
 *                   Body fields (text, voice, model, language, speed, audio_config) are taken from the documented
 *                   SSE schema; the REST page itself was not fetched, so the first live call must confirm them.
 */
export type ErrorCode =
  | "not_configured" | "auth_failed" | "rate_limited" | "invalid_request"
  | "timeout" | "provider_unavailable" | "invalid_response" | "empty_transcript" | "network";

export class GnaniError extends Error {
  constructor(public code: ErrorCode, message: string, public status?: number) { super(message); }
  get retryable() { return ["rate_limited", "timeout", "provider_unavailable", "network"].includes(this.code); }
}

export interface GnaniConfig {
  apiKey: string; baseUrl: string; ttsModel: string; ttsVoice: string; timeoutMs: number; mock: boolean;
}
export interface SttResult { transcript: string; requestId?: string; latencyMs: number; provider: "gnani" | "mock"; }
export interface TtsResult { audio: Buffer; contentType: string; latencyMs: number; provider: "gnani" | "mock"; }

export function mapStatus(status: number, providerMessage?: string): GnaniError {
  const m = providerMessage ? `: ${providerMessage}` : "";
  if (status === 400) return new GnaniError("invalid_request", `Gnani rejected the request${m}`, status);
  if (status === 401 || status === 403) return new GnaniError("auth_failed", `Gnani refused the API key (check key, account status, credits)${m}`, status);
  if (status === 429) return new GnaniError("rate_limited", "Gnani rate limit reached. Wait a moment and retry.", status);
  if (status >= 500) return new GnaniError("provider_unavailable", "Gnani service is temporarily unavailable.", status);
  return new GnaniError("invalid_response", `Unexpected Gnani status ${status}${m}`, status);
}

async function errorMessage(res: Response): Promise<string | undefined> {
  try { const j: any = await res.json(); return j?.error?.message; } catch { return undefined; }
}

export function createGnani(cfg: GnaniConfig, fetchImpl: typeof fetch = fetch) {
  const headers = () => ({ "X-API-Key-ID": cfg.apiKey });

  function ensure() {
    if (!cfg.apiKey) throw new GnaniError("not_configured", "GNANI_API_KEY is not set on the server.");
  }

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new GnaniError("timeout", "Gnani did not respond in time.");
      throw new GnaniError("network", "Could not reach Gnani.");
    }
  }

  async function transcribeAudio(audio: Buffer, o: { languageCode: string; mime?: string; filename?: string }): Promise<SttResult> {
    if (cfg.mock) return { transcript: "[MOCK] test transcript", latencyMs: 5, provider: "mock" };
    ensure();
    const form = new FormData();
    form.append("audio_file", new Blob([new Uint8Array(audio)], { type: o.mime ?? "audio/wav" }), o.filename ?? "recording.wav");
    form.append("language_code", o.languageCode);
    form.append("format", "verbatim"); // keep the exact spoken form; no silent rewriting of numbers
    const t0 = Date.now();
    const res = await call(`${cfg.baseUrl}/stt/v3`, { method: "POST", headers: headers(), body: form });
    if (!res.ok) throw mapStatus(res.status, await errorMessage(res));
    let j: any;
    try { j = await res.json(); } catch { throw new GnaniError("invalid_response", "Gnani returned a non-JSON response."); }
    if (j?.success !== true || typeof j.transcript !== "string") throw new GnaniError("invalid_response", "Gnani response had no transcript.");
    const transcript = j.transcript.trim();
    if (!transcript) throw new GnaniError("empty_transcript", "No speech was recognised. Record again, closer to the microphone.");
    return { transcript, requestId: j.request_id, latencyMs: Date.now() - t0, provider: "gnani" };
  }

  async function synthesizeSpeech(text: string, o: { languageCode: string; voice?: string; model?: string; speed?: number }): Promise<TtsResult> {
    if (cfg.mock) return { audio: makeMockWav(), contentType: "audio/wav", latencyMs: 5, provider: "mock" };
    ensure();
    const body = {
      text, voice: o.voice ?? cfg.ttsVoice, model: o.model ?? cfg.ttsModel,
      language: o.languageCode, speed: o.speed ?? 1.0,
      audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: "linear_pcm", container: "wav" },
    };
    const t0 = Date.now();
    const res = await call(`${cfg.baseUrl}/api/v1/tts/inference`, {
      method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw mapStatus(res.status, await errorMessage(res));
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("json")) throw new GnaniError("invalid_response", "Gnani returned JSON instead of audio.");
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 100) throw new GnaniError("invalid_response", "Gnani returned empty audio.");
    return { audio, contentType: contentType || "audio/wav", latencyMs: Date.now() - t0, provider: "gnani" };
  }

  return { transcribeAudio, synthesizeSpeech, isConfigured: () => cfg.mock || !!cfg.apiKey };
}

/** 0.4 s 440 Hz tone, WAV. Mock mode only. */
function makeMockWav(): Buffer {
  const sr = 16000, n = Math.floor(sr * 0.4), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 6000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
export type Gnani = ReturnType<typeof createGnani>;
