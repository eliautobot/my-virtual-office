// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// A fake voice service for tests/e2e/pl_voice.mjs on 127.0.0.1:<port>. OpenAI-compatible under /v1 (speech: a WAV tone,
// transcriptions: fixed words, voices: three), the office's Whisper server under /whisper/transcribe. GET /_seen lists
// what it was asked (url, voice, input, bytes); POST /_reset clears it. No real keys anywhere.
import http from 'node:http';
const port = Number(process.argv[2] || 19716);
const WORDS = process.env.FAKE_WORDS || 'what is two plus two';
let seen = [];
function wav(secs, hz = 440) {
  const rate = 16000, n = Math.round(rate * secs), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 8000), 44 + i * 2);
  return b;
}
const json = (res, o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let j = null; try { j = JSON.parse(raw.toString()); } catch { /* audio */ }
    if (req.url === '/_seen') return json(res, seen);
    if (req.url === '/_reset') { seen = []; return json(res, { ok: true }); }
    seen.push({ url: req.url, voice: j?.voice ?? null, input: j?.input ?? null, model: j?.model ?? null, bytes: raw.length, auth: !!req.headers.authorization, at: Date.now() });
    if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wav(Math.min(2.5, 0.5 + String(j?.input || '').length / 40))); }
    if (req.url === '/v1/audio/voices') return json(res, { voices: ['af_bella', 'am_adam', 'bf_emma'] });
    if (req.url === '/v1/models') return json(res, { data: [{ id: 'kokoro' }, { id: 'tts-1-hd' }, { id: 'whisper-1' }, { id: 'chat-model' }] });
    if (req.url === '/v1/audio/transcriptions') return json(res, { text: WORDS });
    if (req.url === '/whisper/transcribe') return json(res, { text: `whisper: ${WORDS}` });
    json(res, { error: 'not here' }, 404);
  });
}).listen(port, '127.0.0.1', () => console.log(`fake-voice on ${port}`));
