// v0.10 Agent Studio 2.0: stage (contract C4), picture tiles, keyboard and the
// look controls (CE-01, CE-03, CE-05, CE-06, CE-07, CE-08, CE-09, CE-12, CE-14,
// CE-15, CE-16, CE-17, CE-19, CE-20, CE-22, Randomize, Reset, presets, copy).
//
// Hermetic: app/ from this tree, fixture APIs, fake 200s for writes.
// Run: node tests/test_v10_studio_stage.mjs

import assert from 'node:assert/strict';
import { launch, openStudio, showStudio, sleep } from './test_v10_studio_lib.mjs';

const NAME = 'test_v10_studio_stage';
const browser = await launch(NAME);
const passed = [];
function pass(name) { passed.push(name); console.log(`[PASS] ${name}`); }

const stageHash = page => page.evaluate(() => { VOStudio.refreshNow(); return document.querySelector('.st-stage-canvas').toDataURL(); });
const cat = (page, id) => page.evaluate(c => VOStudio.showCategory(c), id);
const clickTile = (page, group, value) => clickSync(page, `.st-tiles[data-group="${group}"] .st-tile[data-value="${value}"]`);
// Click, then run the studio's frame refresh now (it normally waits for rAF).
async function clickSync(page, sel, opts) { await page.click(sel, opts); await page.evaluate(() => VOStudio.refreshNow()); }
const look = page => page.evaluate(() => JSON.parse(JSON.stringify(_agentPanelEditState)));

