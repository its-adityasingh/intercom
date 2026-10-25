import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  gnani: {
    apiKey: process.env.GNANI_API_KEY ?? "",
    baseUrl: (process.env.GNANI_BASE_URL ?? "https://api.vachana.ai").replace(/\/$/, ""),
    ttsModel: process.env.GNANI_TTS_MODEL ?? "timbre-v3.0",
    ttsVoice: process.env.GNANI_TTS_VOICE ?? "Shivani",
    timeoutMs: Number(process.env.GNANI_TIMEOUT_MS ?? 20000),
    mock: process.env.GNANI_MOCK === "1",
  },
  limits: {
    maxAudioBytes: 3 * 1024 * 1024, // 60 s of 16 kHz mono 16-bit WAV is ~1.9 MB
    maxTextChars: 600,
    requestsPerMinute: 24,
  },
};

// Languages documented for both Prisma (STT) and Timbre (TTS).
export const LANGUAGES = [
  { code: "en-IN", label: "English" },
  { code: "hi-IN", label: "Hindi" },
  { code: "bn-IN", label: "Bengali" },
  { code: "gu-IN", label: "Gujarati" },
  { code: "kn-IN", label: "Kannada" },
  { code: "ml-IN", label: "Malayalam" },
  { code: "mr-IN", label: "Marathi" },
  { code: "pa-IN", label: "Punjabi" },
  { code: "ta-IN", label: "Tamil" },
  { code: "te-IN", label: "Telugu" },
] as const;
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as string[];

// Voices documented at docs.gnani.ai. timbre-v3.0: 13 voices, each speaks all supported languages.
// timbre-v2.5 has 42 voices; only the three named in the docs' examples are listed here.
export const TTS_VOICES: string[] = config.gnani.ttsModel === "timbre-v2.5"
  ? ["Nalini", "Kaveri", "Deepak"]
  : ["Avinash", "Shivani", "Lakshmi", "Kalpana", "Shubham", "Prakash", "Devansh", "Yashraj", "Chetana", "Vasudha", "Riyaa", "Tarika", "Harshad"];
if (!TTS_VOICES.includes(config.gnani.ttsVoice)) TTS_VOICES.unshift(config.gnani.ttsVoice);
