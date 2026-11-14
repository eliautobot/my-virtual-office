// One half of a before/after sheet through the real draw code of whatever app the given tests dir serves.
// node tests/tools/sheets/sheet.mjs <testsDir> <mode> <out.png> <title>   (testsDir: absolute; its ../app is drawn,
// e.g. this tree's tests or an rc-v0.11.0 checkout's). Modes: a characters (12 people x front, left, back, at a desk
// from behind, walking left; hair colours contrast with the skin, ratios printed), b expressions, c furniture
// reactions, d pets (awake, asleep, trick, in the bed, at the bowl), e / ep Agent Studio tabs on desktop / a 412 px
// phone (CATS=hair,outfit,... picks the tabs), t tops (6 tops x 5 views at 1x and 3x, TOP_COLOR=#rrggbb). Then compose.mjs before + after into one JPEG under 120 KB.
import fs from 'node:fs';
const [testsDir, mode, out, title] = process.argv.slice(2);
const { launch, openStudio, showStudio } = await import(testsDir + '/test_v10_studio_lib.mjs');
const browser = await launch('sheet');
const save = (url) => fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
try {
  const phone = mode === 'ep';
  const { page, errors } = await openStudio(browser, { phone });
  await page.waitForFunction(() => window.VOOffice && typeof window.VOOffice.renderAgentPreview === 'function', null, { timeout: 15000 });
  if (mode === 'e' || mode === 'ep') {
    // Agent Studio: hair, outfit, hats and face tabs
    await showStudio(page, 'alpha');
    await page.evaluate(() => { if (window.VOStudio && VOStudio.state) VOStudio.state.playing = false; });
    const shots = [];
    for (const cat of (process.env.CATS || 'hair,outfit,hats,face').split(',')) {
      await page.evaluate((c) => { if (window.VOStudio && VOStudio.showCategory) VOStudio.showCategory(c); }, cat);
      await page.waitForTimeout(300);
      const el = await page.$('#agent-creator-panel .st-side') || await page.$('#agent-creator-panel');   // tabs + controls
      const buf = await (el || page).screenshot({ type: 'png', scale: 'css' });
      shots.push('data:image/png;base64,' + buf.toString('base64'));
    }
    const url = await page.evaluate(async ([shots, title, phone]) => {
      const imgs = await Promise.all(shots.map((s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = s; })));
      const tw = imgs[0].width, th = Math.max(...imgs.map((i) => i.height));                     // native size: readable
      const S = document.createElement('canvas'); S.width = (tw + 6) * imgs.length + 6; S.height = th + 22;
      const g = S.getContext('2d'); g.fillStyle = '#efeae0'; g.fillRect(0, 0, S.width, S.height);
      g.fillStyle = '#222'; g.font = 'bold 13px sans-serif'; g.fillText(title, 6, 15);
      imgs.forEach((im, i) => g.drawImage(im, 6 + i * (tw + 6), 20));
      return S.toDataURL('image/png');
    }, [shots, title, phone]);
    save(url);
  } else {
    if (process.env.TOP_COLOR) await page.evaluate((c) => { window.__topColor = c; }, process.env.TOP_COLOR); // mode t
    const url = await page.evaluate(([mode, title]) => {
      const S = document.createElement('canvas'), g = S.getContext('2d');
      const head = (w, h) => { S.width = w; S.height = h; g.fillStyle = '#d9d4c7'; g.fillRect(0, 0, w, h); g.fillStyle = '#222'; g.font = 'bold 13px sans-serif'; g.fillText(title, 6, 15); g.font = '10px sans-serif'; };
      const R = window.VOOffice.renderAgentPreview;
      const cell = (look, o, w, h) => { const c = document.createElement('canvas'); R(c, look, Object.assign({ scale: 2, width: w, height: h, dpr: 1, floor: false }, o)); return c; };
      const withCtx = (c, fn) => { const keep = window.ctx; window.ctx = c.getContext('2d'); try { fn(window.ctx); } finally { window.ctx = keep; } };
      if (mode === 'a') {
        const P = [
          { hairStyle: 'short', hairColor: '#4e342e', skinTone: '#f1c27d' },
          { hairStyle: 'long', hairColor: '#212121', skinTone: '#e0ac69', glasses: 'round', gender: 'F' },
          { hairStyle: 'afro', hairColor: '#ffd54f', skinTone: '#8d5524', shirtStyle: 'hoodie', headwear: 'headset' },
          { hairStyle: 'braids', hairColor: '#ffee58', skinTone: '#a0522d', shirtStyle: 'suit', neckwear: 'tie', gender: 'F' },
          { hairStyle: 'bun', hairColor: '#b71c1c', skinTone: '#ffdbac', shirtStyle: 'labcoat', glasses: 'square', gender: 'F' },
          { hairStyle: 'mohawk', hairColor: '#1b1b1b', skinTone: '#c68642', shirtStyle: 'vest', neckwear: 'bowtie' },
          { hairStyle: 'locs', hairColor: '#ff8a65', skinTone: '#6b4226', shirtStyle: 'sweater', headwear: 'beanie', headwearColor: '#00897b' },
          { hairStyle: 'curtains', hairColor: '#2b1b17', skinTone: '#f1c27d', headwear: 'cap', headwearColor: '#1565c0', facialHair: 'beard' },
          { hairStyle: 'pigtails', hairColor: '#1a1a1a', skinTone: '#ffe0bd', headwear: 'witch', headwearColor: '#4a148c', neckwear: 'scarf', gender: 'F' },
          { hairStyle: 'fade', hairColor: '#c0ca33', skinTone: '#8d5524', headwear: 'sunhat', headwearColor: '#d7b46a', glasses: 'sunglasses' },
          { hairStyle: 'spiky', hairColor: '#0d47a1', skinTone: '#ffdbac', costume: 'astronaut' },
          { hairStyle: 'curly', hairColor: '#5d4037', skinTone: '#e0ac69', costume: 'dino' },
        ];
        const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255).map((x) => x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        window.__contrast = P.map((p) => { const a = lum(p.hairColor), b = lum(p.skinTone); return p.hairStyle + ' ' + ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(1); });
        const COLS = [['front', { facing: 'down' }], ['left', { facing: 'left' }], ['back', { facing: 'up' }],
          ['at desk, back', { facing: 'up', pose: 'type', withDesk: true }], ['walking left', { facing: 'left', pose: 'walk', time: 240 }]];
        const cw = 62, ch = 132, lw = 70;
        head(lw + cw * P.length, 22 + ch * COLS.length);
        P.forEach((p, i) => g.fillText(String(i + 1), lw + i * cw + 26, 30));
        COLS.forEach(([lab, o], j) => {
          g.fillStyle = '#222'; g.fillText(lab, 4, 22 + j * ch + ch / 2);
          P.forEach((p, i) => g.drawImage(cell(p, Object.assign({ color: ['#1e88e5', '#e53935', '#43a047', '#8e24aa', '#fb8c00', '#00acc1'][i % 6], gender: p.gender || 'M' }, o), cw, ch), lw + i * cw, 22 + j * ch));
        });
      } else if (mode === 't') {
        // tops: the six tops x front, back, left, at a desk from behind, walking left; at the office's normal
        // size (1 art px per px) and at 3x. TOP_COLOR=#rrggbb picks the shirt colour (default blue).
        const TOPS = ['tee', 'hoodie', 'suit', 'labcoat', 'sweater', 'vest'], col = window.__topColor || '#1e88e5';
        const COLS = [['front', { facing: 'down' }], ['back', { facing: 'up' }], ['left', { facing: 'left' }],
          ['desk, back', { facing: 'up', pose: 'type', withDesk: true }], ['walk L', { facing: 'left', pose: 'walk', time: 240 }]];
        // 1x: the whole person; 3x: the top only (chin to hips; at the desk the seated back)
        const SV = { x: -16, y: -48, w: 32, h: 54 }, DV = { x: -20, y: -42, w: 40, h: 50 }, SV3 = { x: -15, y: -23, w: 30, h: 22 }, DV3 = { x: -18, y: -14, w: 36, h: 19 };
        const lw = 60, w1 = 42, rh = 74, top = 40, w3 = COLS.map(([, o]) => (o.withDesk ? DV3 : SV3).w * 3 + 4), x3 = lw + COLS.length * w1 + 10;
        head(x3 + w3.reduce((a, b) => a + b, 0), top + rh * TOPS.length);
        g.fillText('normal size (1x)', lw, 28); g.fillText('3x: the top (chin to hips)', x3, 28);
        COLS.forEach(([lab], i) => { g.fillText(lab.split(',')[0], lw + i * w1, 37); g.fillText(lab, x3 + w3.slice(0, i).reduce((a, b) => a + b, 0) + 4, 37); });
        TOPS.forEach((t, j) => {
          g.fillStyle = '#222'; g.fillText(t, 4, top + j * rh + 36);
          COLS.forEach(([, o], i) => {
            const V = o.withDesk ? DV : SV, V3 = o.withDesk ? DV3 : SV3, look = { shirtStyle: t, hairStyle: 'short', hairColor: '#4e342e', skinTone: '#f1c27d' };
            const one = cell(look, Object.assign({ view: V, scale: 1, color: col, gender: 'M', time: 0 }, o), V.w, V.h);
            g.drawImage(one, lw + i * w1, top + j * rh + 4);
            const big = cell(look, Object.assign({ view: V3, scale: 3, color: col, gender: 'M', time: 0 }, o), V3.w * 3, V3.h * 3);
            g.drawImage(big, x3 + w3.slice(0, i).reduce((a, b) => a + b, 0), top + j * rh + 4);
          });
        });
      } else if (mode === 'b') {
        const EX = window.AGENT_EXPRESSIONS || ['neutral'];
        const cw = 112, ch = 112, lw = 60;   // the head view at scale 3 is about 108 px: no clipped tiles
        head(lw + cw * EX.length, 32 + ch * 2);
        EX.forEach((e, i) => g.fillText(e, lw + i * cw + 6, 30));
        [['front', 'down'], ['profile', 'right']].forEach(([lab, f], j) => {
          g.fillStyle = '#222'; g.fillText(lab, 4, 32 + j * ch + ch / 2);
          EX.forEach((e, i) => g.drawImage(cell({ hairStyle: 'short', hairColor: '#4e342e', skinTone: '#f1c27d' }, { facing: f, view: 'head', expression: e, scale: 3 }, cw, ch), lw + i * cw, 32 + j * ch));
        });
      } else if (mode === 'c') {
        const M = window.FURNITURE_MANIFEST || {}, types = Object.keys(M).filter((t) => M[t] && M[t].react);
        const list = types.length ? types : ['lamp', 'tv', 'vendingMachine', 'waterCooler', 'coffeeMaker', 'microwave', 'plant', 'whiteboard', 'dartBoard', 'bookshelf', 'clock'];
        if (typeof _reactionsOn === 'function') window._reactionsOn = () => true;
        const frames = (t) => { const r = (M[t] && M[t].react) || {}; const f = [['rest', null]];
          for (let s = 1; s < (r.states || 1); s++) f.push(['state ' + s, { n: s, state: s, t: -1, held: false }]);
          if (r.ms) { f.push(['moving', { n: 1, state: (r.states || 1) > 1 ? 1 : 0, t: 0.5, held: false }]); if (r.hold) f.push(['after', { n: 1, state: 0, t: -1, held: true }]); }
          return f; };
        const maxF = Math.max(...list.map((t) => frames(t).length));
        const SC = 2, lw = 90, PAD = 6, LAB = 13;
        // each frame drawn once into a large scratch canvas and measured: rows and columns are sized from the
        // real art (tall pieces do not reach into the row above, wide ones are not cut), labels sit above it
        const draw = (t, rx) => {
          const c = document.createElement('canvas'); c.width = 420; c.height = 420;
          const item = { id: 'sheet-' + t, type: t, x: 0, y: 0, rotation: 0 };
          withCtx(c, (k) => {
            k.save(); k.translate(150, 250); k.scale(SC, SC);
            if (rx && typeof _rxOf === 'function') { const keep = window._rxOf; window._rxOf = () => rx; try { _rxTable.set(_rxKey(item), {}); _drawFurnitureArt(item, false); } finally { window._rxOf = keep; _rxTable.delete(_rxKey(item)); } }
            else if (typeof _drawFurnitureArt === 'function') _drawFurnitureArt(item, false); else drawFurnitureItem(item);
            k.restore();
          });
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
          for (let i = 3; i < d.length; i += 4) if (d[i]) { const x = ((i - 3) / 4) % c.width, y = Math.floor((i - 3) / 4 / c.width); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          return { c, x0, y0, w: x1 < 0 ? 0 : x1 - x0 + 1, h: x1 < 0 ? 0 : y1 - y0 + 1 };
        };
        const rows = list.map((t) => frames(t).map(([lab, rx]) => Object.assign(draw(t, rx), { lab })));
        const U = rows.map((r) => { const v = r.filter((f) => f.w);              // one box per row: states keep their place
          const x0 = Math.min(...v.map((f) => f.x0)), y0 = Math.min(...v.map((f) => f.y0));
          return { x0, y0, w: Math.max(...v.map((f) => f.x0 + f.w)) - x0, h: Math.max(...v.map((f) => f.y0 + f.h)) - y0 }; });
        const cw = Math.max(...U.map((u) => u.w)) + PAD * 2;
        const rh = U.map((u) => u.h + LAB + PAD);
        const tops = rh.reduce((a, h) => a.concat([a[a.length - 1] + h]), [22]);
        head(lw + cw * maxF, tops[tops.length - 1] + PAD);
        rows.forEach((r, j) => {
          const u = U[j];
          g.fillStyle = '#222'; g.fillText(list[j], 4, tops[j] + LAB + 12);
          r.forEach((f, i) => {
            g.fillStyle = '#555'; g.fillText(f.lab, lw + i * cw + PAD, tops[j] + 10);
            g.drawImage(f.c, u.x0, u.y0, u.w, u.h, lw + i * cw + Math.round((cw - u.w) / 2), tops[j] + LAB, u.w, u.h);
          });
        });
      } else if (mode === 'd') {
        const SP = (window.PET_SPECIES || [{ id: 'cat' }, { id: 'lobster' }, { id: 'pug' }]).map((s) => s.id || s);
        const ST = [['awake', 'sitting'], ['asleep', 'sleeping'], ['trick', 'trick']];
        const cw = 84, ch = 76, lw = 60, S2 = 2;   // bed and bowl frames measure up to 68 x 69
        head(lw + cw * (ST.length + 2), 22 + ch * SP.length);
        ST.concat([['in its bed', 'bed'], ['at its bowl', 'bowl']]).forEach(([lab], i) => g.fillText(lab, lw + i * cw + 6, 30));
        SP.forEach((sp, j) => {
          g.fillStyle = '#222'; g.fillText(sp, 4, 22 + j * ch + ch / 2);
          ST.concat([['bed', 'bed'], ['bowl', 'bowl']]).forEach(([, st], i) => {
            const c = document.createElement('canvas'); c.width = cw; c.height = ch;
            withCtx(c, (k) => {
              k.save(); k.scale(S2, S2);
              const p = new OfficePet({ species: sp, name: 'P', x: cw / S2 / 2, y: ch / S2 - 8 });
              p.tick = 30; p.animFrame = 1; p._blinking = false;
              if (st === 'trick') { if (typeof p.startTrick === 'function') { p.startTrick('species'); p.stateTimer = 36; } else p.state = 'sitting'; }
              else if (st === 'bed' || st === 'bowl') {
                k.restore();
                const M = window.FURNITURE_MANIFEST || {};
                if (!M.petBed) { window.__bedBox = (window.__bedBox || []).concat(['nobed']); return; }
                // the real frame: a bed or bowl on free floor near the middle, the pet in it / eating at it, cropped
                window._runSimulation = () => 0;
                const type = st === 'bed' ? 'petBed' : 'petBowl';
                let spot = null;
                for (let y = Math.round(H * 0.55); y < H - 40 && !spot; y += 6) for (let x = Math.round(W * 0.3); x < W * 0.7; x += 6) if (_placementProblem(type, x, y, 0, null) === '') { spot = { x, y }; break; }
                if (!spot) { window.__bedBox = (window.__bedBox || []).concat(['nospot']); return; }
                const it = { id: 'sheet-' + type, type, x: spot.x, y: spot.y, rotation: 0 };
                const keepPets = officePets.slice();
                // the same frame (same time, camera, insets) without and with the bed or bowl and the pet; the
                // tile is cut around what changed, wherever the renderer put it on the canvas
                const dpr = window.DPR || 1, g2 = canvas.getContext('2d');
                camera.zoom = 2 / (getBaseScale() * dpr); camera.x = it.x + 15 - W / 2; camera.y = it.y - 4 - H / 2;
                const T0 = (window.__shT = (window.__shT || performance.now() + 2e7) + 1000);
                const frame = () => { const keepC = window.ctx; window.ctx = g2; try { for (let n = 0; n < 2; n++) { if (typeof _invalidateStaticLayer === 'function') _invalidateStaticLayer(); _sceneDirty = true; _lastDrawAt = -1e12; _renderFrame(T0); /* same time: reset the frame limiter; the office ctx, not the tile's */ } } finally { window.ctx = keepC; } return g2.getImageData(0, 0, canvas.width, canvas.height); };
                officePets.length = 0;
                const A = frame();
                officeConfig.furniture.push(it); buildCollisionGrid();
                try {
                  const pl = _petPlaces(type).find((q) => q.item === it);
                  if (st === 'bed') { p.x = p.targetX = p._prevTargetX = pl.rest.x; p.y = p.targetY = p._prevTargetY = pl.rest.y; p.state = 'sleeping'; p._inBed = it; }
                  else { p.x = p.targetX = p._prevTargetX = pl.x; p.y = p.targetY = p._prevTargetY = pl.y; p.state = 'eating'; p._useSpot = pl; p._eatView = pl.y > it.y ? 'back' : 'front'; }
                  officePets.push(p);
                  const B = frame(), cwid = canvas.width;
                  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
                  for (let i = 0; i < B.data.length; i += 4) if (B.data[i] !== A.data[i] || B.data[i + 1] !== A.data[i + 1] || B.data[i + 2] !== A.data[i + 2]) {
                    const px = (i / 4) % cwid, py = Math.floor(i / 4 / cwid);
                    if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
                  }
                  if (x1 < 0) { window.__bedBox = (window.__bedBox || []).concat(['nodiff']); return; }
                  const cx = Math.round((x0 + x1) / 2 - cw / 2), cy = Math.round((y0 + y1) / 2 - ch / 2);
                  c.getContext('2d').putImageData(g2.getImageData(cx, cy, cw, ch), 0, 0);
                  window.__bedBox = (window.__bedBox || []).concat([sp + '/' + st + ' ' + (x1 - x0 + 1) + 'x' + (y1 - y0 + 1)]);
                } finally {
                  officeConfig.furniture.splice(officeConfig.furniture.indexOf(it), 1); buildCollisionGrid();
                  officePets.length = 0; keepPets.forEach((q) => officePets.push(q));
                }
                return;
              } else p.state = st;
              p.draw(); k.restore();
            });
            g.drawImage(c, lw + i * cw, 22 + j * ch);
          });
        });
      }
      return S.toDataURL('image/png');
    }, [mode, title]);
    save(url);
    const cn = await page.evaluate(() => window.__contrast);
    if (cn) console.log('hair/skin contrast (WCAG): ' + cn.join(', '));
    const bb = await page.evaluate(() => window.__bedBox);
    if (bb) console.log('bed/bowl changed boxes: ' + bb.join(', '));
  }
  console.log('wrote ' + out + ' ' + fs.statSync(out).size + ' bytes' + (errors.length ? ' ERR ' + errors.slice(0, 2).join(' | ').slice(0, 300) : ''));
} finally { await browser.close(); }
