// node sheet_moves.mjs <appDir> <out.jpg> <mode: sig-stand|sig-seat|waves>
import { openPage, saveDataUrl } from './sheetlib.mjs';
const [appDir, out, mode] = process.argv.slice(2);
const size = await openPage(appDir, async (p) => (await p.evaluate(q => { window.__q = q; }, Number(process.env.Q || 0.5)), p.evaluate(([mode]) => {
  const S = 2, PAD = 4, LW = 76;
  const a = agents[0];
  const reset = (extra) => {
    a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null, hairStyle: 'short', shirtStyle: 'hoodie' });
    Object.assign(a, { isSitting: false, state: 'idle', idleAction: null, meetingId: null, carryItem: null, _lifePose: null, _lifeCarry: null, _lifeExtra: false,
      _seatCache: null, _seatT: 1, _seatFrom: null, _forceView: null, tick: 10, _lastSeat: null, _swv: null, _dIdle: null, waitingApprovalCount: 0,
      _activityFrame: -1, _react: null, _sigMove: null, _walkFace: null, _pvx: null, _pvy: null, faceDir: 1, blinkTimer: 0, _exprFlash: null }, extra || {});
  };
  const sigAt = (id, p, still) => { const m = _sigMoveSpec(id); a._sigMove = { id, at: performance.now() - p * m.ms, ms: m.ms, still: !!still, until: Infinity }; };
  // one tile: desk (type, rot) or standing (view / walk), then fn(a) sets up the move or wave
  const tile = (o) => {
    const W = o.desk ? 62 : 56, H = o.desk ? 80 : 72;
    officeConfig.agents = [];
    reset({ state: o.state || (o.desk ? 'working' : 'idle') });
    const X = 300, Y = 300;
    let item = null;
    if (o.desk) { item = { id: 'd', type: o.desk[0], x: X, y: Y, rotation: o.desk[1] }; officeConfig.furniture = [item]; a.isSitting = true; a.desk = { x: X, y: Y }; }
    else { officeConfig.furniture = []; a.desk = { x: -999, y: -999 }; }
    a.x = a.targetX = a._prevTargetX = X; a.y = a.targetY = a._prevTargetY = Y;
    if (o.view === 'up') a.idleAction = 'look_window';
    if (o.view === 'left' || o.view === 'right') a._forceView = o.view;
    if (o.walk) { a.targetX = X + 300; a._walkFace = 'right'; a._pvx = X - 1; a._pvy = Y; a.tick = o.tick || 10; }
    agentChatData[a.statusKey] = [{ role: 'assistant', text: '', tools: [{ name: 'exec', status: 'running' }] }];
    if (o.prep) o.prep(a);
    if (o.fn) o.fn(a);
    const box = { x: X - W / 2, y: Y - (o.desk ? 58 : 62), w: W, h: H };
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'), s = window.ctx; window.ctx = g;
    try {
      g.setTransform(1, 0, 0, 1, -box.x, -box.y); g.fillStyle = '#d3c8b8'; g.fillRect(box.x, box.y, W, H);
      if (item) drawFurnitureItem(item, { staticOnly: true });
      const ents = [a].concat(item ? _tallFurnitureEntries() : []); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
    } finally { window.ctx = s; }
    return cv;
  };
  let rows = [];
  if (mode === 'sig-stand' || mode === 'sig-seat') {
    const P = [0.12, 0.3, 0.5, 0.7];
    const cols = mode === 'sig-stand'
      ? [['front', { view: 'down' }, P], ['left', { view: 'left' }, [0.3, 0.5]], ['back', { view: 'up' }, [0.3, 0.5]]]
      : [['desk 0', { desk: ['desk', 0] }, [0.2, 0.3, 0.55]], ['desk 90', { desk: ['desk', 90] }, [0.2, 0.3, 0.55]]];
    rows = SIGNATURE_MOVES.map(m => [m.label + ' ' + (m.ms / 1000) + 's', [].concat(...cols.map(([lab, o, ps]) => ps.map((pp, i) => [i ? '' : lab, Object.assign({}, o, { fn: () => sigAt(m.id, pp) })])))]);
    rows.push(['still (calm)', [].concat(...cols.map(([lab, o]) => SIGNATURE_MOVES.slice(0, 2).map((m, i) => [m.id, Object.assign({}, o, { fn: () => sigAt(m.id, 0.4, true) })])))]);
  } else {
    const R = (kind, ago, extra) => (x) => { x._react = Object.assign({ kind, at: performance.now() - ago, n: 1 }, extra || {}); };
    const seq = (kind, ms, o, extra) => [0.15, 0.35, 0.55, 0.8].map((q, i) => [i ? '' : (q * ms | 0) + 'ms', Object.assign({}, o, { fn: R(kind, q * ms, extra) })]);
    const seat = (rot) => ({ desk: ['desk', rot], prep: (x) => { x._lastSeat = { kind: 'desk', legs: rot === 180 ? 'hidden' : rot ? 'side' : 'rear', view: rot === 0 ? 'up' : rot === 90 ? 'right' : rot === 270 ? 'left' : null }; } });
    rows = [['stand: turns+waves', seq('click', WAVE_MS.wave, { view: 'up' })], ['walking', seq('click', WAVE_MS.walk, { walk: true })],
      ['desk 0: turns', seq('click', WAVE_MS.turn, seat(0))], ['desk 90: turns', seq('click', WAVE_MS.turn, seat(90))], ['desk 180', seq('click', WAVE_MS.turn, seat(180))],
      ['offline: stirs', seq('click', WAVE_MS.stir, { state: 'offline' })], ['menu Wave', seq('wave', WAVE_BIG_MS, { view: 'down' })],
      ['calm: icon', [['stand', { view: 'up', fn: (x) => { x._react = { kind: 'click', at: performance.now() - 300, n: 1, still: true, wk: 'wave' }; } }], ['desk 0', Object.assign(seat(0), { fn: (x) => { x._react = { kind: 'click', at: performance.now() - 300, n: 1, still: true, wk: 'turn' }; } })]]]];
  }
  const ncols = Math.max(...rows.map(r => r[1].length));
  const big = rows.some(r => r[1].some(t => t[1].desk)); const TW = (big ? 62 : 56) * S, TH = (big ? 80 : 72) * S;
  const sheet = document.createElement('canvas'); sheet.width = LW + ncols * (TW + PAD); sheet.height = rows.length * (TH + PAD + 12);
  const sg = sheet.getContext('2d'); sg.fillStyle = '#20232a'; sg.fillRect(0, 0, sheet.width, sheet.height); sg.imageSmoothingEnabled = false; sg.font = '11px monospace';
  rows.forEach(([label, tiles], r) => {
    const y = r * (TH + PAD + 12);
    sg.fillStyle = '#eee'; label.split(' ').reduce((acc, w) => { if ((acc[acc.length - 1] + ' ' + w).length > 10) acc.push(w); else acc[acc.length - 1] += ' ' + w; return acc; }, ['']).forEach((ln, i) => sg.fillText(ln.trim(), 4, y + 24 + i * 13));
    tiles.forEach(([lab, o], c) => {
      const cv = tile(o), x = LW + c * (TW + PAD);
      sg.drawImage(cv, x + (TW - cv.width * S) / 2, y + 12, cv.width * S, cv.height * S);
      if (lab) { sg.fillStyle = '#9ecbff'; sg.fillText(lab, x + 2, y + 10); }
    });
  });
  return sheet.toDataURL('image/jpeg', window.__q || 0.5);
}, [mode]).then(u => saveDataUrl(u, out))));
console.log('bytes', size);
