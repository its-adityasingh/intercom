# Intercom

Two-person speech → text → speech communication for noisy places, using Gnani Prisma (STT) and Timbre (TTS).

## Run
```bash
npm install
# .env already holds GNANI_API_KEY (git-ignored). Otherwise: cp .env.example .env and fill it in.
npm start            # http://localhost:3000
npm test             # 12 tests (adapter + two-user room flow, mock provider)
npm run typecheck
```
No key yet? `GNANI_MOCK=1 npm start` runs a clearly labelled MOCK provider (messages are tagged MOCK).

## Two devices
Open http://localhost:3000 → Start communicating → create room → copy invite link → open it in another browser/phone.
Phones need HTTPS for the microphone (use `ngrok http 3000` or deploy); `localhost` is exempt on desktop.

## Verified from Gnani docs (docs.gnani.ai)
- STT: `POST https://api.vachana.ai/stt/v3`, multipart `audio_file`, `language_code`, `format`; header `X-API-Key-ID`; response `{success, request_id, timestamp, transcript}`. No confidence or language metadata exists, so none is shown.
- TTS: `POST https://api.vachana.ai/api/v1/tts/inference` returns binary audio. Request fields (`text, voice, model, language, speed, audio_config`) come from the documented SSE schema. **The REST page was not read directly; confirm on first live call.**
- Models/voices: `timbre-v3.0` + voice `Shivani` (each v3.0 voice speaks all 10 languages). Change via `.env`.

## Not done / limitations
- No live Gnani call has been run by the author (build sandbox cannot reach api.vachana.ai). Check `#/diagnostics` after your first message: "verified" turns yes only after a real success.
- No pre-join microphone test screen; no noise-reduction stage; no browser end-to-end (Playwright) test; no translation.
- Rooms, messages and generated audio live in server memory only.
- Dot wordmark script spellings are unverified candidates; confirm with native speakers. The wordmark text is in `public/wordmark.js` (`WORDS`).
