// aa.mjs: is canvas fillRect anti-aliased at fractional transforms (headless Chrome)? merged vs split rects, bitmap vs direct
const { loadPlaywright, findChrome } = await import(new URL('../../perf/client.mjs', import.meta.url).pathname);
const browser = await loadPlaywright().chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const page = await browser.newPage();
const r = await page.evaluate(() => {
  const mk = () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); g.translate(10.37, 10.61); g.scale(1.37, 1.37); return [c, g]; };
  const px = c => Array.from(c.getContext('2d').getImageData(0, 0, 64, 64).data);
  const [a, ga] = mk(); ga.fillStyle = '#5d4037'; ga.fillRect(0, 0, 3, 4); ga.fillRect(3, 0, 3, 4);
  const [b, gb] = mk(); gb.fillStyle = '#5d4037'; gb.fillRect(0, 0, 6, 4);
  const pa = px(a), pb = px(b);
  let diff = 0, partial = 0; for (let i = 3; i < pa.length; i += 4) { if (pa[i] !== pb[i]) diff++; if (pb[i] > 0 && pb[i] < 255) partial++; }
  // bitmap cache drawn at the same transform (smoothing off) vs direct
  const s = document.createElement('canvas'); s.width = 6; s.height = 4; const gs = s.getContext('2d'); gs.fillStyle = '#5d4037'; gs.fillRect(0, 0, 6, 4);
  const [d, gd] = mk(); gd.imageSmoothingEnabled = false; gd.drawImage(s, 0, 0);
  const pd = px(d); let diffBmp = 0; for (let i = 0; i < pd.length; i++) if (pd[i] !== pb[i]) diffBmp++;
  return { splitVsMerged: diff, partialAlphaPixels: partial, bitmapVsDirect: diffBmp };
});
console.log(JSON.stringify(r));
await browser.close();
