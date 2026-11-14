#!/usr/bin/env python3
"""Compact review image from bossart_sheet.mjs parts: one row per variant = colour 1 at 0/90/180/270 (art)
+ the 0 and 90 scene crops (working agent). usage: python3 -I bossart_review.py TMPDIR NVARIANTS OUT.png [CELL=250]"""
import glob, os, sys
from PIL import Image

tmp, n, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cell = int(sys.argv[4]) if len(sys.argv) > 4 else 250
art = Image.open(os.path.join(tmp, 'art.png')).convert('RGB')
rows = 2 * n
rh = (art.height - 4) // rows
cw = (art.width - 110) // 4
crops = sorted(glob.glob(os.path.join(tmp, 'scene-*.png')))
H = n * (cell + 4)
sheet = Image.new('RGB', (6 * (cell + 4), H), (42, 47, 58))
for i in range(n):
    y0 = 2 + 2 * i * rh + 16
    cells = [art.crop((110 + j * cw, y0, 110 + (j + 1) * cw - 2, y0 + rh - 18)) for j in range(4)]
    cells += [Image.open(crops[4 * i + k]).convert('RGB') for k in (0, 1)]
    for j, im in enumerate(cells):
        s = min(cell / im.width, cell / im.height)
        im2 = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BOX if j < 4 else Image.LANCZOS)  # NEAREST fails in this Pillow build
        sheet.paste(im2, (j * (cell + 4), i * (cell + 4)))
sheet.save(out)
print('review %s %dx%d' % (out, sheet.width, sheet.height))
