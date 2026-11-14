// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// Moves the office's saved OpenClaw and Hermes connections (0.10.x) into the provider layer, once (SHARED.md 5.5, 5.6).
//
// What it reads, in the office's data folder (the layer's data folder's parent):
//   agent-providers.json        Hermes `serve` connections (id, name, enabled, access, url, auth, username,
//                               profileAgents) and OpenClaw's access level
//   provider-secrets.json       their token / password / sign-in tokens ("hermes:<id>")
//   vo-config.json              OpenClaw's gateway address and token (when the office server handed over nothing)
//   openclaw-device.json        the office's device: its Ed25519 seed, deviceId, device token and pairing
//   provider-agents-cache.json  the Hermes profiles last seen (names and emojis while Hermes is away)
//   provider-active-session-hermes-serve-<office id>.json   the chat each Hermes agent had open
// and <layer data>/.migrate-in.json, which the office server writes (0600) just before it starts the layer with what it
// uses for OpenClaw itself (its environment, vo-config.json or OpenClaw's own settings); deleted once read.
//
// What it makes: one installation connection per source (shared with the office's agents, as their agent token could
// reach these agents before), its credentials sealed, the device key as PKCS#8 PEM of the same seed (same deviceId: the
// gateway keeps the pairing), the device token in the layer's form; an agent record per Hermes profile the office had
// given an id, with that office id kept (vo_office_agents); the open Hermes chat of each as a chat of the office.
//
// Once: each source is recorded in vo_migrated and never taken again (running it twice changes nothing; a connection
// removed in the layer later is not brought back). The old files stay where they are (the office without the layer still
// reads them) and are copied once to <file>.pre-pl. Nothing secret is logged or returned: the report says what was
// moved, never a value.
import fs from 'node:fs';
import path from 'node:path';
import { aadConnection } from './server/secret-holders.js';
import { identityFrom } from './server/providers/openclaw/identity.js';
import { providerAgentKey } from './server/agent-providers.js';
import { clean, emojiOf, emptyExt } from './server/agents.js';

export const BACKUP_SUFFIX = '.pre-pl';
export const HANDOFF_FILE = '.migrate-in.json';
export const REPORT_FILE = 'vo-migrate.json';
export const OFFICE_ACCOUNT_ID = 1;
const SOURCE_FILES = ['agent-providers.json', 'provider-secrets.json', 'vo-config.json', 'openclaw-device.json', 'provider-agents-cache.json'];
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DEFAULT_GATEWAY = 'ws://127.0.0.1:18789';

/** The office's own tables in next.db: what was migrated (and how its agents are named), and the office id of each agent. */
export function ensureOfficeTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vo_migrated (
      world_id TEXT NOT NULL, source TEXT NOT NULL, connection_id INTEGER, rule TEXT NOT NULL DEFAULT 'key', created INTEGER NOT NULL,
      PRIMARY KEY (world_id, source));
    CREATE TABLE IF NOT EXISTS vo_office_agents (
      world_id TEXT NOT NULL, agent_id INTEGER NOT NULL, office_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'live',
      created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (world_id, agent_id));
    CREATE UNIQUE INDEX IF NOT EXISTS vo_office_agents_office ON vo_office_agents (world_id, office_id);`);
}

/** PKCS#8 PEM of a raw Ed25519 seed (base64url, as openclaw_device.py keeps it). */
export function seedToPem(seedB64url) {
  const seed = Buffer.from(String(seedB64url || ''), 'base64url');
  if (seed.length !== 32) throw new Error('the device seed is not 32 bytes');
  const b64 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]).toString('base64');
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** host:port of a gateway address, as openclaw_device.gateway_key() writes it (the pairing's address). */
export function gatewayKey(url) {
  try {
    const u = new URL(String(url || ''));
    const port = u.port || (u.protocol === 'wss:' || u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`;
  } catch { return ''; }
}

