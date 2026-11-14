#!/usr/bin/env node
// v0.12 polish: the Office Life headphones (app/office-life/moods.js, VOLifeMoods.headphones = the art drawHeadphones
// draws on a focused agent) against every hair style and every headwear, in front, back and both profiles, standing
// and dozing (the head droops 2 px). Each case is drawn through Agent.draw twice, without and with the headphones,
// and the difference is the headphones:
//   - with a full costume or a headwear whose HEADWEAR_STYLES row says phones: false: nothing is drawn;
//   - otherwise the band rests on the highest thing on the head: no hair or hat pixel above the band's top two rows
//     in the band's own columns (nothing pokes through it), and the head's highest pixel is the row right under the
//     band (no gap), standing and dozing alike (the band moves with the head).
// Fails on the base commit (band at a fixed height: tall hair pokes through, short hair leaves a gap, drawn over a
// hard hat or witch hat). Run: node tests/test_v12_headphones.mjs
import assert from 'node:assert/strict';
import { openOffice, checker } from './v12_pets_page.mjs';

const T = checker();
const o = await openOffice('test_v12_headphones', {});
try {
  await T.check('headphones: every hair x headwear x view, standing and dozing', async () => {
    const r = await o.page.evaluate(() => {
      if (!window.VOLifeMoods || typeof VOLifeMoods.headphones !== 'function') return { missing: true };
      const CX = 40, CY = 80;
      const shot = (app, extra, phones) => {
        const c = document.createElement('canvas'); c.width = 80; c.height = 100;
        const a = new Agent({ id: 'hp', statusKey: 'hp', name: 'H', emoji: '', role: '', color: '#1e88e5', gender: 'M',
          appearance: Object.assign({ skinTone: '#e8b88a', hairStyle: 'short', hairColor: '#6d4c41' }, app), _autoDesk: { x: 0, y: 0 } });
        a.x = a.targetX = CX; a.y = a.targetY = CY; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle';
        a.blinkTimer = 0; a.tick = 0; a._lifeExtra = true; Object.assign(a, extra);
        if (phones) a._lifeDecorate = (g, ch) => VOLifeMoods.headphones(g, ch);
        const saved = window.ctx; window.ctx = c.getContext('2d');
        try { a.draw(); } finally { window.ctx = saved; }
        return c.getContext('2d').getImageData(0, 0, 80, 100).data;
      };
      const op = (d, x, y) => d[(y * 80 + x) * 4 + 3] > 0;
      const HATS = [null].concat(HEADWEAR_STYLES.map(h => h.id)), noPhones = {};
      HEADWEAR_STYLES.forEach(h => { if (h.phones === false) noPhones[h.id] = 1; });
      const bad = [], seen = { cases: 0, drawn: 0, hidden: 0 };
      const one = (label, app, extra, hidden) => {
        seen.cases++;
        const A = shot(app, extra, false), B = shot(app, extra, true);
        let yb = 999; const cols = new Set();
        for (let y = 0; y < 100; y++) for (let x = 0; x < 80; x++) {
          const i = (y * 80 + x) * 4;
          if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2] || A[i + 3] !== B[i + 3]) { if (y < yb) { yb = y; cols.clear(); } if (y === yb) cols.add(x); }
        }
        if (hidden) { seen.hidden++; if (yb !== 999) bad.push(label + ': drawn although hidden'); return; }
        if (yb === 999) { bad.push(label + ': not drawn'); return; }
        seen.drawn++;
        let above = 999, headTop = 999;
        cols.forEach(x => { for (let y = 0; y < 100; y++) if (op(A, x, y)) { above = Math.min(above, y); break; } });
        // the head columns (a dozing head has pixel Zs drifting up at x 13 and beyond)
        for (let x = CX - 12; x <= CX + 12; x++) for (let y = 0; y < 100; y++) if (op(A, x, y)) { headTop = Math.min(headTop, y); break; }
        if (above < yb + 2) bad.push(label + ': pokes through the band (head pixel at ' + (above - CY) + ', band ' + (yb - CY) + ')');
        else if (headTop !== yb + 2) bad.push(label + ': band not on the head (top ' + (headTop - CY) + ', band ' + (yb - CY) + ')');
      };
      for (const h of HAIR_STYLE_TABLE) for (const hat of HATS) for (const v of ['down', 'up', 'left', 'right']) for (const doze of [false, true]) {
        const app = { hairStyle: h.id }; if (hat) app.headwear = hat;
        one([h.id, hat || '-', v, doze ? 'dozing' : 'standing'].join(' '), app, Object.assign({ _forceView: v }, doze ? { _lifePose: 'snooze' } : {}), !!(hat && noPhones[hat]));
      }
      const costumes = ((typeof BODY_LOOKS !== 'undefined' && BODY_LOOKS.costumes) || []).map(c => c.id).filter(id => id && id !== 'none');
      for (const c of costumes) for (const v of ['down', 'up', 'left', 'right']) one('costume ' + c + ' ' + v, { costume: c }, { _forceView: v }, true);
      const show = bad.filter(b => !/dozing/.test(b)).concat(bad.filter(b => /dozing/.test(b)));
      return { seen, costumes: costumes.length, bad: show.slice(0, 10), nBad: bad.length, nStand: bad.filter(b => !/dozing/.test(b)).length };
    });
    assert.ok(!r.missing, 'VOLifeMoods.headphones (the art) is not exported');
    console.log(`  ${r.seen.cases} cases: ${r.seen.drawn} with headphones, ${r.seen.hidden} hidden (hats with phones: false, ${r.costumes} costumes)`);
    assert.equal(r.nBad, 0, r.nBad + ' bad (' + r.nStand + ' standing), e.g. ' + r.bad.join(' | '));
  });
  await T.check('no page errors', async () => assert.deepEqual(o.errors, []));
} finally {
  await o.close();
}
console.log(T.failures ? `FAIL ${T.failures}` : 'PASS');
process.exit(T.failures ? 1 : 0);
