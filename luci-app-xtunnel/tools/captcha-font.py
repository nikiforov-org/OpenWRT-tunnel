#!/usr/bin/env python3
"""Makes root/usr/share/xtunnel-ddns/captcha-font.json for the captcha module: the alphabet of
every supported language and a 1-bit bitmap of each character, rendered from a TrueType font.
Every glyph has the same height (the line box of the font, so baselines match) and its own
width (blank columns trimmed). A glyph is {"w": width, "bits": hex}: its rows one after the other,
each as ceil(w / 4) hex digits, the leftmost pixel in the highest bit.

Needs Pillow. Any font that has the glyphs works; PT Sans Bold (SIL Open Font License) is used
here. Run from the repository root:

    python3 xtunnel-ddns/tools/captcha-font.py
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

FONT_FILE = '/System/Library/Fonts/Supplemental/PTSans.ttc'
FONT_INDEX = 7            # face "PT Sans Bold" inside the collection
FONT_SIZE = 34
# Capitals and digits that stay distinct from each other in a distorted picture.
ALPHABETS = {
    # left out: О/0, З/3, Ё/Е, Й/И, Ч/4, Щ/Ш, Б/6, В/8, Ь Ъ Ы, 1
    'ru': 'АГДЕЖИКЛМНПРСТУФХЦШЭЮЯ' + '2456789',
    # left out: O/0/Q, I/1, S/5, Z/2, B/8, G/6
    'en': 'ACDEFHJKLMNPRTUVWXY' + '2345679',
}
OUT = os.path.join(os.path.dirname(__file__), '..', 'root', 'usr', 'share', 'xtunnel-ddns', 'captcha-font.json')

font = ImageFont.truetype(FONT_FILE, FONT_SIZE, index=FONT_INDEX)
ascent, descent = font.getmetrics()
height = ascent + descent

glyphs = {}
for ch in sorted(set(''.join(ALPHABETS.values()))):
    canvas = Image.new('L', (FONT_SIZE * 2, height), 0)
    ImageDraw.Draw(canvas).text((FONT_SIZE // 2, 0), ch, font=font, fill=255)
    pixels = canvas.load()
    columns = [x for x in range(canvas.width) if any(pixels[x, y] >= 128 for y in range(height))]
    left, right = min(columns), max(columns)
    glyphs[ch] = [''.join('#' if pixels[x, y] >= 128 else '.' for x in range(left, right + 1))
                  for y in range(height)]

# drop the blank rows shared by every glyph (above the tallest and below the deepest one)
top = min(next(i for i, row in enumerate(rows) if '#' in row) for rows in glyphs.values())
bottom = max(max(i for i, row in enumerate(rows) if '#' in row) for rows in glyphs.values())
glyphs = {ch: rows[top:bottom + 1] for ch, rows in glyphs.items()}


def pack(rows):
    width = len(rows[0])
    digits = (width + 3) // 4
    bits = ''.join('%0*x' % (digits, int(row.replace('.', '0').replace('#', '1').ljust(digits * 4, '0'), 2)) for row in rows)
    return {'w': width, 'bits': bits}


with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({
        'source': '%s %s %dpx' % (font.getname() + (FONT_SIZE,)),
        'height': bottom - top + 1,
        'alphabets': ALPHABETS,
        'glyphs': {ch: pack(rows) for ch, rows in glyphs.items()},
    }, f, ensure_ascii=False, separators=(',', ':'))
    f.write('\n')
print('wrote %s: %d glyphs, %d px high' % (os.path.normpath(OUT), len(glyphs), bottom - top + 1))
