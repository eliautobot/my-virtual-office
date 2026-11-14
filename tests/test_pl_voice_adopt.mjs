// v0.12: the office's Whisper server is adopted as the voice listening service only when the office used it
// (features.whisper on, or VO_WHISPER_URL set), not because an older office saved the default address.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { officeWhisper } from '../app/provider-layer/vo-voice.mjs';

const dir = cfg => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-adopt-')); fs.writeFileSync(path.join(d, 'vo-config.json'), JSON.stringify(cfg)); return d; };

test('Whisper off with the saved default address: not adopted', () => {
  assert.equal(officeWhisper(dir({ features: { whisper: false }, whisper: { url: 'http://127.0.0.1:8087' } }), {}), null);
});
test('Whisper on: adopted at its address', () => {
  assert.deepEqual(officeWhisper(dir({ features: { whisper: true }, whisper: { url: 'http://whisper.lan:8087/' } }), {}), { url: 'http://whisper.lan:8087' });
});
test('VO_WHISPER_URL set: adopted even with the switch off', () => {
  assert.deepEqual(officeWhisper(dir({ features: { whisper: false } }), { VO_WHISPER_URL: 'http://host.docker.internal:8087' }), { url: 'http://host.docker.internal:8087' });
});
test('no config: not adopted', () => {
  assert.equal(officeWhisper(dir({}), {}), null);
});
