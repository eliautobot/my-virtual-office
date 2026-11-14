// v0.12 hair: one hair table, 21 styles drawn with shading in every view,
// hair under headwear, a 1 px walking sway, grouped Studio tiles.
//
// Hermetic: app/ from this tree, fixture APIs (test_v10_studio_lib.mjs).
// Every drawing check goes through the real Agent.draw via the Studio preview.
// Run: node tests/test_v12_hair.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openStudio, showStudio } from './test_v10_studio_lib.mjs';

const NAME = 'test_v12_hair';
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await launch(NAME);
const passed = [];
function pass(name) { passed.push(name); console.log(`[PASS] ${name}`); }

const OLD11 = ['bald', 'buzz', 'short', 'medium', 'long', 'curly', 'wavy', 'spiky', 'bun', 'ponytail', 'mohawk'];
const NEW10 = ['fade', 'afro', 'bob', 'braids', 'locs', 'sidepart', 'pigtails', 'pixie', 'slickback', 'curtains'];

try {
  const { page, errors } = await openStudio(browser);

  // 1. One table: 21 unique ids, the old 11 kept, the 10 new ones added; the
  // Studio list is the table; the hash-picked defaults (game.js and server.py)
  // are the same unchanged list and a subset of the table.
  const t = await page.evaluate(() => ({
    ids: (window.HAIR_STYLE_TABLE || []).map(h => h.id),
    groups: (window.HAIR_STYLE_TABLE || []).map(h => h.group),
    studio: window.VOStudio && VOStudio.catalog ? VOStudio.catalog.hairStyles : null,
    gameDefaults: (String(window.getDefaultAppearance || '').match(/_hairStyles = \[([^\]]*)\]/) || [])[1] || ''
  }));
  assert.equal(t.ids.length, 21, 'the hair table has 21 styles');
  assert.equal(new Set(t.ids).size, 21, 'hair ids are unique');
  for (const id of OLD11.concat(NEW10)) assert.ok(t.ids.includes(id), `hair table has ${id}`);
  assert.deepEqual(t.studio, t.ids, 'Agent Studio uses the hair table');
  const known = new Set(t.groups);
  assert.ok(known.size >= 2 && t.groups.every(Boolean), 'every style has a Studio group');
  const DEF = ['short', 'medium', 'long', 'curly', 'spiky', 'buzz', 'wavy'];
  assert.deepEqual(t.gameDefaults.split(',').map(s => s.trim().replace(/'/g, '')), DEF, 'game.js default hair list unchanged');
  const py = fs.readFileSync(path.join(here, '..', 'app', 'server.py'), 'utf8');
  const pyList = (py.match(/hair_styles = \[([^\]]*)\]/) || [])[1] || '';
  assert.deepEqual(pyList.split(',').map(s => s.trim().replace(/'/g, '')), DEF, 'server.py default hair list unchanged');
  for (const id of DEF) assert.ok(t.ids.includes(id), `default ${id} is in the table`);
  pass('one hair table: 21 styles, Studio reads it, default lists unchanged and covered');

  // Drawing probe: the real Agent.draw through the Studio preview at 1 art px
  // per canvas px. The hair mask is every pixel that differs from the same look
  // drawn bald (eyebrows excluded: their colour follows the hair).
  await page.evaluate(() => {
    const V = { x: -24, y: -56, w: 48, h: 48 };
    window.__hairShot = function (look, facing, extra) {
      const c = document.createElement('canvas');
      VOOffice.renderAgentPreview(c, look, Object.assign({ view: V, scale: 1, dpr: 1, width: V.w, height: V.h,
        facing, pose: 'stand', floor: false, time: 0, color: '#1e88e5', gender: 'M' }, extra || {}));
      return c.getContext('2d').getImageData(0, 0, V.w, V.h).data;
    };
    // only (optional): count only pixels in these colours (the style's own tones), see part 3.
    window.__hairMask = function (look, facing, extra, only) {
      const a = __hairShot(look, facing, extra);
      const b = __hairShot(Object.assign({}, look, { hairStyle: 'bald' }), facing, extra);
      const side = facing === 'left' || facing === 'right';
      let mask = '', count = 0; const colors = new Set();
      for (let i = 0; i < V.w * V.h; i++) {
        const x = (i % V.w) + V.x, y = Math.floor(i / V.w) + V.y, k = i * 4;
        const brow = facing === 'down' ? (x >= -9 && x <= 9 && y >= -36 && y <= -33)
          : side ? (Math.abs(x) >= 3 && Math.abs(x) <= 9 && y >= -35 && y <= -33) : false;
        const on = !brow && (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2] || a[k + 3] !== b[k + 3]) &&
          (!only || only.includes((a[k] << 16) | (a[k + 1] << 8) | a[k + 2]));
        mask += on ? '1' : '0';
        if (on) { count++; colors.add((a[k] << 16) | (a[k + 1] << 8) | a[k + 2]); }
      }
      return { mask, count, colors: colors.size, rgb: Array.from(colors) };
    };
  });
  const LOOK = { skinTone: '#f5d0b0', hairColor: '#5d4037', hairHighlight: null, eyebrowStyle: 'thin', eyeColor: '#212121' };
  const VIEWS4 = ['down', 'left', 'right', 'up'];
  const masks = {};
  for (const id of OLD11.slice(1).concat(NEW10)) {
    masks[id] = {};
    for (const f of VIEWS4) masks[id][f] = await page.evaluate(([l, f]) => __hairMask(l, f), [{ ...LOOK, hairStyle: id }, f]);
  }
  const diff = (p, q) => { let n = 0; for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) n++; return n; };

  // 2a. The 11 styles: drawn in every view with base, highlight and shadow
  // (3+ colours, no highlight colour picked), and every pair tells apart from
  // the back and from each side (20+ pixels of silhouette or texture differ).
  const flat = [];
  for (const id of OLD11.slice(1)) for (const f of VIEWS4) {
    assert.ok(masks[id][f].count > 20, `${id} ${f}: hair is drawn`);
    if (masks[id][f].colors < 3) flat.push(`${id}/${f}:${masks[id][f].colors}`);
  }
  assert.deepEqual(flat, [], 'every style and view has 3 tones (style/view:colours)');
  const alike = [];
  const ids = OLD11.slice(1);
  for (const f of ['up', 'left', 'right']) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const d = diff(masks[ids[i]][f].mask, masks[ids[j]][f].mask);
    if (d < 20) alike.push(`${ids[i]}~${ids[j]}/${f}:${d}`);
  }
  assert.deepEqual(alike, [], 'styles tell apart from the back and the sides');
  // Buzz from the back is stubble (hair over skin), not a solid cap.
  const hairRgb = 0x5d4037, skinRgb = 0xf5d0b0;
  const between = rgb => [16, 8, 0].every(sh => { const v = (rgb >> sh) & 255, h = (hairRgb >> sh) & 255, s = (skinRgb >> sh) & 255; return v > Math.min(h, s) && v < Math.max(h, s); });
  const buzz = masks.buzz.up;
  const shot = await page.evaluate(([l]) => Array.from(__hairShot(l, 'up')), [{ ...LOOK, hairStyle: 'buzz' }]);
  let stub = 0;
  for (let i = 0; i < buzz.mask.length; i++) if (buzz.mask[i] === '1') { const k = i * 4; if (between((shot[k] << 16) | (shot[k + 1] << 8) | shot[k + 2])) stub++; }
  assert.ok(stub >= buzz.count * 0.4, `buzz back is mostly stubble (${stub}/${buzz.count})`);
  pass('11 styles: 3 tones in all four views, every pair tells apart from back and sides, buzz back is stubble');

  // 2b. The 10 new styles: drawn in every view with 3 tones, and all 20
  // haired styles tell apart from each other in all four views.
  const flat2 = [], alike2 = [], all20 = OLD11.slice(1).concat(NEW10);
  for (const id of NEW10) for (const f of VIEWS4) {
    if (!(masks[id][f].count > 20)) flat2.push(`${id}/${f}:none`);
    else if (masks[id][f].colors < 3) flat2.push(`${id}/${f}:${masks[id][f].colors}`);
  }
  assert.deepEqual(flat2, [], 'new styles drawn with 3 tones in every view');
  for (const f of VIEWS4) for (let i = 0; i < all20.length; i++) for (let j = i + 1; j < all20.length; j++) {
    const d = diff(masks[all20[i]][f].mask, masks[all20[j]][f].mask);
    if (d < 20) alike2.push(`${all20[i]}~${all20[j]}/${f}:${d}`);
  }
  assert.deepEqual(alike2, [], 'all 20 haired styles tell apart in every view');
  pass('10 new styles: 3 tones in all four views; all 21 styles tell apart in every view');

  // 2c. Profiles (left, right, walking left): the mohawk is a crest, not a lump. In the right-facing frame, per
  // column of the bare head (bald shot), h = rows of hair above the head's top. A crest: h >= 6 over 70%+ of the
  // head's columns, reaching its front 30% and its back 30%; a ragged top (3+ tips: a run of columns whose top
  // stands above both neighbours and 2+ rows above a column within 2 on each side, h >= 6 there); shaved sides
  // (back half of the head, 2..6 rows under its top: at most 30% solid hair, the rest stubble or skin); on the
  // head (hair in at most 4 columns behind it). The bun (a ball behind a flat crown) does not span the head; the
  // afro (a round mass) reaches far behind it, with no tips.
  await page.evaluate(() => {
    window.__hairProfile = function (look, facing, extra) {
      const V = { x: -24, y: -56, w: 48, h: 48 }, a = __hairShot(look, facing, extra);
      const b = __hairShot(Object.assign({}, look, { hairStyle: 'bald' }), facing, extra);
      // solid hair: nearer to the base, highlight or shadow tone than to the stubble tone or the skin (a walking
      // frame draws the head at a half pixel, so its rows blend)
      const tn = _hairTones(look.hairColor, null, look.skinTone).slice(), g1 = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const rgb = (c) => { g1.clearRect(0, 0, 1, 1); g1.fillStyle = c; g1.fillRect(0, 0, 1, 1); return Array.from(g1.getImageData(0, 0, 1, 1).data.slice(0, 3)); };
      const solidT = tn.slice(0, 3).map(rgb), bareT = [rgb(tn[3]), rgb(look.skinTone)];
      const near = (i, set) => Math.min(...set.map((c) => Math.abs(a[i] - c[0]) + Math.abs(a[i + 1] - c[1]) + Math.abs(a[i + 2] - c[2])));
      const k = (x, y) => ((y - V.y) * V.w + ((facing === 'left' ? -1 - x : x) - V.x)) * 4;   // frame -> canvas
      const hair = (x, y) => { const i = k(x, y); return a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]; };
      const skull = {}, T = {}, H = {};
      let s0 = Infinity, s1 = -Infinity, top = Infinity;
      for (let x = -20; x < 20; x++) for (let y = -56; y <= -28; y++) if (b[k(x, y) + 3] > 0) {
        skull[x] = y; s0 = Math.min(s0, x); s1 = Math.max(s1, x); top = Math.min(top, y); break;
      }
      for (let x = s0; x <= s1; x++) {
        let t = skull[x];
        if (t !== undefined) for (let y = -56; y < skull[x]; y++) if (hair(x, y)) { t = y; break; }
        T[x] = t === undefined ? -28 : t; H[x] = t === undefined ? 0 : skull[x] - t;
      }
      const W = s1 - s0 + 1, crest = Object.keys(H).map(Number).filter((x) => H[x] >= 6);
      const span = crest.length / W, front = crest.some((x) => x >= s1 - 0.3 * W), back = crest.some((x) => x <= s0 + 0.3 * W);
      let tips = 0;
      for (let i = s0 + 2; i <= s1 - 2; i++) {
        let j = i; while (j < s1 - 2 && T[j + 1] === T[i]) j++;
        const t = T[i], L1 = T[i - 1], L2 = T[i - 2], R1 = T[j + 1], R2 = T[j + 2];
        if (H[i] >= 6 && L1 > t && R1 > t && Math.max(L1, L2) >= t + 2 && Math.max(R1, R2) >= t + 2) tips++;
        i = j;
      }
      let solid = 0, n = 0;
      for (let x = s0 + 1; x <= s0 + Math.floor(W / 2); x++) for (let y = top + 2; y <= top + 6; y++) {
        const i = k(x, y); if (b[i + 3] === 0) continue; n++;
        if (hair(x, y) && near(i, solidT) < near(i, bareT)) solid++;
      }
      let behind = 0;                                   // columns of hair behind the head (a mass around it)
      for (let x = s0 - 1; x >= -20; x--) { let any = false; for (let y = -56; y <= top + 6; y++) if (hair(x, y)) { any = true; break; } if (any) behind++; }
      return { span: +span.toFixed(2), front, back, tips, solid: +(solid / Math.max(1, n)).toFixed(2), behind, maxH: Math.max(...Object.values(H)), head: `${s0}..${s1}@${top}` };
    };
  });
  const crestOf = (p) => p.span >= 0.7 && p.front && p.back && p.tips >= 3 && p.solid <= 0.3 && p.behind <= 4;
  const PROFILES = [['left', null], ['right', null], ['walking left', { pose: 'walk', time: 240 }]];
  const prof = {}, wrong = [];
  for (const id of ['mohawk', 'bun', 'afro']) for (const [lab, extra] of PROFILES) {
    const p = await page.evaluate(([l, f, e]) => __hairProfile(l, f, e), [{ ...LOOK, hairStyle: id }, lab === 'right' ? 'right' : 'left', extra]);
    prof[`${id}/${lab}`] = p;
    if (id === 'mohawk' && !crestOf(p)) wrong.push(`mohawk/${lab} is not a crest ${JSON.stringify(p)}`);
    if (id !== 'mohawk' && crestOf(p)) wrong.push(`${id}/${lab} reads as a crest ${JSON.stringify(p)}`);
    if (id === 'bun' && (p.span >= 0.7 && p.front)) wrong.push(`bun/${lab} spans the head ${JSON.stringify(p)}`);
    if (id === 'afro' && p.behind <= 4) wrong.push(`afro/${lab} is not a mass around the head ${JSON.stringify(p)}`);
  }
  if (process.env.HAIR_PROFILES) for (const key in prof) console.log(key, JSON.stringify(prof[key]));
  assert.deepEqual(wrong, [], 'side views: the mohawk is a crest from the forehead to the back, the bun and the afro are not');
  const m = prof['mohawk/right'], bu = prof['bun/right'], af = prof['afro/right'];
  pass(`profiles: mohawk a crest in left, right, walking left (span ${m.span}, ${m.tips} tips, sides ${m.solid} solid); ` +
    `not the bun (span ${bu.span}, ${bu.tips} tips) or the afro (${af.behind} columns behind the head, ${af.tips} tips)`);

  // 3. Hair and headwear: under a hat that covers the crown no hair shows above
  // the hat line (none poking through a hard hat, cap, beanie; tall styles sit
  // under a crown), in every view; hair below the hat still shows.
  const HATS = { hardhat: -42, cap: -40, beanie: -43, crown: -45 };
  const poke = [];
  let longUnderCap = 0;
  for (const [hat, cut] of Object.entries(HATS)) for (const id of all20) for (const f of VIEWS4) {
    // hair = the style's own colours: headwear rests on the hair (v0.12 polish), so a crown sits 1 px lower on a
    // bald head than on a buzz cut and its own pixels differ from the bald comparison.
    const m = await page.evaluate(([l, f, rgb]) => __hairMask(l, f, null, rgb), [{ ...LOOK, hairStyle: id, headwear: hat, headwearColor: '#e53935' }, f, masks[id][f].rgb]);
    let above = 0;
    for (let i = 0; i < m.mask.length; i++) if (m.mask[i] === '1' && Math.floor(i / 48) - 56 < cut) above++;
    if (above) poke.push(`${id}/${hat}/${f}:${above}`);
    if (id === 'long' && hat === 'cap' && f === 'up') longUnderCap = m.count;
  }
  assert.deepEqual(poke, [], 'no hair above the hat line (style/hat/view:pixels)');
  assert.ok(longUnderCap > 150, `long hair still falls below a cap (${longUnderCap} px)`);
  const tops = await page.evaluate(() => ({ short: _hairTopY('short'), afro: _hairTopY('afro'), mohawkSide: _hairTopY('mohawk', 'side'), bald: _hairTopY('bald') }));
  assert.deepEqual(tops, { short: -42, afro: -50, mohawkSide: -50, bald: -38 }, 'hair top per style for gear that sits on the hair');
  pass('hair under headwear: nothing above a hard hat, cap, beanie or crown in 4 views; long hair shows below; hair top helper');

  // 4. Walking sway: 1 px, long styles only, only the hair below the ears,
  // none standing, none under reduced motion or Office Life Calm mode.
  const sw = await page.evaluate(() => {
    const app = { skinTone: '#f5d0b0', hairColor: '#5d4037' };
    const vals = new Set();
    for (let t = 0; t < 64; t++) vals.add(_hairPoseFor({ tick: t }, app, true).sway);
    const still = _hairPoseFor({ tick: 5 }, app, false).sway;
    const draw = (style, view, sway) => {
      const c = document.createElement('canvas'); c.width = 48; c.height = 64;
      const g = c.getContext('2d'); g.translate(24, 56);
      _hairPose = sway == null ? null : { sway, hat: null, skin: '#f5d0b0' };
      try { _drawHairArt(g, style, view, 1, '#5d4037', null); } finally { _hairPose = null; }
      return g.getImageData(0, 0, 48, 64).data;
    };
    const rows = (a, b) => { const r = new Set(); for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 3] !== b[i + 3]) r.add(Math.floor(i / 4 / 48) - 56); return Array.from(r); };
    const res = {};
    for (const st of ['long', 'wavy', 'ponytail', 'pigtails', 'braids', 'locs', 'short', 'bob', 'afro']) {
      const r = [];
      for (const v of ['front', 'back', 'side']) r.push(...rows(draw(st, v, 0), draw(st, v, 1)));
      res[st] = { n: r.length, minY: r.length ? Math.min(...r) : null };
    }
    // one px: the shifted long hair equals the still hair moved by 1 px
    const a = draw('long', 'back', 0), b = draw('long', 'back', 1);
    let off = 0;
    for (let y = 26; y < 64; y++) for (let x = 1; x < 48; x++) { const i = (y * 48 + x) * 4, j = (y * 48 + x - 1) * 4; if (b[i + 3] !== a[j + 3]) off++; }
    return { vals: Array.from(vals).sort(), still, res, off };
  });
  assert.deepEqual(sw.vals, [-1, 0, 1], 'walking sway is -1, 0 or +1 px');
  assert.equal(sw.still, 0, 'no sway standing');
  for (const st of ['long', 'wavy', 'ponytail', 'pigtails', 'braids', 'locs']) {
    assert.ok(sw.res[st].n > 0 && sw.res[st].minY >= -30, `${st} sways below the ears only (${JSON.stringify(sw.res[st])})`);
  }
  for (const st of ['short', 'bob', 'afro']) assert.equal(sw.res[st].n, 0, `${st} does not sway`);
  assert.equal(sw.off, 0, 'the swayed hair is the same hair moved 1 px');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const rm = await page.evaluate(() => { const s = new Set(); for (let t = 0; t < 64; t++) s.add(_hairPoseFor({ tick: t }, {}, true).sway); return Array.from(s); });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.deepEqual(rm, [0], 'no sway under prefers-reduced-motion');
  const calm = await page.evaluate(() => {
    if (!window.VOLife) return 'no VOLife';
    const old = VOLife.calm; VOLife.calm = () => true;
    try { const s = new Set(); for (let t = 0; t < 64; t++) s.add(_hairPoseFor({ tick: t }, {}, true).sway); return Array.from(s); } finally { VOLife.calm = old; }
  });
  assert.deepEqual(calm, [0], 'no sway in Office Life Calm mode');
  // Through Agent.draw: a walking preview hands the sway to the hair art, a
  // standing one does not, and the pose is cleared after the head.
  const live = await page.evaluate(() => {
    const orig = window._drawHairArt, seen = { walk: new Set(), stand: new Set() };
    let mode = 'walk';
    window._drawHairArt = function () { seen[mode].add(_hairPose ? _hairPose.sway : 'none'); return orig.apply(this, arguments); };
    try {
      const look = { skinTone: '#f5d0b0', hairColor: '#5d4037', hairStyle: 'long' };
      for (let t = 0; t < 1200; t += 50) VOOffice.renderAgentPreview(document.createElement('canvas'), look, { pose: 'walk', facing: 'up', time: t, scale: 1, dpr: 1 });
      mode = 'stand';
      for (let t = 0; t < 1200; t += 50) VOOffice.renderAgentPreview(document.createElement('canvas'), look, { pose: 'stand', facing: 'up', time: t, scale: 1, dpr: 1 });
    } finally { window._drawHairArt = orig; }
    return { walk: Array.from(seen.walk).sort(), stand: Array.from(seen.stand), after: _hairPose };
  });
  assert.deepEqual(live.walk, [-1, 0, 1], 'a walking agent sways its hair');
  assert.deepEqual(live.stand, [0], 'a standing agent does not');
  assert.equal(live.after, null, 'the hair pose is cleared after the head');
  pass('walking sway: 1 px on long styles below the ears, none standing, short styles, reduced motion or Calm; live in Agent.draw');

  // 5. Studio: 21 picture tiles drawn by the office code, in three labelled
  // groups of one radiogroup, fitting a desktop and a 412 px phone; Randomize
  // uses every style.
  const layout = async (pg) => {
    await showStudio(pg, 'alpha');
    await pg.evaluate(() => { VOStudio.showCategory('hair'); VOStudio.refreshNow(); });
    return pg.evaluate(() => {
      const g = document.querySelector('.st-tiles[data-group="hairStyle"]');
      const gr = g.getBoundingClientRect();
      // 0.12.0 gender: the list offers this agent's gender its styles and the shared ones (others are hidden)
      const all = Array.from(g.querySelectorAll('.st-tile'));
      const tiles = all.filter(t => !t.hidden);
      const field = g.closest('.st-field') || g.parentElement;
      const pics = new Set(tiles.map(t => t.querySelector('canvas').toDataURL()));
      return {
        role: g.getAttribute('role'), n: all.length, nVis: tiles.length, values: all.map(t => t.dataset.value),
        offered: all.filter(t => lookAllowed('hairStyle', t.dataset.value, _agentPanelEditState.gender)).length,
        heads: Array.from(g.querySelectorAll('.st-tile-group')).map(h => h.textContent),
        labels: tiles.map(t => t.querySelector('.st-tile-label').textContent),
        cols: tiles.filter(t => t.offsetTop === tiles[0].offsetTop).length,
        clipped: tiles.filter(t => { const l = t.querySelector('.st-tile-label'); return l.scrollWidth > l.clientWidth; }).length,
        out: tiles.filter(t => { const b = t.getBoundingClientRect(); return b.left < gr.left - 0.5 || b.right > gr.right + 0.5; }).length,
        fieldH: field.getBoundingClientRect().height, vh: innerHeight, panelH: (g.closest('.st-panel') || document.body).clientHeight, scrollW: document.documentElement.scrollWidth,
        tileH: tiles[0].getBoundingClientRect().height, pics: pics.size, tileCanvasW: tiles[0].querySelector('canvas').getBoundingClientRect().width
      };
    });
  };
  const desk = await layout(page);
  assert.equal(desk.role, 'radiogroup');
  assert.deepEqual(desk.values, t.ids, 'tiles in table order');
  assert.deepEqual(desk.heads, ['Short', 'Medium', 'Long and tied'], 'three group headings');
  assert.ok(desk.labels.includes('Side part') && desk.labels.includes('Slick back'), 'labels from the table');
  assert.equal(desk.nVis, desk.offered, 'the tiles shown are the ones offered to the gender');
  assert.equal(desk.pics, desk.nVis, `${desk.nVis} different pictures`);
  assert.ok(desk.clipped === 0 && desk.out === 0, `desktop: no clipped label or tile (${desk.clipped}/${desk.out})`);
  assert.ok(desk.cols >= 6 && desk.fieldH <= desk.panelH, `desktop: 6+ a row, all 21 inside the visible panel (${desk.cols}, ${desk.fieldH}/${desk.panelH})`);
  assert.ok(desk.tileCanvasW >= 72, 'desktop: the head picture keeps its whole 2x size');
  const ph = await openStudio(browser, { phone: true });
  const phone = await layout(ph.page);
  assert.equal(phone.n, 21);
  assert.equal(phone.cols, 5, 'phone: 5 hair tiles a row');
  assert.ok(phone.clipped === 0 && phone.out === 0 && phone.scrollW <= 412, `phone: nothing clipped or sideways (${JSON.stringify(phone)})`);
  assert.ok(phone.fieldH < phone.vh * 0.75, `phone: all 21 fit in one screen (${phone.fieldH}/${phone.vh})`);
  assert.ok(phone.tileH >= 44, 'phone: touch-sized tiles');
  assert.deepEqual(ph.errors, []);
  await ph.context.close();
  const rolled = await page.evaluate(() => {
    const real = Math.random; let seed = 12345;
    Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    VOStudio.state.locks = {};
    const seen = new Set();
    try {
      for (const g of ['M', 'F']) {   // 0.12.0: Randomize keeps the gender; the two genders together reach every style
        VOStudio.switchGender(_agentPanelEditState, g);
        for (let i = 0; i < 600; i++) { VOStudio.randomize(); seen.add(_agentPanelEditState.appearance.hairStyle); }
      }
    } finally { Math.random = real; }
    return Array.from(seen).sort();
  });
  assert.deepEqual(rolled, t.ids.slice().sort(), 'Randomize (Male and Female) reaches all 21 styles');
  pass('Studio: 21 drawn tiles in 3 groups, fit desktop (6 a row) and phone (5 a row, one screen); Randomize uses all 21');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\n${NAME}: ${passed.length} passed`);
} finally {
  await browser.close();
}
