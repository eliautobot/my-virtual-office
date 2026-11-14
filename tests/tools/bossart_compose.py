#!/usr/bin/env python3
"""Join bossart_sheet.mjs parts (art.png + scene-NN-<id>-<rot>.png crops) into one JPEG under a byte budget.
usage: python3 -I tests/tools/bossart_compose.py TMPDIR OUT.jpg [MAX_KB=118] [ROTS=0,90] [PER_ROW=2]
The art (rows = variant x 2 colours, columns = 0/90/180/270) on top at its rendered scale; below it the scene
crops of the turns in ROTS (a working agent at each), PER_ROW per row, scaled to the art's width."""
import glob, io, os, re, sys
from PIL import Image, ImageDraw

tmp, out = sys.argv[1], sys.argv[2]
max_kb = int(sys.argv[3]) if len(sys.argv) > 3 else 118
rots = (sys.argv[4] if len(sys.argv) > 4 else '0,90').split(',')
per = int(sys.argv[5]) if len(sys.argv) > 5 else 2

art = Image.open(os.path.join(tmp, 'art.png')).convert('RGB')
width = art.width
crops = [p for p in sorted(glob.glob(os.path.join(tmp, 'scene-*.png'))) if re.search(r'-(\d+)\.png$', p).group(1) in rots]
cw = (width - 2 * (per + 1)) // per
rows = [crops[i:i + per] for i in range(0, len(crops), per)]
scaled = [[Image.open(p).convert('RGB') for p in r] for r in rows]
scaled = [[im.resize((cw, round(im.height * cw / im.width)), Image.LANCZOS) for im in r] for r in scaled]
H = art.height + 20 + sum(max(im.height for im in r) + 2 for r in scaled)
sheet = Image.new('RGB', (width, H), (42, 47, 58))
sheet.paste(art, (0, 0))
d = ImageDraw.Draw(sheet)
y = art.height + 3
d.text((6, y), 'In the office (zoomed): a working agent at each, turns ' + '/'.join(rots), fill=(232, 234, 240))
y += 17
for r in scaled:
    for j, im in enumerate(r):
        sheet.paste(im, (2 + j * (cw + 2), y))
    y += max(im.height for im in r) + 2
q = 90
while True:
    buf = io.BytesIO()
    sheet.save(buf, 'JPEG', quality=q, optimize=True)
    if buf.tell() <= max_kb * 1024 or q <= 30:
        break
    q -= 3
with open(out, 'wb') as f:
    f.write(buf.getvalue())
print('sheet %s %dx%d %d KB q%d' % (out, sheet.width, sheet.height, buf.tell() // 1024, q))
