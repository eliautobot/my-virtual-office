// v0.10.1 updates (app/vo-updates.js): the "Version X is available" banner (link, close = hidden for
// that version for 24 h, none when up to date / off / offline), Settings > General > Version (status,
// Check now, the switch saved with Settings Save) and What's new (once after an update, never on a
// browser that never opened the office). Hermetic page: fixtures only, every non-GET aborted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_updates';
const NOTES = fs.readFileSync(path.resolve(APP, '..', 'docs', 'RELEASE-NOTES-0.10.1.md'), 'utf8');
const URL_011 = 'https://github.com/eliautobot/my-virtual-office/releases/tag/v0.11.0';
const answer = (over = {}) => Object.assign({ ok: true, current: '0.10.1', latest: '0.11.0', newer: true, url: URL_011,
    releasesUrl: 'https://github.com/eliautobot/my-virtual-office/releases',
    howToUrl: 'https://github.com/eliautobot/my-virtual-office/blob/HEAD/docs/UPDATING.md',
    name: 'v0.11.0 - Next', publishedAt: '2026-12-01T10:00:00Z', checkedAt: '2026-12-01T11:00:00Z', enabled: true, error: null }, over);

let upd = answer();
const calls = [];
const fixtures = {
    '/api/version': { ok: true, status: 'running', version: '0.10.1', current: '0.10.1' },
    '/api/version/updates': url => { calls.push(url.search); return upd; },
    '/api/version/notes': { ok: true, version: '0.10.1', markdown: NOTES },
};
// localStorage as it was before the page loaded, set once per tab (init scripts run on every load).
const seed = values => [`(function (v) { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    for (var k in v) { if (v[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, v[k]); } })(${JSON.stringify(values)});`][0];
const UPGRADED = { 'vo-seen-version': '0.10.1' };   // no What's new in the banner checks

const browser = await launch(NAME);
const r = reporter();
async function open(opts = {}) {
    const o = await openPage(browser, Object.assign({ fixtures }, opts, { init: opts.init ? { content: opts.init } : { content: seed(UPGRADED) } }));
    return o;
}
const banner = page => page.evaluate(() => {
    const b = document.getElementById('voUpdateBanner');
    if (!b || b.hidden || getComputedStyle(b).display === 'none') return null;
    const rect = b.getBoundingClientRect();
    const a = b.querySelector('.vo-update-link');
    return { text: b.querySelector('.vo-update-text').textContent, link: a.textContent, href: a.href, target: a.target, rel: a.rel,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, vw: innerWidth, bg: getComputedStyle(b).backgroundColor,
        color: getComputedStyle(b).color, icon: !!b.querySelector('svg.vo-icon use[href="#i-sparkle"]'),
        close: b.querySelector('.vo-update-close').getAttribute('aria-label') };
});
const waitBanner = page => page.waitForFunction(() => { const b = document.getElementById('voUpdateBanner'); return b && !b.hidden; }, null, { timeout: 15000 });
const settled = page => page.waitForFunction(() => window.VOUpdates && window.VOUpdates.state().last, null, { timeout: 15000 });

