// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The office's voice settings (Settings → Voice), next to My Virtual World's voice (server/voice/, copied as it is):
// My Virtual World keeps its installation's voice in its settings table under voice.* (server/settings.js, changed through
// its /api/settings); the office has no such page, so the same keys are read and written here, with the same checks:
//   voice.enabled          the office's voice services may be used ('1' / '0'; default on)
//   voice.listenConnection the voice service that hears everyone who chose none of their own ('' or a connection id)
//   voice.speakConnection  the voice service that speaks for every agent whose owner chose none ('' or an id)
//   voice.perMinute        requests a minute per person (20 / 40 / 60 / 120 / 240)
//   voice.dailyUsd         the day's safety limit on what the office's services may cost (1 / 5 / 20 / 100 / 500 / 0 = none)
// The keys of the services themselves are the connections' secrets (Settings → Voice adds a 'voice' connection: sealed
// with the layer's key like every other connection's token, never sent back to a page and never logged).
//   GET  /api/voice/settings  { values }            (settings.view: the office's owners)
//   POST /api/voice/settings  { values: { ... } }   (settings.secrets) → { values }
//   GET  /api/voice/models?connection=<id>  { speak: [id], listen: [id] }: the models a voice service offers (its own
//        list where it has one, else its documented defaults), for Settings → Voice's model pickers; kept 10 minutes
// Once, at the first start with this voice (adoptOfficeWhisper): an office that set up its own Whisper server (0.11 and
// before: vo-config.json features.whisper / whisper.url, or VO_WHISPER_URL) keeps dictating with it — it becomes the
// office's voice service "This office's Whisper" (provider whisper, everyone's) and the one that listens. Marked done
// with voice.officeWhisper, so removing it in Settings → Voice keeps it removed.
import fs from 'node:fs';
import path from 'node:path';
import { VoiceError } from './server/voice/voice.js';

const PER_MINUTE = ['20', '40', '60', '120', '240'];
const DAILY = ['1', '5', '20', '100', '500', '0'];
const ID = /^\d{1,9}$/;

/** The voice's installation settings, as server/voice/voice.js reads them (its config()). */
export function officeVoiceConfig(perms) {
  const get = (k, d) => String(perms.setting(`voice.${k}`, d) ?? d);
  const daily = get('dailyUsd', '20');
  return {
    enabled: get('enabled', '1') !== '0',
    listenConnection: get('listenConnection', ''),
    speakConnection: get('speakConnection', ''),
    perMinute: Number(get('perMinute', '60')) || 60,
    // (0: no limit — the office's services are its owner's own keys; voice.js reads a falsy limit as its default, so
    // "none" is a limit no day reaches)
    dailyUsd: daily === '0' ? 1e9 : Number(daily) || 20,
  };
}

function values(perms) {
  const get = (k, d) => String(perms.setting(`voice.${k}`, d) ?? d);
  return { enabled: get('enabled', '1') !== '0', listenConnection: get('listenConnection', ''), speakConnection: get('speakConnection', ''),
    perMinute: get('perMinute', '60'), dailyUsd: get('dailyUsd', '20') };
}

/** Checks a change; throws a VoiceError naming the first wrong value. */
function check(v, connections) {
  const out = {};
  if (v.enabled !== undefined) {
    if (typeof v.enabled !== 'boolean') throw new VoiceError(400, 'bad_setting', 'enabled is on or off');
    out.enabled = v.enabled ? '1' : '0';
  }
  for (const k of ['listenConnection', 'speakConnection']) {
    if (v[k] === undefined) continue;
    const s = v[k] === null ? '' : String(v[k]);
    if (s && !ID.test(s)) throw new VoiceError(400, 'bad_setting', 'Choose one of the voice services');
    if (s) {
      // the office's own service for everyone: an installation connection that can do it
      const c = connections.get(Number(s)), what = k === 'listenConnection' ? 'listen' : 'speak';
      if (!c || c.kind !== 'voice' || c.scope !== 'installation') throw new VoiceError(404, 'not_found', 'No such voice service');
      if (!(c.config && c.config.provider) || !c.enabled) throw new VoiceError(409, 'disabled', 'That voice service is switched off');
      out[k] = s; out[`_${what}`] = c;
    } else out[k] = '';
  }
  if (v.perMinute !== undefined) { if (!PER_MINUTE.includes(String(v.perMinute))) throw new VoiceError(400, 'bad_setting', `Requests a minute: one of ${PER_MINUTE.join(', ')}`); out.perMinute = String(v.perMinute); }
  if (v.dailyUsd !== undefined) { if (!DAILY.includes(String(v.dailyUsd))) throw new VoiceError(400, 'bad_setting', 'The daily limit: 1, 5, 20, 100, 500 or none'); out.dailyUsd = String(v.dailyUsd); }
  return out;
}

