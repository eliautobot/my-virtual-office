// node sheet_work.mjs <appDir> <out.jpg> <rots comma> : filmstrips of the work animations, real frame sort.
import { openPage, saveDataUrl } from './sheetlib.mjs';
const [appDir, out, rotsArg] = process.argv.slice(2);
const rots = (rotsArg || '0,180').split(',').map(Number);
const size = await openPage(appDir, async (p) => p.evaluate(([rots]) => {
  const ROWS = [['terminal', 'exec', [0, 4, 70]], ['browser', 'browser', [0, 4, 60]], ['editor', 'read', [20, 76, 120]],
    ['search', 'Grep', [0, 45, 135]], ['message', 'sessions_send', [9, 18, 27]], ['thinking', null, [0, 100, 0]], ];
  const S = 2, TW = 64, TH = 84, PAD = 4, LW = 70;
  const cols = []; (window.__types || ['desk']).forEach(type => rots.forEach(rot => [0, 1, 2].forEach(i => cols.push({ type, rot, i }))));
  const W = LW + cols.length * (TW * S + PAD), H = 18 + ROWS.length * (TH * S + PAD);
  const sheet = document.createElement('canvas'); sheet.width = W; sheet.height = H; const sg = sheet.getContext('2d');
  sg.fillStyle = '#20232a'; sg.fillRect(0, 0, W, H); sg.imageSmoothingEnabled = false; sg.font = '11px monospace'; sg.fillStyle = '#eee';
  cols.forEach((c, k) => { if (c.i === 0) sg.fillText(c.type + ' ' + c.rot, LW + k * (TW * S + PAD), 12); });
  const a = agents[0];
  ROWS.forEach(([kind, tool, ts], r) => {
    sg.fillStyle = '#eee'; sg.fillText(kind, 4, 18 + r * (TH * S + PAD) + 20);
    cols.forEach((c, k) => {
      const item = { id: 'd', type: c.type, x: 300, y: 300, rotation: c.rot };
      officeConfig.furniture = [item]; officeConfig.agents = [];
      a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null, hairStyle: 'short' });
      Object.assign(a, { isSitting: true, state: 'working', idleAction: null, meetingId: null, carryItem: null, _lifePose: null, _lifeCarry: null, _seatCache: null,
        _seatT: 1, _seatFrom: null, _forceView: null, tick: ts[c.i], _lastSeat: null, _swv: null, _dIdle: null, waitingApprovalCount: 0, _activityFrame: -1 });
      a.x = a.targetX = a._prevTargetX = item.x; a.y = a.targetY = a._prevTargetY = item.y; a.desk = { x: item.x, y: item.y };
      agentChatData[a.statusKey] = tool ? [{ role: 'assistant', text: '', tools: [{ name: tool, status: 'running' }] }] : [{ role: 'assistant', text: 'x' }];
      const box = { x: 300 - TW / 2, y: 300 - 62 + (c.type === 'bossDesk' ? 6 : 0), w: TW, h: TH };
      const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; const g = cv.getContext('2d');
      const s = window.ctx; window.ctx = g;
      try {
        g.setTransform(1, 0, 0, 1, -box.x, -box.y); g.fillStyle = '#d3c8b8'; g.fillRect(box.x, box.y, box.w, box.h);
        drawFurnitureItem(item, { staticOnly: true });
        const ents = [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
      } finally { window.ctx = s; }
      sg.drawImage(cv, LW + k * (TW * S + PAD), 18 + r * (TH * S + PAD), TW * S, TH * S);
    });
  });
  return sheet.toDataURL('image/jpeg', 0.7);
}, [rots]).then(u => saveDataUrl(u, out)));
console.log('bytes', size);
