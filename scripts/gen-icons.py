"""Generate Penny Farthing icons — clean PF monogram.

Design: tight, confident sans-serif 'PF' reversed out of a
slate-teal square. Modern, professional, no ornamentation.
"""

from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT_DIR, exist_ok=True)

TEAL_LIGHT = (15, 118, 110)       # #0f766e
TEAL_DARK  = (17, 94, 89)         # slight shadow tone for depth
WHITE      = (255, 255, 255)
INK        = (17, 20, 24)


def make(size, padding_pct=0.0):
    img = Image.new('RGBA', (size, size), TEAL_LIGHT + (255,))
    draw = ImageDraw.Draw(img)

    # Soft inner gradient — a flat-ish modern depth cue, not a dramatic vignette
    overlay = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    # Faint darker lower-right for subtle dimensionality
    od.rectangle([0, size // 2, size, size], fill=(0, 0, 0, 20))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    # Find a modern sans-serif font
    font = None
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    ]
    fsize = int(size * 0.55)
    for c in candidates:
        if os.path.exists(c):
            try:
                font = ImageFont.truetype(c, fsize)
                break
            except Exception:
                pass
    if font is None:
        font = ImageFont.load_default()

    text = "PF"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1] - int(size * 0.02)

    draw.text((x, y), text, font=font, fill=WHITE + (255,))

    # A small horizontal accent line underneath, subtle
    line_y = int(size * 0.78)
    line_w = int(size * 0.18)
    line_h = max(2, int(size / 96))
    draw.rectangle(
        [((size - line_w) // 2, line_y),
         ((size + line_w) // 2, line_y + line_h)],
        fill=WHITE + (200,),
    )

    return img


for s in (192, 512):
    img = make(s, padding_pct=0.0)
    path = os.path.join(OUT_DIR, f'icon-{s}.png')
    img.save(path, 'PNG')
    print(f'wrote {path}')

# Maskable — PWA spec wants 10%+ safe area inside the visible shape.
# Since we use a solid background fill, the entire canvas is the shape,
# so maskable is identical for us. Still emit the files for the manifest.
for s in (192, 512):
    img = make(s, padding_pct=0.0)
    path = os.path.join(OUT_DIR, f'icon-{s}-maskable.png')
    img.save(path, 'PNG')
    print(f'wrote {path}')
