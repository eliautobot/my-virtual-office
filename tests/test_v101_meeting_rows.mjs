// v0.10.1 I6: Meetings history rows show the date + time and the one-line summary (and still "Completed"),
// so repeated meetings (one "Morning stand-up" a day) tell apart without opening each. Hermetic page (fixtures).
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_meeting_rows';
const day = 24 * 3600;
const t0 = Math.floor(Date.UTC(2026, 10, 6, 14, 5) / 1000);  // seconds, like the stand-up records
const history = [
    { id: 'standup-20261106', topic: 'Morning stand-up', purpose: 'Morning stand-up', kind: 'standup', organizer: 'office', participants: ['alpha', 'beta'],
        summary: 'Stand-up: 2 agents, 3 tasks done, 1 message answered', startedAt: t0, endedAt: t0 + 90, status: 'completed' },
    { id: 'standup-20261107', topic: 'Morning stand-up', purpose: 'Morning stand-up', kind: 'standup', organizer: 'office', participants: ['alpha', 'beta'],
        summary: 'Stand-up: 2 agents, 5 tasks done\nDetails on the next line', startedAt: t0 + day, endedAt: t0 + day + 90, status: 'completed' },
    { id: 'm3', topic: 'Release plan', organizer: 'alpha', participants: ['alpha'], startedAt: t0 + 2 * day, endedAt: t0 + 2 * day + 600, status: 'completed' },
];

const browser = await launch(NAME);
const R = reporter();
try {
    const { page, errors } = await openPage(browser, { fixtures: {
        '/api/meetings/active': { ok: true, meetings: [] }, '/api/meetings/history': { ok: true, history },
        '/agents-list': { agents: [{ id: 'alpha', name: 'Alpha', emoji: '' }, { id: 'beta', name: 'Beta', emoji: '' }] } } });
    await page.evaluate(() => { openMeetingsDashboard(); switchMtgTab('completed'); });
    await page.waitForFunction(() => document.querySelectorAll('#mtg-cards .mtg-card').length === 3, null, { timeout: 8000 });
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#mtg-cards .mtg-card')).map(c => ({
        title: c.querySelector('.mtg-card-title').textContent.replace('▶', '').trim(),
        when: (c.querySelector('.mtg-card-when') || {}).textContent || '',
        summary: (c.querySelector('.mtg-card-summary') || {}).textContent || '',
        badge: c.querySelector('.mtg-badge').textContent,
        whenVisible: !!c.querySelector('.mtg-card-when') && c.querySelector('.mtg-card-when').getBoundingClientRect().height > 0 })));
    const ups = rows.filter(r => r.title === 'Morning stand-up');
    assert.equal(ups.length, 2, JSON.stringify(rows));
    assert.notEqual(ups[0].when, ups[1].when, 'the two stand-ups differ by date');
    assert.ok(ups.every(r => /Nov\s+[67]/.test(r.when) && /\d{1,2}:\d{2}/.test(r.when) && r.whenVisible), JSON.stringify(ups));
    assert.ok(ups.some(r => r.summary === 'Stand-up: 2 agents, 3 tasks done, 1 message answered'), JSON.stringify(ups));
    assert.ok(ups.some(r => r.summary === 'Stand-up: 2 agents, 5 tasks done'), 'first line only: ' + JSON.stringify(ups));
    assert.ok(rows.every(r => /Completed/.test(r.badge)), 'still Completed');
    const plan = rows.find(r => r.title === 'Release plan');
    assert.ok(plan && plan.when && plan.summary === '', 'no summary line when there is none: ' + JSON.stringify(plan));
    R.pass('history rows: date + time (collapsed), one-line summary, still Completed');
    assert.deepEqual(errors, []);
    R.pass('no page errors');
} finally {
    await browser.close();
}
R.done(NAME);