try {
  const { page, errors } = await openStudio(browser);
  await showStudio(page, 'alpha');
  // Freeze the loop so frames only change when the look changes.
  await page.evaluate(() => { VOStudio.state.playing = false; });

  // C4: the preview is drawn by Agent.prototype.draw and the office desk code.
  const c4 = await page.evaluate(() => {
    const calls = { draw: 0, desk: 0 };
    const draw = Agent.prototype.draw;
    const desk = window.drawFurnitureItem;
    Agent.prototype.draw = function () { if (this._studioPreview) calls.draw++; return draw.apply(this, arguments); };
    window.drawFurnitureItem = function (item) { if (item && item.type === 'desk') calls.desk++; return desk.apply(this, arguments); };
    try {
      const c = document.createElement('canvas');
      const r = VOOffice.renderAgentPreview(c, agents[0].getAppearance(), { pose: 'type', scale: 5, width: 400, height: 400, dpr: 1, color: '#1e88e5' });
      return { calls, r, ctxRestored: window.ctx === document.getElementById('officeCanvas').getContext('2d') };
    } finally { Agent.prototype.draw = draw; window.drawFurnitureItem = desk; }
  });
  assert.deepEqual(c4.calls, { draw: 1, desk: 1 });
  assert.equal(c4.r.deviceScale, 5);
  assert.equal(c4.ctxRestored, true, 'global ctx restored');
  pass('C4 renderAgentPreview draws with Agent.draw + the office desk and restores ctx');

  // CE-01: costume and desk item change the preview pixels.
  await cat(page, 'outfit');
  let before = await stageHash(page);
  await clickTile(page, 'costume', 'lobster');
  assert.notEqual(await stageHash(page), before, 'costume changes the preview');
  await clickTile(page, 'costume', 'none');
  await cat(page, 'items');
  await page.evaluate(() => VOStudio.setPose('stand'));
  before = await stageHash(page);
  await clickTile(page, 'deskItem', 'microscope');
  const afterDesk = await page.evaluate(() => VOStudio.state.pose);
  assert.equal(afterDesk, 'type', 'picking a desk item sits the stage down at the desk');
  const withMicro = await stageHash(page);
  assert.notEqual(withMicro, before);
  await clickTile(page, 'deskItem', 'shield');
  assert.notEqual(await stageHash(page), withMicro, 'desk item change is visible on the stage');
  pass('CE-01 costume and desk item show on the stage');

  // CE-05: big, whole-pixel stage.
  const crisp = await page.evaluate(() => {
    const cv = document.querySelector('.st-stage-canvas');
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    const r = VOOffice.renderAgentPreview(c, agents[0].getAppearance(), { pose: 'stand', scale: 4, width: 240, height: 280, dpr: 1, floor: false });
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blocks = 0, uniform = 0;
    for (let by = 0; by + 4 <= c.height; by += 4) for (let bx = 0; bx + 4 <= c.width; bx += 4) {
      const i0 = (by * c.width + bx) * 4;
      if (!d[i0 + 3]) continue;
      blocks++;
      let same = true;
      for (let y = 0; y < 4 && same; y++) for (let x = 0; x < 4; x++) {
        const i = ((by + y) * c.width + bx + x) * 4;
        if (d[i] !== d[i0] || d[i + 1] !== d[i0 + 1] || d[i + 2] !== d[i0 + 2] || d[i + 3] !== d[i0 + 3]) { same = false; break; }
      }
      if (same) uniform++;
    }
    return { scale: Number(document.querySelector('.st-stage').dataset.scale), w: cv.width, cssW: cv.clientWidth, dpr,
      rendering: getComputedStyle(cv).imageRendering, ratio: uniform / blocks, blocks };
  });
  assert.ok(crisp.scale >= 4, `stage scale ${crisp.scale}`);
  assert.equal(crisp.w, Math.round(crisp.cssW * crisp.dpr));
  assert.equal(crisp.rendering, 'pixelated');
  assert.ok(crisp.ratio > 0.9, `uniform 4x4 blocks ${crisp.ratio}`);
  pass('CE-05 stage at 4x+ whole pixels, DPR-sized, pixelated');

  // Q-07: the stage shows the office name tag pill under the figure (the Shirt row says it is the tag colour).
  const tag = await page.evaluate(() => {
    const look = agents[0].getAppearance();
    const draw = (opts) => { const c = document.createElement('canvas'); VOOffice.renderAgentPreview(c, look, Object.assign({ pose: 'stand', width: 389, height: 313, dpr: 1, color: '#e53935', floor: false }, opts)); return c; };
    const count = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, low = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] === 0xe5 && d[i + 1] === 0x39 && d[i + 2] === 0x35) { n++; if (((i / 4) / c.width | 0) > c.height * 0.8) low++; } return { n, low }; };
    const a = draw({ name: 'A', nameTag: true }), b = draw({ name: 'Somebody Long', nameTag: true }), none = draw({ name: 'A' });
    const studio = VOStudio.state.stageCanvas ? true : null;
    return { a: count(a), b: count(b), none: count(none), studio, differs: a.toDataURL() !== b.toDataURL() };
  });
  assert.ok(tag.differs, 'the name changes the preview (tag drawn)');
  assert.ok(tag.a.low > 50 && tag.none.low === 0, `a tag pill in the agent colour under the figure ${JSON.stringify(tag)}`);
  assert.ok(tag.b.n > tag.a.n, 'a longer name = a wider pill');
  pass('Q-07 the stage draws the office name tag pill under the figure');

  // CE-14: poses and a small loop.
  const poses = await page.evaluate(() => {
    const look = agents[0].getAppearance();
    const h = (opts) => { const c = document.createElement('canvas'); VOOffice.renderAgentPreview(c, look, Object.assign({ width: 160, height: 160, dpr: 1, scale: 2 }, opts)); return c.toDataURL(); };
    return {
      walkMoves: h({ pose: 'walk', time: 0 }) !== h({ pose: 'walk', time: 130 }),
      typeMoves: h({ pose: 'type', time: 0 }) !== h({ pose: 'type', time: 160 }), // a key tap every 150 ms (v0.10.1)
      sitDiffers: h({ pose: 'stand' }) !== h({ pose: 'type' }),
      buttons: Array.from(document.querySelectorAll('.st-poses .st-seg-btn')).map(b => b.textContent),
    };
  });
  assert.deepEqual(poses.buttons, ['Stand', 'Walk', 'Sit and type', 'Idle']);
  assert.ok(poses.walkMoves && poses.typeMoves && poses.sitDiffers, JSON.stringify(poses));
  await page.evaluate(() => { VOStudio.state.playing = true; VOStudio.setPose('walk'); });
  const f1 = await page.evaluate(() => document.querySelector('.st-stage-canvas').toDataURL());
  await sleep(350);
  const f2 = await page.evaluate(() => document.querySelector('.st-stage-canvas').toDataURL());
  assert.notEqual(f1, f2, 'the walk loop animates');
  await page.evaluate(() => { VOStudio.state.playing = false; VOStudio.setPose('stand'); });
  pass('CE-14 Stand / Walk / Sit and type / Idle with a running loop');

  // CE-06 + CE-20: picture tiles as radiogroups with arrow keys.
  await cat(page, 'hair');
  const tiles = await page.evaluate(() => {
    const g = document.querySelector('.st-tiles[data-group="hairStyle"]');
    const t = Array.from(g.querySelectorAll('.st-tile'));
    const painted = t.filter(x => !x.hidden).every(x => { const c = x.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
    return { role: g.getAttribute('role'), label: !!g.getAttribute('aria-labelledby'), n: t.length, painted,
      checked: t.filter(x => x.getAttribute('aria-checked') === 'true').map(x => x.dataset.value),
      tabbable: t.filter(x => x.tabIndex === 0).map(x => x.dataset.value), radios: t.every(x => x.getAttribute('role') === 'radio') };
  });
  // v0.12: 21 hair styles from game.js HAIR_STYLE_TABLE (was 11). 0.12.0: the shown ones (this gender's) are painted.
  assert.deepEqual(tiles, { role: 'radiogroup', label: true, n: 21, painted: true, checked: ['spiky'], tabbable: ['spiky'], radios: true });
  await page.focus('.st-tiles[data-group="hairStyle"] .st-tile[data-value="spiky"]');
  await page.keyboard.press('ArrowRight');
  let st = await look(page);
  assert.equal(st.appearance.hairStyle, 'mohawk'); // v0.12 table order: spiky, mohawk (was spiky, bun)
  await page.keyboard.press('Home');
  st = await look(page);
  assert.equal(st.appearance.hairStyle, 'bald');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'bald');
  assert.equal(await page.evaluate(() => agents.find(a => a.id === 'alpha').appearance.hairStyle), 'bald', 'live sprite follows');
  const stops = await page.evaluate(() => {
    const out = {};
    for (const c of ['looks', 'body', 'hair', 'face', 'outfit', 'hats', 'items']) {
      VOStudio.showCategory(c);
      out[c] = Array.from(document.querySelectorAll('#acp-editor button, #acp-editor input, #acp-editor select, #acp-editor [tabindex]'))
        .filter(n => !n.disabled && n.tabIndex >= 0 && n.offsetParent).length;
    }
    VOStudio.showCategory('hair');
    return out;
  });
  for (const [c, n] of Object.entries(stops)) assert.ok(n <= 30, `${c}: ${n} tab stops (v0.9 had 97)`);
  pass('CE-06 / CE-20 drawn tiles, radiogroup, roving tabindex, arrows select, <= 30 tab stops');

  // CE-03: a costume disables Headwear (kept, not wrongly highlighted as shown).
  await cat(page, 'outfit');
  await clickTile(page, 'costume', 'chicken');
  await cat(page, 'hats');
  let hats = await page.evaluate(() => {
    const g = document.querySelector('.st-tiles[data-group="headwear"]');
    return { disabled: g.getAttribute('aria-disabled'), tileDisabled: g.querySelector('.st-tile').getAttribute('aria-disabled'),
      takeOff: getComputedStyle(document.querySelector('.st-inline')).display !== 'none', hatColorHidden: document.querySelector('.st-swatches[data-group="headwearColor"]').closest('.st-field').hidden };
  });
  assert.deepEqual(hats, { disabled: 'true', tileDisabled: 'true', takeOff: true, hatColorHidden: true });
  await clickSync(page, '.st-tiles[data-group="headwear"] .st-tile[data-value="cap"]', { force: true });
  assert.equal((await look(page)).appearance.headwear, 'crown', 'a disabled tile changes nothing');
  assert.match(await page.evaluate(() => document.querySelector('.st-disabled-note').textContent), /Hidden by the chicken costume/);
  await clickSync(page, '.st-inline');
  hats = await page.evaluate(() => ({ costume: _agentPanelEditState.appearance.costume, disabled: document.querySelector('.st-tiles[data-group="headwear"]').getAttribute('aria-disabled'),
    checked: document.querySelector('.st-tiles[data-group="headwear"] [aria-checked="true"]').dataset.value }));
  assert.deepEqual(hats, { costume: null, disabled: 'false', checked: 'crown' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.st-inline')).display), 'none', 'no costume, no Take off button');
  pass('CE-03 costume disables Headwear with a reason and a way back');

  // CE-15: colour rows only for something that uses them.
  await clickTile(page, 'headwear', 'none');
  const ctx1 = await page.evaluate(() => ({
    hat: document.querySelector('[data-group="headwearColor"]').closest('.st-field').hidden,
    lens: document.querySelector('[data-group="glassesColor"]').closest('.st-field').hidden }));
  await clickTile(page, 'glasses', 'round');
  const ctx2 = await page.evaluate(() => document.querySelector('[data-group="glassesColor"]').closest('.st-field').hidden);
  await cat(page, 'face');
  const ctx3 = await page.evaluate(() => document.querySelector('[data-group="facialHairColor"]').closest('.st-field').hidden);
  await clickTile(page, 'facialHair', 'beard');
  const ctx4 = await page.evaluate(() => document.querySelector('[data-group="facialHairColor"]').closest('.st-field').hidden);
  assert.deepEqual([ctx1.hat, ctx1.lens, ctx2, ctx3, ctx4], [true, true, false, true, false]);
  pass('CE-15 hat, frame and facial hair colours appear only with the item');

  // CE-08 skin tones, CE-16 shirt/trousers/shoes.
  await cat(page, 'body');
  const skin = await page.evaluate(() => Array.from(document.querySelectorAll('[data-group="skinTone"] .st-sw[role="radio"]')).map(b => b.dataset.value));
  assert.ok(skin.length >= 18 && skin.includes('#2e1b12') && skin.includes('#4a2c1a') && skin.includes('#8d5524'), skin.join());
  await cat(page, 'outfit');
  const outfit = await page.evaluate(() => ({ shirts: document.querySelectorAll('[data-group="shirt"] .st-sw[role="radio"]').length,
    pants: document.querySelectorAll('[data-group="pantsColor"] .st-sw[role="radio"]').length,
    pantsDefault: document.querySelector('[data-group="pantsColor"] [aria-checked="true"]').dataset.value }));
  assert.ok(outfit.shirts >= 12 && outfit.pants >= 8, JSON.stringify(outfit));
  assert.equal(outfit.pantsDefault, '#1a1a2e');
  await clickSync(page, '[data-group="pantsColor"] .st-sw[data-value="#1565c0"]');
  await clickSync(page, '[data-group="shirt"] .st-sw[data-value="#8e24aa"]');
  st = await look(page);
  assert.equal(st.appearance.pantsColor, '#1565c0');
  assert.equal(st.color, '#8e24aa');
  pass('CE-08 / CE-16 12 skin tones incl. deep + fun, shirt and trouser swatches');

  // CE-09 (0.12.0 gender): a Male / Female toggle heads the look tabs; Female brings the Female face
  // defaults (lashes, lip colour) and offers the lash styles and lip colours (tests/test_rel_gender_looks.mjs).
  await cat(page, 'body');
  await clickSync(page, '.st-gender .st-seg-btn[data-value="F"]');
  st = await look(page);
  assert.equal(st.gender, 'F');
  assert.equal(st.appearance.lashes, true, 'Female brings lashes');
  assert.equal(st.appearance.lipColor, '#c4626a');
  await cat(page, 'face');
  await clickTile(page, 'lashes', 'long');
  await clickSync(page, '[data-group="lipColor"] .st-sw[data-value="#a1424a"]');
  st = await look(page);
  assert.deepEqual([st.appearance.lashes, st.appearance.lashStyle], [true, 'long']);
  assert.equal(st.appearance.lipColor, '#a1424a');
  assert.equal(await page.evaluate(() => document.querySelector('.st-tiles[data-group="gender"]') === null), true);
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('.st-panel .st-gender .st-seg-btn')).map(x => x.textContent)), ['Male', 'Female']);
  pass('CE-09 Male / Female toggle; lash styles and lip colour for Female');

  // Randomize with locks, Reset look, presets, copy look.
  const tools = await page.evaluate(() => {
    const es = () => _agentPanelEditState;
    VOStudio.state.locks = { hair: true };
    const hair = JSON.stringify([es().appearance.hairStyle, es().appearance.hairColor, es().appearance.hairHighlight]);
    const lookBefore = JSON.stringify(es());
    let changed = false;
    for (let i = 0; i < 5; i++) {
      VOStudio.randomize();
      if (JSON.stringify([es().appearance.hairStyle, es().appearance.hairColor, es().appearance.hairHighlight]) !== hair) return { hairChanged: true };
      if (JSON.stringify(es()) !== lookBefore) changed = true;
    }
    VOStudio.state.locks = {};
    VOStudio.applyPreset('engineer');
    const preset = [es().appearance.headwear, es().appearance.heldItem, es().color];
    VOStudio.copyLookFrom('beta');
    const copied = [es().gender, es().appearance.skinTone, es().appearance.glasses, es().name];
    VOStudio.resetLook();
    const reset = es().appearance;
    return { hairChanged: false, changed, preset, copied, resetDesk: reset.deskItem, resetHat: reset.headwear, resetHair: !!reset.hairStyle };
  });
  assert.deepEqual(tools, { hairChanged: false, changed: true, preset: ['hardhat', 'wrench', '#fb8c00'],
    copied: ['F', '#8d5524', 'round', 'Alpha'], resetDesk: tools.resetDesk, resetHat: null, resetHair: true });
  assert.ok(tools.resetDesk, 'reset gives the default desk item');
  pass('Randomize keeps locked parts; outfit sets, Copy look from, Reset look');

  // CE-19 emoji grid; CE-12 provider-named runtime link in Advanced.
  await clickSync(page, '.st-emoji-btn');
  const emojiCount = await page.evaluate(() => document.querySelectorAll('.st-emoji-pop .st-emoji').length);
  assert.ok(emojiCount >= 40);
  await clickSync(page, '.st-emoji-pop .st-emoji:nth-child(12)');
  st = await look(page);
  assert.equal(st.emoji, '🚀');
  assert.equal(await page.evaluate(() => document.querySelector('.st-emoji-pop')), null);
  await clickSync(page, '.st-adv-link');
  const adv = await page.evaluate(() => ({ title: Array.from(document.querySelectorAll('.st-panel .st-field-title')).map(x => x.textContent),
    warn: document.querySelector('.st-panel .st-warn') && document.querySelector('.st-panel .st-warn').textContent }));
  assert.equal(adv.title[0], 'Linked OpenClaw agent');
  assert.match(adv.warn, /links the character to another OpenClaw agent/);
  pass('CE-19 emoji grid; CE-12 runtime link named per provider, in Advanced with a warning');

  // CE-07 / CE-17: no inline colours, SVG icons, plain titles, Discard left of Save.
  const tokens = await page.evaluate(() => {
    const ed = document.getElementById('acp-editor');
    const bad = Array.from(ed.querySelectorAll('[style]')).map(n => n.getAttribute('style'))
      .filter(s => /#[0-9a-f]{3,6}|rgb/i.test(s.replace(/--sw:\s*#[0-9a-f]{3,8};?/ig, '')));
    const titles = Array.from(ed.querySelectorAll('.st-field-title, .st-cat-label')).map(n => n.textContent);
    const btns = Array.from(ed.querySelectorAll('.st-tools button, .st-footer button'));
    const emoji = btns.filter(b => /\p{Extended_Pictographic}/u.test(b.textContent)).map(b => b.textContent);
    const footer = Array.from(ed.querySelectorAll('.st-footer button')).map(b => b.id || b.className);
    return { bad, ascii: titles.filter(t => /─/.test(t)), emoji, icons: btns.filter(b => b.querySelector('svg.vo-icon')).length, footer };
  });
  assert.deepEqual(tokens.bad, []);
  assert.deepEqual(tokens.ascii, []);
  assert.deepEqual(tokens.emoji, []);
  assert.ok(tokens.icons >= 6);
  assert.ok(tokens.footer.indexOf('acp-discard-btn') < tokens.footer.indexOf('acp-save-btn'));
  pass('CE-07 / CE-17 token styles, SVG icons, plain titles, Discard then Save');

  // CE-22: human labels.
  await cat(page, 'items');
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('.st-tile-label')).map(x => x.textContent));
  assert.ok(labels.includes('Test tube') && !labels.some(l => /[a-z][A-Z]/.test(l)), labels.join());
  pass('CE-22 human labels for option ids');

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log(`${NAME}: ${passed.length} passed`);