const answer = fn => async ctx => {
  try { return { status: 200, json: await fn(ctx) }; } catch (e) {
    if (e instanceof VoiceError) return { status: e.status, json: { ok: false, error: e.message, code: e.code } };
    throw e;
  }
};

const modelLists = new Map();   // `${connection}:${updated}` → { at, value }
export function addOfficeVoiceRoutes(router, { voice, perms, connections }) {
  router.add({ method: 'GET', path: '/api/voice/models', cap: 'chat.use', handler: answer(async ({ P, url }) => {
    const id = Number(url.searchParams.get('connection')), c = Number.isInteger(id) && id > 0 ? connections.get(id) : null;
    if (!c || c.kind !== 'voice' || !(voice.canUse(P, c, 'speak') || voice.canUse(P, c, 'listen'))) throw new VoiceError(404, 'not_found', 'No such voice service');
    if (!voice.works(c, 'speak') && !voice.works(c, 'listen')) voice.check(c, 'speak');   // (says why it can't be used)
    const k = `${c.id}:${c.updated}`, hit = modelLists.get(k);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const r = await voice.call(c, 'models', {}, 20000);
    const list = x => (Array.isArray(x) ? x.filter(v => typeof v === 'string' && v && v.length <= 200).slice(0, 300) : []);
    const value = { connection: c.id, speak: list(r && r.speak), listen: list(r && r.listen) };
    modelLists.set(k, { at: Date.now(), value });
    if (modelLists.size > 100) modelLists.delete(modelLists.keys().next().value);
    return value;
  }) });
  router.add({ method: 'GET', path: '/api/voice/settings', cap: 'settings.view', handler: answer(() => ({ values: values(perms) })) });
  router.add({ method: 'POST', path: '/api/voice/settings', cap: 'settings.secrets', handler: answer(({ body }) => {
    const v = body && typeof body.values === 'object' && body.values ? body.values : {};
    const out = check(v, connections);
    for (const what of ['listen', 'speak']) {
      const c = out[`_${what}`];
      if (c) voice.check(c, what);   // (it can do this: a speaking-only server is not the one that hears)
      delete out[`_${what}`];
    }
    for (const [k, s] of Object.entries(out)) perms.setSetting(`voice.${k}`, s);
    return { values: values(perms) };
  }) });
}

/** The office's own Whisper server, as 0.11 set it up: { url } or null (none set up). */
export function officeWhisper(officeDir, env = process.env) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(officeDir, 'vo-config.json'), 'utf8')) || {}; } catch { cfg = {}; }
  const on = cfg.features && cfg.features.whisper === true, url = String(env.VO_WHISPER_URL || (cfg.whisper && cfg.whisper.url) || '').trim();
  // Only a Whisper the office actually used: the feature switched on, or a server named in VO_WHISPER_URL. Older offices
  // saved the default address (127.0.0.1:8087) even with Whisper off; in Docker that address is the container itself.
  if (!on && !env.VO_WHISPER_URL) return null;
  const u = url || 'http://127.0.0.1:8087';
  try { const x = new URL(u); if (x.protocol !== 'http:' && x.protocol !== 'https:') return null; } catch { return null; }
  return { url: u.replace(/\/+$/, '') };
}

/** Once: the office's Whisper server becomes a voice service (see the top). P: the office owner's principal. */
export function adoptOfficeWhisper({ perms, connections, P, officeDir, env = process.env, log = null }) {
  if (perms.setting('voice.officeWhisper', '') === '1') return null;
  const w = officeDir ? officeWhisper(officeDir, env) : null;
  let made = null;
  if (w) {
    const have = connections.list().find(c => c.kind === 'voice' && c.config && c.config.provider === 'whisper' && c.config.baseUrl === w.url);
    made = have || connections.create(P, { kind: 'voice', label: 'This office\'s Whisper', scope: 'installation', config: { provider: 'whisper', baseUrl: w.url } }, null);
    if (!perms.setting('voice.listenConnection', '')) perms.setSetting('voice.listenConnection', String(made.id));
    log?.info?.(`[voice] the office's Whisper server (${w.url}) is the office's listening service`);
  }
  perms.setSetting('voice.officeWhisper', '1');
  return made;
}
