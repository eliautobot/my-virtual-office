// 0.12.0 fix: an OpenClaw agent's "Model and details" panel with the provider layer on (the default) asks nothing the
// office cannot answer: the layer's OpenClaw agents declare no office-read skills (their skills are in Agent Providers'
// menu), so the panel says where they are instead of requesting GET /api/agent/<id>/skills (which answered 405 and
// logged a console error each time). An agent whose provider does declare skills (Codex) still lists them.
//
// Needs an office with the layer on and OpenClaw agents, e.g. tests/tools/office-labs.sh (VO_URL=its office).
// Run: VO_URL=http://127.0.0.1:19720 node tests/e2e/rel_skills_panel.mjs
import { VO, launch, check, summary, sleep } from './pl_lib.mjs';

const { browser, page, errors } = await launch();
const consoleErrors = [], skillAnswers = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('response', r => { if (/\/api\/agent\/[^/]+\/skills(\?|$)/.test(r.url())) skillAnswers.push(`${r.status()} ${new URL(r.url()).pathname}`); });
try {
  await page.waitForFunction(() => Array.isArray(window.agents) ? window.agents.length > 0 : (typeof agents !== 'undefined' && agents.length > 0), null, { timeout: 30000 });
  const ids = await page.evaluate(() => agents.map(a => [a.id, a.providerKind, !!(a.capabilities && a.capabilities.skills)]));
  const oc = ids.find(x => x[1] === 'openclaw');
  check('an OpenClaw agent is in the office', !!oc, JSON.stringify(ids));
  check('the layer\'s OpenClaw agent declares no office-read skills', oc && oc[2] === false);
  const before = consoleErrors.length;
  for (let i = 0; i < 2; i++) {
    await page.evaluate(id => openModal(agents.find(a => a.id === id)), oc[0]);
    await sleep(1500);
    await page.evaluate(() => { const m = document.getElementById('agentModal'); if (m) m.classList.add('hidden'); });
  }
  check('opening its panel twice requests no skills list', !skillAnswers.some(s => s.includes(`/api/agent/${oc[0]}/skills`)), skillAnswers.join(', '));
  check('and logs no console error', consoleErrors.length === before, consoleErrors.slice(before).join(' | '));
  const note = await page.evaluate(() => (document.getElementById('skills-list') || {}).textContent || '');
  check('its skills list says where its skills are', /Agent Providers/.test(note), note.slice(0, 160));
  const direct = await page.evaluate(async id => { const r = await fetch(`/api/agent/${id}/skills`); return [r.status, await r.json()]; }, oc[0]);
  check('the skills route answers GET (200, supported: false), never 405', direct[0] === 200 && direct[1].supported === false && Array.isArray(direct[1].skills), JSON.stringify(direct).slice(0, 200));
  const withSkills = ids.find(x => x[2]);
  if (withSkills) {
    const r = await page.evaluate(async id => (await fetch(`/api/agent/${id}/skills`)).status, withSkills[0]);
    check(`an agent whose provider declares skills (${withSkills[1]}) still lists them`, r === 200, String(r));
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
process.exitCode = summary('rel_skills_panel');
