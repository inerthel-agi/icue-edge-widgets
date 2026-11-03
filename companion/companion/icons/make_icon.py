# Generates icons/icon.ico (16/32/48/256 px PNG frames), icons/icon.svg, icons/icon-256.png and
# icons/mark.svg with the stdlib only.
# The "e-strip": a lowercase e whose crossbar runs out of the bowl as a long strip, the Edge screen.
# One colour on a black tile; mark.svg is the bare mark in currentColor for the app's own pages.
import math, struct, zlib, pathlib

TILE, INK = (15, 18, 20), (242, 243, 237)
# (bowl centre x, outer radius, inner radius, bar height, strip end x, aperture end angle) on a 256 canvas,
# centre y 128. The bowl opens from the bar's lower edge to the aperture angle (degrees, clockwise from +x).
MASTER = (100, 72, 46, 26, 240, 45)
SMALL = (96, 78, 40, 38, 244, 60)  # thicker strokes and a wider opening, for 16 and 32 px
SCALE = {MASTER: 0.76, SMALL: 0.82}  # size of the mark on the tile
SS = 4  # samples per pixel side, for smooth edges at 16 px

def shift(m):
    cx, R, r, h, end, _ = m
    return 128 - (cx - R + end) / 2  # centres the mark horizontally

def in_mark(x, y, m):
    cx, R, r, h, end, g1 = m
    dx, dy = x - cx, y - 128
    d = math.hypot(dx, dy)
    a = math.degrees(math.atan2(dy, dx)) % 360
    g0 = math.degrees(math.asin(h / 2 / R))
    if r <= d <= R and not (g0 < a < g1):
        return True
    # Crossbar and strip: one bar from inside the bowl to the strip end, round right end.
    x0, hh = cx - r - 6, h / 2
    if not (x0 <= x <= end and abs(dy) <= hh):
        return False
    return x <= end - hh or (x - (end - hh)) ** 2 + dy ** 2 <= hh * hh

def in_tile(x, y):
    q = lambda v: max(8 + 56 - v, 0, v - (248 - 56))
    return 8 <= x <= 248 and 8 <= y <= 248 and q(x) ** 2 + q(y) ** 2 <= 56 * 56

def colour_at(x, y, m):
    if not in_tile(x, y):
        return None
    s, sh = SCALE[m], shift(m)
    return INK if in_mark((x - 128) / s + 128 - sh, (y - 128) / s + 128, m) else TILE

def pixel(col, row, n, m):
    acc, alpha = [0, 0, 0], 0
    for sy in range(SS):
        for sx in range(SS):
            c = colour_at((col + (sx + 0.5) / SS) * 256 / n, (row + (sy + 0.5) / SS) * 256 / n, m)
            if c:
                alpha += 1
                for i in range(3):
                    acc[i] += c[i]
    if not alpha:
        return (0, 0, 0, 0)
    return (*(round(v / alpha) for v in acc), round(255 * alpha / SS ** 2))

def png(n):
    m = SMALL if n <= 32 else MASTER
    raw = b"".join(b"\0" + b"".join(bytes(pixel(x, y, n, m)) for x in range(n)) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def mark_paths(m):
    cx, R, r, h, end, g1 = m
    g0 = math.degrees(math.asin(h / 2 / R))
    p = lambda rad, a: "%.1f %.1f" % (cx + rad * math.cos(math.radians(a)), 128 + rad * math.sin(math.radians(a)))
    bowl = f'<path d="M{p(R, g1)}A{R} {R} 0 1 1 {p(R, g0)}L{p(r, g0)}A{r} {r} 0 1 0 {p(r, g1)}Z"/>'
    x0 = cx - r - 6
    bar = f'<rect x="{x0}" y="{128 - h / 2}" width="{end - x0}" height="{h}" rx="{h / 2}"/>'
    return bowl + bar

here = pathlib.Path(__file__).parent
sizes = [16, 32, 48, 256]
images = [png(n) for n in sizes]
header = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries = b""
for n, data in zip(sizes, images):
    entries += struct.pack("<BBBBHHII", n % 256, n % 256, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
ico = here / "icon.ico"
ico.write_bytes(header + entries + b"".join(images))
(here / "icon-256.png").write_bytes(images[-1])

hexc = lambda c: "#%02x%02x%02x" % c
s, sh = SCALE[MASTER], shift(MASTER)
(here / "icon.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">\n  <title>iCUE Edge Companion</title>\n'
    f'  <rect x="8" y="8" width="240" height="240" rx="56" fill="{hexc(TILE)}"/>\n'
    f'  <g fill="{hexc(INK)}" transform="translate(128 128) scale({s}) translate(-128 -128) translate({sh:.1f} 0)">{mark_paths(MASTER)}</g>\n</svg>\n',
    encoding="utf-8")
(here / "mark.svg").write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><g transform="translate({sh:.1f} 0)">{mark_paths(MASTER)}</g></svg>\n',
    encoding="utf-8")
print(ico, ico.stat().st_size, "bytes")
