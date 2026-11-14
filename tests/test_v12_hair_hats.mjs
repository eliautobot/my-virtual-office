#!/usr/bin/env node
// v0.12 polish: hair with every headwear in every view (every HAIR_STYLE_TABLE style x every HEADWEAR_STYLES id x
// front, back, left, right; standing, and seated at a desk seen from behind). Each case is drawn through Agent.draw
// and compared with the same agent bald and/or bareheaded, so the hat's pixels and the hair's pixels are known:
//   through (hats that cover the crown): a hair pixel in one of the hat's columns above the hat's lowest pixel there, or above the hat's top
//            (hair showing through, around or over the hat);
//   gap:     right under the hat, a column that has hair without the hat shows bare head with it (a bald band
//            between the hat and the hair);
//   float:   in the head's two middle columns nothing at all right under the hat (the hat hangs in the air);
//   hole:    without a hat, a see-through pixel between the hair and the head in one of the head's columns.
// Fails on the base commit of v12/polish where it finds faults. Run: node tests/test_v12_hair_hats.mjs
import assert from 'node:assert/strict';
import { openOffice, checker } from './v12_pets_page.mjs';

const T = checker();
const o = await openOffice('test_v12_hair_hats', {});
try {
  const r = await o.page.evaluate(() => {
    const CX = 40, CY = 80, Wd = 80, Hd = 100;
    const shot = (app, extra) => {
      const c = document.createElement('canvas'); c.width = Wd; c.height = Hd;
      const a = new Agent({ id: 'hh', statusKey: 'hh', name: 'H', emoji: '', role: '', color: '#1e88e5', gender: 'M',
        appearance: Object.assign({ skinTone: '#e8b88a', hairColor: '#6d4c41' }, app), _autoDesk: { x: 0, y: 0 } });
      a.x = a.targetX = CX; a.y = a.targetY = CY; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle';
      a.blinkTimer = 0; a.tick = 0; a._lifeExtra = true; Object.assign(a, extra);
      const saved = window.ctx; window.ctx = c.getContext('2d');
      try { a.draw(); } finally { window.ctx = saved; }
      return c.getContext('2d').getImageData(0, 0, Wd, Hd).data;
    };
    const same = (P, Q, x, y) => { const i = (y * Wd + x) * 4; return P[i] === Q[i] && P[i + 1] === Q[i + 1] && P[i + 2] === Q[i + 2] && P[i + 3] === Q[i + 3]; };
    const op = (P, x, y) => P[(y * Wd + x) * 4 + 3] > 0;
    const POSES = { standing: {}, seated: { isSitting: true, state: 'working' } };
    const cache = {}, covers = {};
    HEADWEAR_STYLES.forEach(h => { if (h.covers) covers[h.id] = 1; });
    const get = (k, app, extra) => cache[k] || (cache[k] = shot(app, extra));
    const out = { cases: 0, through: [], gap: [], float: [], hole: [] };
    // Bare head first: in every column the hair must reach the head (no see-through row between them).
    for (const v of ['down', 'up', 'left', 'right']) {
      const bald0 = get('standing' + v + 'b-', { hairStyle: 'bald' }, { _forceView: v });
      for (const h of HAIR_STYLE_TABLE) {
        if (h.id === 'bald') continue;
        const X0 = get('standing' + v + h.id + '-', { hairStyle: h.id }, { _forceView: v });
        for (let x = CX - 12; x <= CX + 12; x++) {
          let hb = -1, hx = -1;
          for (let y = 0; y < Hd; y++) if (op(bald0, x, y)) { hb = y; break; }
          for (let y = 0; y < Hd; y++) if (op(X0, x, y)) { hx = y; break; }
          if (hb < 0 || hb > CY - 30 || hx < 0 || hx >= hb) continue;  // the skull's columns only (head rows -38..-30)
          let y = hx; while (y < hb && op(X0, x, y)) y++;
          let e = y; while (e < hb && !op(X0, x, e)) e++;
          // a see-through gap right on the skull, or a 1 px slit inside the hair (a bun's round edge is not one)
          if (y < hb && (e === hb || e - y === 1)) { out.hole.push([h.id, '-', v].join(' ') + ' @' + (x - CX) + ',' + (y - CY)); break; }
        }
      }
    }
    for (const [pose, px] of Object.entries(POSES)) for (const v of ['down', 'up', 'left', 'right']) {
      if (pose === 'seated' && v !== 'up') continue;  // at a desk the engine shows the back (turned desks: profiles above)
      const ex = Object.assign({ _forceView: v }, px);
      const bald0 = get(pose + v + 'b-', { hairStyle: 'bald' }, ex);
      for (const hat of HEADWEAR_STYLES.map(h => h.id)) {
        const baldH = get(pose + v + 'b' + hat, { hairStyle: 'bald', headwear: hat }, ex);
        const top = {}, bot = {}; let hatTop = 999;
        for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) if (!same(baldH, bald0, x, y)) {
          if (!(x in top)) top[x] = y; bot[x] = y; if (y < hatTop) hatTop = y;
        }
        if (hatTop === 999) continue;  // draws nothing in this view
        for (const h of HAIR_STYLE_TABLE) {
          const bald = h.id === 'bald';  // a bald head: only "float" applies
          out.cases++;
          const label = [h.id, hat, v, pose].join(' ');
          const X0 = bald ? bald0 : get(pose + v + h.id + '-', { hairStyle: h.id }, ex), XH = bald ? baldH : shot({ hairStyle: h.id, headwear: hat }, ex);
          let t = null, g = null;
          for (let y = 0; y < Hd && !t && !bald; y++) for (let x = 0; x < Wd; x++) {
            if (same(XH, baldH, x, y)) continue;                      // not hair
            if (covers[hat] && (y < hatTop || (x in bot && y < bot[x]))) { t = (x - CX) + ',' + (y - CY); break; }
          }
          for (const x of bald ? [] : Object.keys(bot).map(Number)) {
            const y = bot[x] + 1; if (y >= Hd) continue;
            if (!same(X0, bald0, x, y) && same(XH, baldH, x, y) && op(XH, x, y)) { g = (x - CX) + ',' + (y - CY); break; }
          }
          if (t) out.through.push(label + ' @' + t);
          if (g) out.gap.push(label + ' @' + g);
          // this case's own hat in the middle column (small headwear rests on the hair, so it can sit lower on a short cut)
          // (the two middle columns, as the rule: on a curly top it rests on the higher curl)
          let air = 0, at = 0;
          for (const x of [CX - 1, CX]) {
            let low = -1;
            for (let y = 0; y < Hd; y++) if (!same(XH, X0, x, y) && op(XH, x, y)) low = y;
            if (low >= 0 && low + 1 < Hd && !op(XH, x, low + 1)) { air++; at = low + 1 - CY; }
          }
          if (air === 2) out.float.push(label + ' @' + at);
        }
      }
    }
    const pack = l => { const by = {}; l.forEach(s => { const k = s.split(' ').slice(1, 3).join(' '); by[k] = (by[k] || 0) + 1; });
      return { n: l.length, e: l.slice(0, Number(window.__hhShow || 4)), by: Object.entries(by).map(([k, n]) => k + ':' + n).join(' ') }; };
    return { cases: out.cases, through: pack(out.through), gap: pack(out.gap), float: pack(out.float), hole: pack(out.hole) };
  });
  console.log(`  ${r.cases} hair x hat x view cases`);
  await T.check('bare head: the hair reaches the head in every column (no see-through row)', async () => assert.equal(r.hole.n, 0, r.hole.n + ' [' + r.hole.by + '] e.g. ' + r.hole.e.join(' | ')));
  await T.check('no hair through a hat', async () => assert.equal(r.through.n, 0, r.through.n + ' [' + r.through.by + '] e.g. ' + r.through.e.join(' | ')));
  await T.check('no bald band under a hat', async () => assert.equal(r.gap.n, 0, r.gap.n + ' [' + r.gap.by + '] e.g. ' + r.gap.e.join(' | ')));
  await T.check('no hat floating over the head', async () => assert.equal(r.float.n, 0, r.float.n + ' [' + r.float.by + '] e.g. ' + r.float.e.join(' | ')));
  await T.check('no page errors', async () => assert.deepEqual(o.errors, []));
} finally {
  await o.close();
}
console.log(T.failures ? `FAIL ${T.failures}` : 'PASS');
process.exit(T.failures ? 1 : 0);