/** The office id a 0.10 Hermes serve connection gives a new profile (agent_providers._computed_agent_id): its default
 *  profile is `hermes-<id>` when the connection had no profiles listed yet (first), else `hermes-<id>-<profile>`. */
export function legacyHermesId(legacyCid, profile, first = false) {
  if (first && String(profile || '') === 'default') return `hermes-${legacyCid}`;
  const slug = String(profile || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'profile';
  return `hermes-${legacyCid}-${slug}`;
}

const readJson = file => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const safePart = s => String(s || '').replace(/[^a-zA-Z0-9_.-]+/g, '-');
const str = (v, n = 4000) => (typeof v === 'string' && v.length && v.length <= n ? v : '');

function checkedUrl(raw, fallback = '') {
  try {
    const u = new URL(String(raw || fallback));
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) || u.username || u.password) return '';
    return u.toString();
  } catch { return ''; }
}

/** Copies each old file once to <file>.pre-pl (0600); the original stays. */
function backup(officeDir, names) {
  const done = [];
  for (const n of names) {
    const src = path.join(officeDir, n), dst = src + BACKUP_SUFFIX;
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try { fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); fs.chmodSync(dst, 0o600); done.push(n); } catch { /* kept as it is */ }
  }
  return done;
}

/**
 * A fresh office whose OpenClaw gateway was saved after the migration ran (the setup wizard's Gateway Connection, or a
 * token readable only later): that gateway becomes the layer's OpenClaw connection, as the migration would have made it
 * (installation-wide, shared with the members, its agents keeping the gateway's own ids as office ids), while the layer
 * has none yet: never beside an existing one, never again once one was made (removing it in Agent Providers sticks).
 * Returns { adopted, connectionId?, reason? } (no secret in it).
 */
