// v0.13 deskart sheet: rows = desk variants; columns = rotation 0 / 90 / 180 / 270 in colour A with a
// working agent at the desk (real seat pose, sorted like the frame), then the same four in colour B
// (art only). Scale 2, one JPEG.
//   node tests/tools/deskart_sheet.mjs <out.jpg> <ids comma> [colourA,colourB] [tool] [quality]
// colours default to each variant's first two; tool = the running tool (exec = typing, read = papers ...).
import { openPage, saveDataUrl } from '../sheets_v12_moves/sheetlib.mjs';
const [out, idsArg, colArg, toolArg, qArg] = process.argv.slice(2);
const size = await openPage(new URL('../../app', import.meta.url).pathname, async (p) => p.evaluate(([ids, cols, tool, q]) => {
  const S = 2, PAD = 6, LW = 74, rows = [];
  ids.forEach(id => {
    const row = FURNITURE_VARIANTS.desk.find(r => r.id === id) || FURNITURE_VARIANTS.bossDesk.find(r => r.id === id);
    if (!row) return;
    const type = FURNITURE_VARIANTS.desk.includes(row) ? 'desk' : 'bossDesk';
    const cc = cols ? cols : [row.colors[0], row.colors[1] || row.colors[0]];
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    [0, 90, 180, 270].forEach(rot => {
      const it = { id: 'd', type, x: 300, y: 300, rotation: rot }; if (id !== 'classic') it.variant = id;
      const a = _getItemWorldRect(it); x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y - 12); x1 = Math.max(x1, a.x + a.w); y1 = Math.max(y1, a.y + a.h + 8);
    });
    rows.push({ id, type, row, cc, box: { x: Math.floor(x0) - PAD, y: Math.floor(y0) - PAD, w: Math.ceil(x1 - x0) + 2 * PAD, h: Math.ceil(y1 - y0) + 2 * PAD } });
  });
  const CW = Math.max(...rows.map(r => r.box.w)), W = LW + 8 * (CW * S + 4);
  const H = 16 + rows.reduce((s, r) => s + r.box.h * S + 16, 0);
  const sheet = document.createElement('canvas'); sheet.width = W; sheet.height = H; const sg = sheet.getContext('2d');
  sg.fillStyle = '#20232a'; sg.fillRect(0, 0, W, H); sg.imageSmoothingEnabled = false; sg.font = '11px monospace';
  const a = agents[0];
  let yy = 16;
  rows.forEach(R => {
    sg.fillStyle = '#eee'; sg.fillText(R.id, 4, yy + 14); sg.fillText(R.cc[0], 4, yy + 30); sg.fillText(R.cc[1], 4, yy + 46);
    for (let k = 0; k < 8; k++) {
      const rot = [0, 90, 180, 270][k % 4], col = R.cc[k < 4 ? 0 : 1], withAgent = k < 4;
      const item = { id: 'd', type: R.type, x: 300, y: 300, rotation: rot, color: col }; if (R.id !== 'classic') item.variant = R.id;
      officeConfig.furniture = [item]; officeConfig.agents = [];
      if (typeof _worldChanged === 'function') _worldChanged();
      a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null, hairStyle: 'short' });
      Object.assign(a, { isSitting: true, state: 'working', idleAction: null, meetingId: null, carryItem: null, _lifePose: null, _lifeCarry: null, _seatCache: null,
        _seatT: 1, _seatFrom: null, _forceView: null, tick: 30, _lastSeat: null, _swv: null, _dIdle: null, waitingApprovalCount: 0, _activityFrame: -1 });
      a.x = a.targetX = a._prevTargetX = item.x; a.y = a.targetY = a._prevTargetY = item.y; a.desk = { x: item.x, y: item.y };
      agentChatData[a.statusKey] = [{ role: 'assistant', text: '', tools: [{ name: tool || 'exec', status: 'running' }] }];
      const box = R.box, cv = document.createElement('canvas'); cv.width = box.w; cv.height = box.h; const g = cv.getContext('2d');
      const s = window.ctx; window.ctx = g;
      try {
        g.setTransform(1, 0, 0, 1, -box.x, -box.y); g.fillStyle = k < 4 ? '#d3c8b8' : '#b9c3c9'; g.fillRect(box.x, box.y, box.w, box.h);
        drawFurnitureItem(item, { staticOnly: true });
        if (withAgent) {
          if (typeof _drawDeskMonitor === 'function') try { _drawDeskMonitor(item); } catch (e) {}
          const ents = [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
        } else { const ents = _tallFurnitureEntries(); ents.sort(_entitySortCompare); _drawSortedGroup(ents); }
      } finally { window.ctx = s; }
      sg.drawImage(cv, LW + k * (CW * S + 4) + Math.floor((CW - box.w) * S / 2), yy, box.w * S, box.h * S);
      if (k % 4 === 0) { sg.fillStyle = '#9aa'; sg.fillText(withAgent ? 'working' : 'art', LW + k * (CW * S + 4) + 2, yy + 10); }
    }
    yy += R.box.h * S + 16;
  });
  return sheet.toDataURL('image/jpeg', q);
}, [idsArg.split(','), colArg ? colArg.split(',') : null, toolArg || 'exec', Number(qArg || 0.72)]).then(u => saveDataUrl(u, out)));
console.log('bytes', size);
