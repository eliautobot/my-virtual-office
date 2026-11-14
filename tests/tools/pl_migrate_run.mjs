// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// Test tool (tests/test_pl_migrate.py): runs vo-migrate.mjs on a layer data folder once, then prints what next.db holds
// as one JSON line. Secrets are printed only as sha256 of their opened value (never the value); the device key as the
// deviceId it makes. Usage: node pl_migrate_run.mjs <layer data> [office data] [--no-migrate]
// (PL_ADOPT_URL / PL_ADOPT_TOKEN set: adoptOpenClaw with them instead of the migration; its answer as `adopt`)
import crypto from 'node:crypto';
import path from 'node:path';
import { openDb } from '../../app/provider-layer/server/db.js';
import { SecretBox } from '../../app/provider-layer/server/secrets.js';
import { registerSecretHolders } from '../../app/provider-layer/server/secret-holders.js';
import { Registry } from '../../app/provider-layer/server/providers/registry.js';
import { BUILTIN_MANIFESTS } from '../../app/provider-layer/server/providers/manifest.js';
import { identityFrom } from '../../app/provider-layer/server/providers/openclaw/identity.js';
import { migrateOffice, adoptOpenClaw, ensureOfficeTables } from '../../app/provider-layer/vo-migrate.mjs';

const [data, officeDir] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const migrate = !process.argv.includes('--no-migrate');
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const dbs = openDb(data);
const box = new SecretBox();
registerSecretHolders(box, dbs);
box.load({ env: { MVW_KEY_FILE: path.join(path.dirname(path.resolve(data)), 'provider-layer.key') }, dataDir: data });
const registry = new Registry({ manifests: BUILTIN_MANIFESTS.filter(m => ['openclaw', 'hermes'].includes(m.id)) });
const logs = [];
const log = (...a) => logs.push(a.join(' '));
log.warn = log; log.error = log; log.info = log;
const adopting = process.env.PL_ADOPT_TOKEN !== undefined;
const adopt = adopting ? adoptOpenClaw({ dbs, box, registry, data, officeDir: officeDir || null, url: process.env.PL_ADOPT_URL, token: process.env.PL_ADOPT_TOKEN, log }) : undefined;
const report = migrate && !adopting ? migrateOffice({ dbs, box, registry, data, officeDir: officeDir || null, log }) : null;
ensureOfficeTables(dbs.db);
const all = sql => dbs.db.prepare(sql).all(dbs.worldId);
const secrets = all('SELECT connection_id, field, sealed FROM connection_secrets WHERE world_id = ? ORDER BY connection_id, field').map(s => {
  const v = box.open(s.sealed, `${dbs.worldId}|connection:${s.connection_id}|${s.field}`);
  const o = { connectionId: s.connection_id, field: s.field, sealedSha: sha(s.sealed), sha: sha(v) };
  if (s.field === 'deviceKey') o.deviceId = identityFrom(v).deviceId;
  if (s.field === 'deviceToken') { const t = JSON.parse(v); o.token = { deviceId: t.deviceId, role: t.role, scopes: t.scopes, sha: sha(t.token) }; }
  if (s.field === 'tokens') { const t = JSON.parse(v); o.tokens = { user: t.user, sha: sha(t.access) }; }
  return o;
});
process.stdout.write(JSON.stringify({
  report, adopt, logs,
  connections: all('SELECT id, kind, label, scope, owner_id, config_json, enabled, created FROM connections WHERE world_id = ? ORDER BY id'),
  shares: all('SELECT connection_id, kind, who FROM connection_shares WHERE world_id = ? ORDER BY connection_id'),
  secrets,
  agents: all('SELECT id, agent_key, owner_id, connection_id, native_id, name, emoji, role, body_ref, enabled, created FROM agents WHERE world_id = ? ORDER BY id'),
  office: all('SELECT agent_id, office_id, state, created FROM vo_office_agents WHERE world_id = ? ORDER BY agent_id'),
  migrated: all('SELECT source, connection_id, rule, created FROM vo_migrated WHERE world_id = ? ORDER BY source'),
  chats: all('SELECT id, agent_id, account_id, native_key, label, created, updated FROM chat_sessions WHERE world_id = ? ORDER BY id'),
}) + '\n');
dbs.db.close();
