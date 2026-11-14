#!/usr/bin/env python3
"""Grade a raw office capture into the login page backdrop (v0.10 UI-15). Needs Pillow.

Usage: python3 tests/tools/grade-login-backdrop.py <raw.png> <out.jpg>
Recipe: crop the empty surround, soft blur (dissolves name tags and chips baked into the canvas),
dim and warm toward the brand yellow, radial vignette, one resize to 1600 px wide, JPEG q60.
"""
import sys
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageDraw

BLUR = 2.4
BRIGHTNESS = 0.52
CONTRAST = 1.08
WARM = (245, 200, 76)   # --vo-accent of Classic dark
WARM_MIX = 0.07
VIGNETTE = 0.62         # how dark the corners get (0 = none)
WIDTH = 1600
QUALITY = 60


def main(src, dst):
    im = Image.open(src).convert('RGB')
    bg = Image.new('RGB', im.size, im.getpixel((2, 2)))
    box = ImageChops.difference(im, bg).convert('L').point(lambda v: 255 if v > 12 else 0).getbbox() or (0, 0) + im.size
    im = im.crop(box)
    im = im.filter(ImageFilter.GaussianBlur(BLUR))
    im = ImageEnhance.Brightness(im).enhance(BRIGHTNESS)
    im = ImageEnhance.Contrast(im).enhance(CONTRAST)
    im = Image.blend(im, Image.new('RGB', im.size, WARM), WARM_MIX)
    w, h = im.size
    mask = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(mask)
    steps = 48
    for i in range(steps):
        t = i / steps
        inset_x, inset_y = int(w * 0.5 * t), int(h * 0.5 * t)
        d.ellipse((inset_x - w * 0.25, inset_y - h * 0.25, w - inset_x + w * 0.25, h - inset_y + h * 0.25), fill=int(255 * (1 - VIGNETTE) + 255 * VIGNETTE * t))
    mask = mask.filter(ImageFilter.GaussianBlur(w / 20))
    im = Image.composite(im, Image.new('RGB', im.size, (0, 0, 0)), mask)
    if w != WIDTH:
        im = im.resize((WIDTH, round(h * WIDTH / w)), Image.LANCZOS)
    im.save(dst, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
    import os
    print({'crop': box, 'out': dst, 'size': im.size, 'bytes': os.path.getsize(dst)})


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
