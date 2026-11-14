// Before | after (or before over after with "stack") into one JPEG under the byte limit.
// node tests/tools/sheets/compose.mjs <before.png|-> <after.png> <out.jpg> [stack] [maxBytes]
// (Chrome and playwright-core as for the tests: CHROME_PATH, PLAYWRIGHT_CORE_PATH)
import fs from 'node:fs';
const [a, b, out, how, maxB] = process.argv.slice(2);
const MAX = Number(maxB || 118000);
const { launch } = await import(new URL('../../test_v10_studio_lib.mjs', import.meta.url).href);
const browser = await launch('compose');
try {
  const page = await browser.newPage();
  const res = await page.evaluate(async ([A, B, stack, MAX]) => {
    const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = s; });
    const y = await load(B), x = A ? await load(A) : { width: 0, height: -8 };
    let best = null;
    for (const scale of [1, 0.9, 0.8, 0.7, 0.6]) for (const q of [0.85, 0.75, 0.65, 0.55]) {
      const W = stack ? Math.max(x.width, y.width) : x.width + y.width + 8, H = stack ? x.height + y.height + 8 : Math.max(x.height, y.height);
      const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = scale !== 1;
      if (A) g.drawImage(x, 0, 0, x.width * scale, x.height * scale);
      if (stack) g.drawImage(y, 0, (x.height + 8) * scale, y.width * scale, y.height * scale);
      else g.drawImage(y, (x.width + 8) * scale, 0, y.width * scale, y.height * scale);
      const url = c.toDataURL('image/jpeg', q), n = Math.round((url.length - 23) * 0.75);
      if (n <= MAX) return { url, n, scale, q, w: c.width, h: c.height };
      best = { url, n, scale, q, w: c.width, h: c.height };
    }
    return best;
  }, [a === '-' ? '' : 'data:image/png;base64,' + fs.readFileSync(a).toString('base64'), 'data:image/png;base64,' + fs.readFileSync(b).toString('base64'), how === 'stack', MAX]);
  fs.writeFileSync(out, Buffer.from(res.url.split(',')[1], 'base64'));
  console.log(`wrote ${out} ${fs.statSync(out).size} bytes ${res.w}x${res.h} scale ${res.scale} q ${res.q}`);
} finally { await browser.close(); }
