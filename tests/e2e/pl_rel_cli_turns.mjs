// 0.12.0 presence3 e2e: a chat-window turn of the office's own CLI providers leaves its agent idle (Claude Code stayed
// "working" for ever: a second presence run under the CLI's session id). Private office with every provider on fakes
// (tests/tools/office-labs.sh, LABS_OC=0 LABS_HAPI=0 is enough), then:
//   VO_URL=http://127.0.0.1:<p> PL_OUT=<dir> node tests/e2e/pl_rel_cli_turns.mjs
import { check, summary, api, sleep } from './pl_lib.mjs';

const until = async (fn, ms, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const status = async () => { try { return (await api('/status')).body || {}; } catch { return {}; } };
const brief = s => s ? `${s.state} ${s.source} ${s.runId || '-'} runs=${s.activeRunCount} last=${s.lastRunOutcome || '-'}` : 'none';
const roster = (await status());
const key = prefix => Object.keys(roster).find(k => k.startsWith(prefix));

const cases = [
  { name: 'Claude Code', key: key('claude-code-'), start: k => api('/api/claude-code/runs', { method: 'POST', body: { agentId: k, message: 'hello [[tool]]' } }) },
  { name: 'Codex', key: key('codex-'), start: k => api('/api/codex/runs', { method: 'POST', body: { agentId: k, message: 'hello [[tool]]' } }) },
  { name: 'OpenCode', key: key('opencode:'), start: k => api('/api/provider-runs', { method: 'POST', body: { agentId: k, message: 'hello' } }) },
  { name: 'Antigravity', key: key('antigravity:'), start: k => api('/api/provider-runs', { method: 'POST', body: { agentId: k, message: 'hello' } }) },
];
for (const c of cases) {
  if (!c.key) { check(`${c.name}: agent in the office`, false, Object.keys(roster).join(' ')); continue; }
  for (const turn of [1, 2]) {
    const last0 = ((await status())[c.key] || {}).lastRunId || '';
    const r = await c.start(c.key);
    check(`${c.name} turn ${turn}: started`, r.status === 200 && r.body && r.body.ok !== false, JSON.stringify(r.body || {}).slice(0, 140));
    // (a run finished: lastRunId changed; then nothing may be left open)
    const done = await until(async () => { const s = (await status())[c.key]; return s && s.lastRunId && s.lastRunId !== last0 && s.state !== 'working' && !s.activeRunCount ? s : null; }, 60000, 300);
    check(`${c.name} turn ${turn}: the turn ended, no run left`, !!done, brief(done || (await status())[c.key]));
    const idle = await until(async () => { const s = (await status())[c.key]; return s && s.state === 'idle' ? s : null; }, 30000, 500);
    check(`${c.name} turn ${turn}: idle`, !!idle, brief(idle || (await status())[c.key]));
  }
  await sleep(5000);
  const later = (await status())[c.key];
  check(`${c.name}: still idle 5 s later`, later && later.state === 'idle' && !later.activeRunCount, brief(later));
}
process.exit(summary('pl_rel_cli_turns'));