export function adoptOpenClaw({ dbs, box, registry, data, officeDir = null, url, token, log = null, now = () => Date.now() }) {
  const db = dbs.db, w = dbs.worldId;
  officeDir = officeDir || path.dirname(path.resolve(data));
  ensureOfficeTables(db);
  if (!registry.manifest('openclaw')) return { adopted: false, reason: 'no OpenClaw support' };
  const gw = checkedUrl(url, DEFAULT_GATEWAY), shared = str(token);
  if (!gw || !shared) return { adopted: false, reason: 'no gateway token' };
  const existing = db.prepare("SELECT id FROM connections WHERE world_id = ? AND kind = 'openclaw' AND deleted IS NULL ORDER BY id").get(w);
  if (existing) return { adopted: false, connectionId: Number(existing.id), reason: 'already connected' };
  const row = db.prepare("SELECT connection_id FROM vo_migrated WHERE world_id = ? AND source = 'openclaw'").get(w);
  if (row && row.connection_id !== null && row.connection_id !== undefined) return { adopted: false, reason: 'removed in Agent Providers' };
  const ap = readJson(path.join(officeDir, 'agent-providers.json')) || {};
  const access = (ap.openclaw && ap.openclaw.access) === 'chat' ? 'chat' : 'full';
  const t = now();
  let cid;
  db.exec('BEGIN IMMEDIATE');
  try {
    cid = Number(db.prepare('INSERT INTO connections (world_id, kind, label, scope, owner_id, config_json, enabled, created, updated) VALUES (?, ?, ?, \'installation\', NULL, ?, 1, ?, ?)')
      .run(w, 'openclaw', 'OpenClaw', JSON.stringify({ url: gw, auth: 'token', access }), t, t).lastInsertRowid);
    db.prepare('INSERT INTO connection_secrets (world_id, connection_id, field, sealed) VALUES (?, ?, ?, ?) ON CONFLICT (world_id, connection_id, field) DO UPDATE SET sealed = excluded.sealed')
      .run(w, cid, 'token', box.seal(shared, aadConnection(w, cid, 'token')));
    db.prepare('INSERT OR IGNORE INTO connection_shares (world_id, connection_id, kind, who, created) VALUES (?, ?, \'role\', \'member\', ?)').run(w, cid, t);
    db.prepare('INSERT INTO vo_migrated (world_id, source, connection_id, rule, created) VALUES (?, \'openclaw\', ?, \'native\', ?) ON CONFLICT (world_id, source) DO UPDATE SET connection_id = excluded.connection_id, rule = excluded.rule')
      .run(w, cid, t);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  log?.(`[migrate] the office's saved OpenClaw gateway is now the layer's OpenClaw connection (${cid})`);
  try {
    const prev = readJson(path.join(data, REPORT_FILE)) || {};
    const sources = { ...(prev.sources || {}), openclaw: { connectionId: cid, device: false, paired: false, credential: 'token', adopted: true } };
    fs.writeFileSync(path.join(data, REPORT_FILE), JSON.stringify({ updated: t, sources }, null, 2), { mode: 0o600 });
  } catch { /* the database is the record */ }
  return { adopted: true, connectionId: cid };
}

/**
 * Runs the migration. Returns a report (no secret in it): { ran, sources: { <source>: { connectionId|null, ... } }, ... }.
 * @param {{ dbs: { db: object, worldId: string }, box: object, registry: object, data: string, officeDir?: string|null,
 *   log?: Function|null, now?: () => number }} o
 */
export function migrateOffice({ dbs, box, registry, data, officeDir = null, log = null, now = () => Date.now() }) {
  const db = dbs.db, w = dbs.worldId;
  officeDir = officeDir || path.dirname(path.resolve(data));
  ensureOfficeTables(db);
  const handoffFile = path.join(data, HANDOFF_FILE);
  const handoff = readJson(handoffFile);
  try { fs.unlinkSync(handoffFile); } catch { /* none */ }

  const q = {
    done: db.prepare('SELECT source, connection_id, rule FROM vo_migrated WHERE world_id = ? AND source = ?'),
    mark: db.prepare('INSERT OR IGNORE INTO vo_migrated (world_id, source, connection_id, rule, created) VALUES (?, ?, ?, ?, ?)'),
    conn: db.prepare('INSERT INTO connections (world_id, kind, label, scope, owner_id, config_json, enabled, created, updated) VALUES (?, ?, ?, \'installation\', NULL, ?, ?, ?, ?)'),
    secret: db.prepare('INSERT INTO connection_secrets (world_id, connection_id, field, sealed) VALUES (?, ?, ?, ?) ON CONFLICT (world_id, connection_id, field) DO UPDATE SET sealed = excluded.sealed'),
    share: db.prepare('INSERT OR IGNORE INTO connection_shares (world_id, connection_id, kind, who, created) VALUES (?, ?, \'role\', \'member\', ?)'),
    agentByKey: db.prepare('SELECT id FROM agents WHERE world_id = ? AND agent_key = ?'),
    agent: db.prepare(`INSERT INTO agents (world_id, agent_key, owner_id, connection_id, native_id, name, emoji, role, body_ref, look_ref, desk_json, voice_json, ext_json, enabled, created, updated)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, ?, ?)`),
    officeTaken: db.prepare('SELECT agent_id FROM vo_office_agents WHERE world_id = ? AND office_id = ?'),
    office: db.prepare('INSERT OR IGNORE INTO vo_office_agents (world_id, agent_id, office_id, state, created, updated) VALUES (?, ?, ?, \'live\', ?, ?)'),
    chatByKey: db.prepare('SELECT id FROM chat_sessions WHERE world_id = ? AND account_id = ? AND agent_id = ? AND native_key = ? AND deleted IS NULL'),
    chat: db.prepare('INSERT INTO chat_sessions (world_id, agent_id, account_id, native_key, label, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  };
  const isDone = source => !!q.done.get(w, source);
  const seal = (cid, field, value) => { if (value) q.secret.run(w, cid, field, box.seal(value, aadConnection(w, cid, field))); };
  const ext = JSON.stringify(emptyExt());
  const report = { ran: now(), sources: {}, backups: [], skipped: [] };

  const ap = readJson(path.join(officeDir, 'agent-providers.json')) || {};
  const secrets = (readJson(path.join(officeDir, 'provider-secrets.json')) || {}).items || {};
  const cache = readJson(path.join(officeDir, 'provider-agents-cache.json')) || {};
  const voConfig = readJson(path.join(officeDir, 'vo-config.json')) || {};
  const pending = [];

  // (moved before without a gateway: one the office saved since, its setup wizard's, is adopted now: adoptOpenClaw)
  const savedOc = handoff && handoff.openclaw;
  if (isDone('openclaw') && savedOc && savedOc.token && savedOc.auth !== 'password') {
    try { adoptOpenClaw({ dbs, box, registry, data, officeDir, url: savedOc.url, token: savedOc.token, log, now }); }
    catch (e) { report.skipped.push(`openclaw gateway saved later: ${e.message}`); }
  }
  // ---------------------------------------------------------------- OpenClaw: the gateway and the office's device
  if (!isDone('openclaw') && registry.manifest('openclaw')) {
    const oc = (handoff && handoff.openclaw) || {};
    const cfgOc = voConfig.openclaw || {};
    const url = checkedUrl(oc.url || cfgOc.gatewayUrl, DEFAULT_GATEWAY);
    const auth = oc.auth === 'password' ? 'password' : 'token';
    const shared = str(auth === 'password' ? oc.password : (oc.token || cfgOc.gatewayToken));
    const access = (ap.openclaw && ap.openclaw.access) === 'chat' ? 'chat' : 'full';
    const dev = readJson(path.join(officeDir, 'openclaw-device.json'));
    let deviceKey = '', deviceToken = '';
    if (dev && dev.privateKey) {
      try {
        const pem = seedToPem(dev.privateKey);
        if (identityFrom(pem).deviceId !== dev.deviceId) throw new Error('its deviceId does not match its key');
        deviceKey = pem;
        // (the token is the gateway's for one address: kept only for the address it was issued at)
        const p = dev.pairing || {};
        if (str(dev.deviceToken) && p.state === 'paired' && p.gateway === gatewayKey(url)) {
          deviceToken = JSON.stringify({ deviceId: dev.deviceId, role: 'operator', token: dev.deviceToken, scopes: Array.isArray(p.scopes) ? p.scopes.filter(s => typeof s === 'string') : [] });
        }
      } catch (e) { report.skipped.push(`openclaw device: ${e.message}`); }
    }
    if (url && (shared || deviceToken)) {
      pending.push(() => {
        const t = now();
        const cid = Number(q.conn.run(w, 'openclaw', 'OpenClaw', JSON.stringify({ url, auth, access }), 1, t, t).lastInsertRowid);
        seal(cid, auth, shared); seal(cid, 'deviceKey', deviceKey); seal(cid, 'deviceToken', deviceToken);
        q.share.run(w, cid, t);
        // (its agents keep the gateway's own ids as their office ids: the first sync names them, vo-agents-bridge.mjs)
        q.mark.run(w, 'openclaw', cid, 'native', t);
        report.sources.openclaw = { connectionId: cid, device: !!deviceKey, paired: !!deviceToken, credential: shared ? auth : 'device' };
      });
    } else {
      pending.push(() => { q.mark.run(w, 'openclaw', null, 'key', now()); report.sources.openclaw = { connectionId: null, reason: 'no gateway token or paired device' }; });
    }
  }

  // ---------------------------------------------------------------- Hermes `serve` connections and their profiles
  for (const c of Array.isArray(ap.connections) ? ap.connections : []) {
    if (!c || typeof c !== 'object' || !c.id || (c.kind || 'hermes') !== 'hermes' || (c.transport || 'serve') !== 'serve') continue;
    const legacyCid = String(c.id), source = `hermes:${legacyCid}`;
    if (isDone(source) || !registry.manifest('hermes')) continue;
    const url = checkedUrl(c.url);
    const auth = c.auth === 'password' ? 'password' : 'token';
    const sec = secrets[`hermes:${legacyCid}`] || {};
    if (!url) { pending.push(() => { q.mark.run(w, source, null, 'key', now()); report.sources[source] = { connectionId: null, reason: 'no address' }; }); continue; }
    const profiles = new Map(((cache[legacyCid] || {}).profiles || []).filter(p => p && p.profile).map(p => [String(p.profile), p]));
    pending.push(() => {
      const t = now();
      const config = { url, auth, access: c.access === 'chat' ? 'chat' : 'full', ...(auth === 'password' && c.username ? { username: clean(c.username, 500) } : {}) };
      const cid = Number(q.conn.run(w, 'hermes', clean(c.name, 60) || 'Hermes', JSON.stringify(config), c.enabled === false ? 0 : 1, t, t).lastInsertRowid);
      if (auth === 'token') seal(cid, 'token', str(sec.token));
      else { seal(cid, 'password', str(sec.password)); seal(cid, 'tokens', str(sec.tokens, 8000)); }
      q.share.run(w, cid, t);
      const agentsMade = [];
      for (const [profile, officeId] of Object.entries(c.profileAgents || {})) {
        const oid = clean(officeId, 120);
        if (!oid || q.officeTaken.get(w, oid)) continue;
        const key = providerAgentKey(cid, profile);
        if (q.agentByKey.get(w, key)) continue;
        const p = profiles.get(String(profile)) || {};
        const name = clean(p.name || profile, 32) || 'Hermes agent';
        const aid = Number(q.agent.run(w, key, cid, String(profile).slice(0, 120), name, emojiOf(p.emoji || ''), 'Hermes agent', oid, ext, t, t).lastInsertRowid);
        q.office.run(w, aid, oid, t, t);
        agentsMade.push(oid);
        // the chat it had open in the office (its title comes from Hermes, which names its sessions)
        const active = readJson(path.join(officeDir, `provider-active-session-hermes-serve-${safePart(oid)}.json`));
        const sid = active && str(active.sessionId, 300);
        if (sid && !q.chatByKey.get(w, OFFICE_ACCOUNT_ID, aid, sid)) {
          const at = Math.round(Number(active.selectedAt) * 1000) || t;
          q.chat.run(w, aid, OFFICE_ACCOUNT_ID, sid, 'Chat', at, at);
        }
      }
      // (a connection 0.10 never listed gives its default profile `hermes-<id>`, as 0.10's first listing would: ':first')
      q.mark.run(w, source, cid, `hermes:${legacyCid}${Object.keys(c.profileAgents || {}).length ? '' : ':first'}`, t);
      report.sources[source] = { connectionId: cid, auth, signInTokens: auth === 'password' && !!str(sec.tokens, 8000), agents: agentsMade };
    });
  }

  if (!pending.length) return { ...report, ran: null };
  report.backups = backup(officeDir, SOURCE_FILES);
  db.exec('BEGIN IMMEDIATE');
  try { for (const fn of pending) fn(); db.exec('COMMIT'); }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  const n = Object.values(report.sources).filter(s => s.connectionId).length;
  log?.(`[migrate] moved ${n} saved connection(s) into the provider layer (${Object.keys(report.sources).join(', ')}); old files kept${report.backups.length ? `, backups ${report.backups.map(b => b + BACKUP_SUFFIX).join(', ')}` : ''}`);
  for (const s of report.skipped) log?.warn?.(`[migrate] ${s}`);
  try {
    const prev = readJson(path.join(data, REPORT_FILE)) || {};
    const all = { ...(prev.sources || {}), ...report.sources };
    fs.writeFileSync(path.join(data, REPORT_FILE), JSON.stringify({ updated: report.ran, sources: all }, null, 2), { mode: 0o600 });
  } catch { /* the database is the record */ }
  return report;
}