try {
    // ---- banner, light + dark, desktop + phone -------------------------------------------------------
    for (const [theme, phone] of [['dark', false], ['light', false], ['dark', true]]) {
        upd = answer();
        const { context, page, errors, blocked } = await open({ theme, phone, viewport: phone ? { width: 390, height: 844 } : undefined });
        await waitBanner(page);
        const b = await banner(page);
        assert.equal(b.text, 'Version 0.11.0 is available.');
        assert.equal(b.link, "See what's new");
        assert.equal(b.href, URL_011);
        assert.equal(b.target, '_blank');
        assert.match(b.rel, /noopener/);
        assert.ok(b.icon, 'pixel sparkle icon');
        assert.equal(b.close, 'Hide for a day');
        assert.ok(b.left >= 0 && b.right <= b.vw && b.top >= 0, `inside the window: ${JSON.stringify(b)}`);
        assert.notEqual(b.bg, b.color);
        assert.equal(await page.$('#voWhatsNew'), null, 'no What\'s new for a browser already on 0.10.1');
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, []);
        await context.close();
    }
    r.pass('banner: text, release link in a new tab, icon, inside the window (dark, light, phone)');

    // ---- every theme: banner and Version status readable (WCAG 4.5:1) ---------------------------------
    for (const preset of ['classic', 'retro', 'cyberpunk', 'gameboy']) for (const theme of ['dark', 'light']) {
        upd = answer();
        const { context, page } = await open({ theme, preset });
        await waitBanner(page);
        const c = await page.evaluate(() => {
            const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
            const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
            const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
            const bgOf = el => { while (el) { const v = getComputedStyle(el).backgroundColor; if (v !== 'transparent' && !/, 0\)$/.test(v)) return v; el = el.parentElement; } return 'rgb(255, 255, 255)'; };
            const b = document.getElementById('voUpdateBanner');
            const bg = getComputedStyle(b).backgroundColor;
            const st = document.getElementById('mm-version-status');
            const sbg = bgOf(st.parentElement);
            const out = { text: ratio(getComputedStyle(b.querySelector('.vo-update-text')).color, bg),
                link: ratio(getComputedStyle(b.querySelector('.vo-update-link')).color, bg) };
            for (const cls of ['', 'is-new', 'is-error']) {
                st.className = 'mm-hint mm-version-status ' + cls;
                out['status' + cls] = ratio(getComputedStyle(st).color, sbg);
            }
            st.className = 'mm-hint mm-version-status';
            return out;
        });
        for (const [k, v] of Object.entries(c)) assert.ok(v >= 4.5, `${preset} ${theme} ${k} contrast ${v.toFixed(2)}`);
        await context.close();
    }
    r.pass('every theme (classic, retro, cyberpunk, gameboy; dark and light): banner and status lines readable');

    // ---- close = hidden for that version for 24 h ------------------------------------------------------
    {
        upd = answer();
        const { context, page } = await open();
        await waitBanner(page);
        await page.click('#voUpdateBanner .vo-update-close');
        assert.equal(await banner(page), null, 'closed');
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vo-update-dismissed')));
        assert.equal(saved.version, '0.11.0');
        assert.ok(Math.abs(saved.at - Date.now()) < 60000);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await settled(page);
        await page.waitForTimeout(300);
        assert.equal(await banner(page), null, 'still hidden after a reload');
        upd = answer({ latest: '0.11.1', url: URL_011.replace('0.11.0', '0.11.1') });
        await page.evaluate(() => VOUpdates.check(false));
        assert.equal((await banner(page)).text, 'Version 0.11.1 is available.', 'a newer version shows again');
        upd = answer();
        await page.evaluate(() => localStorage.setItem('vo-update-dismissed', JSON.stringify({ version: '0.11.0', at: Date.now() - 25 * 3600 * 1000 })));
        await page.evaluate(() => VOUpdates.check(false));
        assert.ok(await banner(page), 'shows again after 24 h');
        await context.close();
    }
    r.pass('close hides that version for 24 h (kept over reloads, a newer version shows)');

    // ---- no banner: up to date, off, failed check, offline ---------------------------------------------
    {
        upd = answer({ latest: '0.7.4', newer: false });
        const { context, page } = await open();
        await settled(page);
        await page.waitForTimeout(300);
        assert.equal(await banner(page), null, 'up to date');
        upd = answer({ enabled: false, disabledBy: 'setting', latest: '0.10.1', newer: false });
        await page.evaluate(() => VOUpdates.check(false));
        assert.equal(await banner(page), null, 'check off');
        upd = answer({ newer: false, latest: '0.10.1', error: 'offline or GitHub did not answer' });
        await page.evaluate(() => VOUpdates.check(false));
        assert.equal(await banner(page), null, 'check failed');
        upd = answer();
        await page.evaluate(() => VOUpdates.check(false));
        assert.ok(await banner(page), 'newer: shown');
        await context.setOffline(true);
        await page.waitForFunction(() => document.getElementById('voUpdateBanner').hidden);
        await context.setOffline(false);
        await page.waitForFunction(() => !document.getElementById('voUpdateBanner').hidden);
        await page.evaluate(() => document.documentElement.classList.add('vo-offline'));
        assert.equal(await banner(page), null, 'office unreachable (lost connection banner): hidden');
        // A check that failed (office server down) hides it; back online asks again.
        await page.evaluate(() => document.documentElement.classList.remove('vo-offline'));
        upd = { __status: 503, error: 'down' };
        await page.evaluate(() => VOUpdates.check(false));
        assert.equal(await banner(page), null, 'failed check: hidden');
        upd = answer();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('vo:online')));
        await page.waitForFunction(() => !document.getElementById('voUpdateBanner').hidden);
        const cmp = await page.evaluate(() => [['0.10.1', '0.9.9'], ['v0.10.1', '0.10.1'], ['0.7.4', '0.10.1'], ['1.0', '1.0.0'],
            ['0.10.1-rc.1', '0.10.1'], ['0.10.1-rc.2', '0.10.1-rc.10'], ['0.10.1-alpha', '0.10.1-1'], ['x', '1.0.0']].map(p => VOUpdates.compare(p[0], p[1])));
        assert.deepEqual(cmp, [1, 0, -1, 0, -1, -1, 1, null], 'client semver order matches the server');
        await context.close();
    }
    r.pass('no banner when up to date, turned off, the check failed, or offline; back online asks again; semver order');

    // ---- Settings > General > Version -------------------------------------------------------------------
    {
        upd = answer();
        calls.length = 0;
        const { context, page } = await open();
        await settled(page);
        await page.evaluate(() => toggleMainMenu());
        await page.evaluate(() => document.querySelector('#main-menu-panel .settings-nav button[data-category="general"]').click());
        await page.waitForTimeout(300);
        const block = () => page.evaluate(() => {
            const s = document.getElementById('mm-version-section');
            return { visible: !!s.offsetParent, current: s.querySelector('#mm-version-current').textContent,
                status: s.querySelector('#mm-version-status').textContent, link: s.querySelector('#mm-version-status a')?.href || '',
                btn: s.querySelector('#mm-version-check').textContent, btnDisabled: s.querySelector('#mm-version-check').disabled,
                toggle: s.querySelector('#mm-update-check').checked, toggleDisabled: s.querySelector('#mm-update-check').disabled,
                howto: s.querySelector('#mm-version-howto').href };
        });
        let s = await block();
        assert.equal(s.visible, true);
        assert.equal(s.current, 'My Virtual Office 0.10.1');
        assert.equal(s.status, "Version 0.11.0 is available. See what's new");
        assert.equal(s.link, URL_011);
        assert.equal(s.howto, 'https://github.com/eliautobot/my-virtual-office/blob/HEAD/docs/UPDATING.md');
        assert.equal(s.toggle, true);
        upd = answer({ latest: '0.10.1', newer: false });
        const before = calls.length;
        await page.click('#mm-version-check');
        await page.waitForFunction(() => document.getElementById('mm-version-status').textContent === 'Up to date.');
        assert.equal(calls.slice(before).filter(q => q === '?refresh=1').length, 1, 'Check now skips the cache');
        upd = answer({ latest: '0.10.1', newer: false, limited: true, retryAfter: 40 });
        await page.click('#mm-version-check');
        await page.waitForFunction(() => /less than a minute ago/.test(document.getElementById('mm-version-status').textContent));
        upd = answer({ latest: '0.10.1', newer: false, error: 'GitHub rate limit, trying again later' });
        await page.evaluate(() => VOUpdates.check(true));
        assert.equal((await block()).status, 'Could not check: GitHub rate limit, trying again later.');
        upd = answer({ enabled: false, disabledBy: 'env', latest: '0.10.1', newer: false });
        await page.evaluate(() => VOUpdates.check(false));
        s = await block();
        assert.match(s.status, /turned off on this server/);
        assert.equal(s.toggleDisabled, true);
        assert.equal(s.btnDisabled, true);
        upd = answer({ enabled: false, disabledBy: 'setting', latest: '0.10.1', newer: false });
        await page.evaluate(() => VOUpdates.check(false));
        s = await block();
        assert.equal(s.status, 'Checking for new versions is off.');
        assert.equal(s.toggleDisabled, false);

        // The switch is sent with Settings Save (features.updateCheck), nothing else changes.
        const posts = [];
        page.on('request', req => { if (req.method() === 'POST') posts.push({ path: new URL(req.url()).pathname, body: req.postData() }); });
        await page.click('#mm-update-check');
        await page.evaluate(() => mmSaveSettings());
        const save = posts.find(p => p.path === '/setup/save');
        assert.ok(save, 'Settings Save posted');
        assert.deepEqual(JSON.parse(save.body), { features: { updateCheck: false } });
        await context.close();
    }
    r.pass('Settings > General > Version: status lines, Check now, env/setting off, switch saved with Settings Save');

    // ---- What's new -------------------------------------------------------------------------------------
    upd = answer({ latest: '0.10.1', newer: false });
    const notesWindow = page => page.evaluate(() => {
        const w = document.getElementById('voWhatsNew');
        if (!w) return null;
        return { title: w.querySelector('.vo-window-title').textContent, h2: [...w.querySelectorAll('.vo-notes h2')].map(h => h.textContent),
            items: w.querySelectorAll('.vo-notes li').length, h1: w.querySelectorAll('.vo-notes h1').length,
            brs: w.querySelectorAll('.vo-notes p br, .vo-notes li br').length,
            guide: w.querySelector('.vo-notes a[href$="UPDATING.md"]')?.href, guideTarget: w.querySelector('.vo-notes a[href$="UPDATING.md"]')?.target,
            ok: w.querySelector('.vo-window-foot .vo-btn--primary').textContent, focused: document.activeElement?.textContent };
    });
    {
        // A browser that never opened the office: nothing, and it is recorded.
        const { context, page } = await open({ init: seed({ 'vo-ui-theme': null, 'vo-ui-preset': null }) });
        await settled(page);
        await page.waitForTimeout(500);
        assert.equal(await notesWindow(page), null);
        assert.equal(await page.evaluate(() => localStorage.getItem('vo-seen-version')), '0.10.1');
        assert.equal(await page.evaluate(() => VOUpdates.state().usedBefore), false);
        await context.close();
    }
    for (const [label, values] of [['seen 0.10.0', { 'vo-seen-version': '0.10.0' }], ['used before 0.10.1 stored a version', { 'vo-seen-version': null }]]) {
        const { context, page, errors } = await open({ init: seed(values) });
        await page.waitForSelector('#voWhatsNew', { timeout: 15000 });
        const w = await notesWindow(page);
        assert.equal(w.title, "What's new in 0.10.1", label);
        assert.equal(w.h1, 0, 'the title replaces the first heading');
        assert.ok(w.h2.includes('Live updates and connection'), `rendered markdown: ${w.h2}`);
        assert.ok(w.items > 5);
        assert.equal(w.brs, 0, 'wrapped lines of the notes are joined');
        assert.equal(w.guide, 'https://github.com/eliautobot/my-virtual-office/blob/HEAD/docs/UPDATING.md', 'doc links open on GitHub');
        assert.equal(w.guideTarget, '_blank');
        assert.equal(w.ok, 'Got it');
        await page.click('#voWhatsNew .vo-window-foot .vo-btn--primary');
        assert.equal(await page.$('#voWhatsNew'), null, 'Got it closes it');
        assert.equal(await page.evaluate(() => localStorage.getItem('vo-seen-version')), '0.10.1');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await settled(page);
        await page.waitForTimeout(500);
        assert.equal(await page.$('#voWhatsNew'), null, `${label}: shown once`);
        assert.deepEqual(errors, []);
        await context.close();
    }
    r.pass("What's new: once after an update (rendered notes, Got it), nothing on a first visit");

    // v0.11 relux (playtest #7): once seen and closed, Settings > General > Version opens it again.
    {
        const { context, page, errors } = await open({ init: seed(UPGRADED) });
        await settled(page);
        assert.equal(await page.$('#voWhatsNew'), null, 'already seen: not shown by itself');
        await page.evaluate(() => toggleMainMenu());
        await page.evaluate(() => document.querySelector('#main-menu-panel .settings-nav button[data-category="general"]').click());
        await page.waitForFunction(() => !document.getElementById('mm-version-notes').hidden, null, { timeout: 5000 });
        const btn = await page.evaluate(() => { const b = document.getElementById('mm-version-notes'); const r = b.getBoundingClientRect();
            return { text: b.textContent, w: r.width, h: r.height, tag: b.tagName }; });
        assert.equal(btn.text, "What's new in 0.10.1");
        assert.equal(btn.tag, 'BUTTON');
        assert.ok(btn.w > 0 && btn.h >= 24, `button box ${btn.w}x${btn.h}`);
        await page.click('#mm-version-notes');
        await page.waitForSelector('#voWhatsNew', { timeout: 5000 });
        const w = await notesWindow(page);
        assert.equal(w.title, "What's new in 0.10.1");
        assert.ok(w.h2.includes('Live updates and connection'));
        await page.click('#mm-version-notes', { force: true }).catch(() => {});
        assert.equal(await page.evaluate(() => document.querySelectorAll('#voWhatsNew').length), 1, 'one window at a time');
        await page.click('#voWhatsNew .vo-window-foot .vo-btn--primary');
        assert.equal(await page.$('#voWhatsNew'), null, 'Got it closes it');
        assert.equal(await page.evaluate(() => localStorage.getItem('vo-seen-version')), '0.10.1');
        assert.deepEqual(errors, []);
        await context.close();
    }
    {
        // A version without notes (404): no button.
        const saved = fixtures['/api/version/notes'];
        delete fixtures['/api/version/notes'];
        const { context, page } = await open({ init: seed(UPGRADED) });
        await settled(page);
        await page.evaluate(() => toggleMainMenu());
        await page.evaluate(() => document.querySelector('#main-menu-panel .settings-nav button[data-category="general"]').click());
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => document.getElementById('mm-version-notes').hidden), true);
        fixtures['/api/version/notes'] = saved;
        await context.close();
    }
    r.pass("What's new again from Settings > General > Version (button with the version; none without notes)");

    // v0.11 relux (playtest #10): the notes' links are targets you can hit: heading chips 24 px (44 px on touch), links in
    // sentences 24 px or more, and the text lines do not move. Measured at rest (after the window's pop-in, which scales
    // it from 0.985), with the 0.10.1 fixture notes and with the current release's notes (0.12.0: links in headings).
    const savedNotes = fixtures['/api/version/notes'], savedVersion = fixtures['/api/version'];
    const CURRENT = '0.12.0', CURRENT_NOTES = fs.readFileSync(path.resolve(APP, '..', 'docs', `RELEASE-NOTES-${CURRENT}.md`), 'utf8');
    for (const [notesVersion, phone] of [['0.10.1', false], ['0.10.1', true], [CURRENT, false], [CURRENT, true]]) {
        if (notesVersion === CURRENT) {
            fixtures['/api/version'] = Object.assign({}, savedVersion, { version: CURRENT, current: CURRENT });
            fixtures['/api/version/notes'] = { ok: true, version: CURRENT, markdown: CURRENT_NOTES };
        }
        const { context, page, errors } = await open({ init: seed(notesVersion === CURRENT ? { 'vo-seen-version': CURRENT } : UPGRADED),
            phone, viewport: phone ? { width: 412, height: 915 } : undefined });
        await settled(page);
        await page.evaluate(() => VOUpdates.openWhatsNew());
        await page.waitForSelector('#voWhatsNew', { timeout: 5000 });
        await page.waitForFunction(() => { const w = document.getElementById('voWhatsNew');
            return w && w.getAnimations({ subtree: true }).every(a => a.playState === 'finished' || a.playState === 'idle'); }, null, { timeout: 5000 });
        assert.equal((await notesWindow(page)).title, `What's new in ${notesVersion}`);
        const headingLinks = await page.evaluate(() => document.querySelectorAll('#voWhatsNew .vo-notes h2 a, #voWhatsNew .vo-notes h3 a').length);
        if (notesVersion === CURRENT) assert.ok(headingLinks > 0, `the ${CURRENT} notes have links in headings`);
        const links = await page.evaluate(() => [...document.querySelectorAll('#voWhatsNew .vo-notes a')].map(a => {
            const r = a.getBoundingClientRect(); return { t: a.textContent.trim(), in: a.parentElement.tagName, w: r.width, h: r.height }; }));
        assert.ok(links.length > 0, 'the notes have links');
        for (const l of links) {
            const min = /^H[23]$/.test(l.in) ? (phone ? 44 : 24) : 24;
            assert.ok(l.h >= min && l.w >= (phone && /^H[23]$/.test(l.in) ? 44 : 24), `${notesVersion} notes, ${phone ? 'phone' : 'desktop'}: ${l.t} in ${l.in} is ${l.w}x${l.h}`);
        }
        assert.deepEqual(errors, []);
        await context.close();
    }
    fixtures['/api/version/notes'] = savedNotes; fixtures['/api/version'] = savedVersion;
    r.pass(`What's new links at rest (0.10.1 and ${CURRENT} notes): heading chips 24 px (44 px on touch), links in sentences 24 px or more`);
} finally {
    await browser.close();
}
r.done(NAME);
