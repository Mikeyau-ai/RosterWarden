"""Generate the PWA icon set from the RosterWarden mark.

A Sixth Day Studios teal line-art shield holding a calendar, glowing on the
studio near-black, rendered at the sizes a browser and home-screen install ask for. The maskable variant carries extra
padding so Android can crop it to a circle without clipping the shield.

Run after changing the artwork:  python make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ICONS = Path(__file__).resolve().parent / "icons"

BG = (18, 18, 18)          # #121212 - Sixth Day Studios near-black tile
TEAL = (44, 196, 168)      # #2cc4a8 - the studio teal-cyan accent
DIM = (44, 196, 168, 90)   # faded teal for the outlined (unrostered) day cells

#: Day cells drawn solid teal ("rostered") in the 3x2 grid, as (col, row).
FILLED = {(0, 0), (2, 0), (1, 1)}


def _bezier(p0, p1, p2, p3, n=40):
    """Sample a cubic bezier curve into n+1 points."""
    pts = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3
        pts.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return pts


def _shield_points():
    """Closed outline of the shield, authored on a 1024 grid."""
    pts = [(512, 120), (850, 245), (850, 520)]
    pts += _bezier((850, 520), (850, 730), (700, 860), (512, 920))[1:]
    pts += _bezier((512, 920), (324, 860), (174, 730), (174, 520))[1:]
    pts += [(174, 245), (512, 120)]
    return pts


def _strokes(size: int, u: float, ox: float, glow: bool) -> Image.Image:
    """Draw the teal line-art (shield + calendar) on a transparent layer."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def P(x, y):
        """Map an authored coordinate into the padded box."""
        return (ox + x * u, ox + y * u)

    def line(pts, w):
        """Polyline with rounded joints and caps, width w in authored units."""
        pts = [P(*p) for p in pts]
        d.line(pts, fill=TEAL, width=max(1, round(w * u)), joint="curve")
        r = w * u / 2
        for x, y in pts:                   # round every vertex so curves have no gaps
            d.ellipse([x - r, y - r, x + r, y + r], fill=TEAL)

    # Shield outline: thick so it survives 16px.
    line(_shield_points(), 52)

    # Calendar page, header band and binder rings.
    l, t, r_, b = 322, 330, 702, 720
    d.rounded_rectangle([*P(l, t), *P(r_, b)], radius=int(40 * u),
                        outline=TEAL, width=max(1, round(34 * u)))
    d.rectangle([*P(l, t), *P(r_, t + 90)], fill=TEAL)
    for rx in (430, 594):
        d.rounded_rectangle([*P(rx - 17, 285), *P(rx + 17, 375)],
                            radius=int(17 * u), fill=TEAL)

    # 3x2 grid of day cells; the filled ones are the rostered days. Small
    # sizes (glow pass / favicon) keep the same layout, just fewer details.
    cw, gap = 80, 26
    gx0, gy0 = l + 38, t + 90 + 50
    for row in range(2):
        for col in range(3):
            x, y = gx0 + col * (cw + gap), gy0 + row * (cw + gap)
            box = [*P(x, y), *P(x + cw, y + cw)]
            if (col, row) in FILLED:
                d.rounded_rectangle(box, radius=int(14 * u), fill=TEAL)
            elif not glow:
                d.rounded_rectangle(box, radius=int(14 * u), outline=DIM,
                                    width=max(1, round(10 * u)))
    return layer


def draw(size: int = 1024, pad: float = 0.0, rounded: bool = True) -> Image.Image:
    """Render the mark at `size`, insetting by `pad` (a fraction) for maskable use."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    inset = int(size * pad)
    box = size - 2 * inset
    u = box / 1024.0                       # geometry below is authored at 1024

    # Dark tile: rounded for "any" icons, full-bleed for maskable.
    if rounded:
        d.rounded_rectangle([inset, inset, inset + box - 1, inset + box - 1],
                            radius=int(180 * u), fill=BG)
    else:
        d.rectangle([0, 0, size, size], fill=BG)

    # Soft teal glow: blur a copy of the strokes and lay it under the crisp ones.
    strokes = _strokes(size, u, inset, glow=True)
    glow = strokes.filter(ImageFilter.GaussianBlur(max(1.0, 26 * u)))
    glow.putalpha(glow.getchannel("A").point(lambda a: int(a * 0.8)))
    img.alpha_composite(glow)
    img.alpha_composite(_strokes(size, u, inset, glow=False))
    return img


def main() -> int:
    """Write every icon the manifest and iOS reference."""
    ICONS.mkdir(exist_ok=True)
    master = draw()

    # Standard "any" icons plus the iOS touch icon.
    for size in (180, 192, 512):
        master.resize((size, size), Image.LANCZOS).save(ICONS / f"icon-{size}.png")

    # Maskable: padded and full-bleed so Android's circle crop keeps the art.
    maskable = draw(1024, pad=0.16, rounded=False)
    maskable.resize((512, 512), Image.LANCZOS).save(ICONS / "icon-512-maskable.png")

    # Favicon for the browser tab.
    frames = [master.resize((s, s), Image.LANCZOS) for s in (16, 32, 48)]
    frames[-1].save(ICONS / "favicon.ico", format="ICO",
                    sizes=[(16, 16), (32, 32), (48, 48)], append_images=frames[:-1])

    print("Wrote:", ", ".join(sorted(p.name for p in ICONS.iterdir())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
