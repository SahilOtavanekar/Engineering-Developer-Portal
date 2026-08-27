"""Generate the portal's browser and app icons from the Demand AI mark.

Run from the repo root:  python <this file>

The source is `packages/app/src/assets/demand-ai-logo.png` -- a 137x124 tile
with a uniform #12665E background and the mark in white line art. The mark is
cropped *with* its background and composited onto a canvas of the same colour,
which preserves the artwork's anti-aliased edges exactly; extracting an alpha
channel from white-on-teal would fringe them.

**Small sizes are optically tuned, not merely downscaled.** Thin white strokes
average towards the background when resampled, so a straight downscale of this
artwork is illegible below about 32px. Each size therefore gets its own crop
tightness and a stroke dilation applied at 8x supersample before the downscale.
Without it the 16px favicon is a smudge. The 180px and 192px icons take the
brand's own proportions untouched, because at that size the detail survives.
"""
import struct
from io import BytesIO

import numpy as np
from PIL import Image, ImageFilter

SRC = "packages/app/src/assets/demand-ai-logo.png"
OUT = "packages/app/public"
TEAL = (18, 102, 94)
MARK_BOX = (18, 14, 123, 111)  # measured white-mark bounds in the source
SUPERSAMPLE = 8

_src = Image.open(SRC).convert("RGB")
_mark = _src.crop(MARK_BOX)
_ASPECT = _mark.width / _mark.height


def _whiteness(im: Image.Image) -> np.ndarray:
    """How far each pixel is from the teal ground, 0 (teal) to 1 (white)."""
    a = np.asarray(im).astype(np.float32)
    teal = np.array(TEAL, dtype=np.float32)
    reach = float(np.linalg.norm(np.array([255.0, 255.0, 255.0]) - teal))
    return np.clip(np.linalg.norm(a - teal, axis=2) / reach, 0.0, 1.0)


def icon(size: int, frac: float, dilate: float = 0.0) -> Image.Image:
    """A square teal icon; `frac` is the mark's width as a fraction of `size`,
    `dilate` the stroke thickening in units of the final icon's pixels."""
    work = size * SUPERSAMPLE
    w = max(1, round(work * frac))
    h = max(1, round(w / _ASPECT))
    mask = _whiteness(_mark.resize((w, h), Image.LANCZOS))

    if dilate > 0:
        radius = max(1, int(round(dilate * SUPERSAMPLE)))
        thickened = Image.fromarray((mask * 255).astype(np.uint8)).filter(
            ImageFilter.MaxFilter(2 * radius + 1)
        )
        mask = np.asarray(thickened).astype(np.float32) / 255.0

    strokes = np.empty((h, w, 3), dtype=np.float32)
    for channel in range(3):
        strokes[:, :, channel] = TEAL[channel] + (255 - TEAL[channel]) * mask

    canvas = Image.new("RGB", (work, work), TEAL)
    canvas.paste(Image.fromarray(strokes.astype(np.uint8)),
                 ((work - w) // 2, (work - h) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


# Optical sizing: tighter crop and heavier strokes the smaller it gets.
# 0.766 is the mark's own share of the source tile's width.
RECIPES = {16: (0.90, 0.09), 32: (0.86, 0.045), 48: (0.82, 0.030),
           180: (0.766, 0.0), 192: (0.766, 0.0)}


def build(size: int) -> Image.Image:
    frac, dilate = RECIPES[size]
    return icon(size, frac, dilate)


def write_ico(path: str, sizes: list[int]) -> None:
    """Write a multi-resolution ICO with a separately tuned image per size.

    Pillow's own ICO writer downsamples a single source, which would throw away
    the per-size optical tuning above, so the container is assembled here. Each
    entry embeds a PNG, which every browser in use supports.
    """
    blobs = []
    for size in sizes:
        buf = BytesIO()
        build(size).save(buf, format="PNG", optimize=True)
        blobs.append(buf.getvalue())

    offset = 6 + 16 * len(blobs)
    out = bytearray(struct.pack("<HHH", 0, 1, len(blobs)))
    for size, blob in zip(sizes, blobs):
        out += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32,
                           len(blob), offset)
        offset += len(blob)
    for blob in blobs:
        out += blob
    with open(path, "wb") as fh:
        fh.write(bytes(out))


def write_mask_icon(path: str) -> None:
    """Safari's pinned-tab mask: a single-colour silhouette of the strokes.

    Safari ignores embedded rasters here, so the stroke mask is thresholded and
    emitted as merged rectangles. That is blocky at the source's 105x97, but a
    pinned tab renders at roughly 16px, where one source pixel is under a fifth
    of a device pixel.
    """
    mask = _whiteness(_mark) > 0.5
    h, w = mask.shape

    runs = []  # (x_start, x_end_exclusive, y)
    for y in range(h):
        x = 0
        while x < w:
            if mask[y, x]:
                start = x
                while x < w and mask[y, x]:
                    x += 1
                runs.append((start, x, y))
            else:
                x += 1

    # Merge runs with identical x-extents in consecutive rows into one rect.
    rects, open_runs = [], {}
    for start, end, y in runs:
        key = (start, end)
        if key in open_runs and open_runs[key][1] == y - 1:
            open_runs[key] = (open_runs[key][0], y)
        else:
            if key in open_runs:
                y0, y1 = open_runs[key]
                rects.append((start, y0, end - start, y1 - y0 + 1))
            open_runs[key] = (y, y)
    for (start, end), (y0, y1) in open_runs.items():
        rects.append((start, y0, end - start, y1 - y0 + 1))

    path_d = "".join(f"M{x} {y}h{rw}v{rh}h-{rw}z" for x, y, rw, rh in rects)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">'
        f'<path fill="#000" d="{path_d}"/></svg>'
    )
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(svg)
    return len(rects)


build(16).save(f"{OUT}/favicon-16x16.png", optimize=True)
build(32).save(f"{OUT}/favicon-32x32.png", optimize=True)
build(180).save(f"{OUT}/apple-touch-icon.png", optimize=True)
build(192).save(f"{OUT}/android-chrome-192x192.png", optimize=True)
write_ico(f"{OUT}/favicon.ico", [16, 32, 48])
n_rects = write_mask_icon(f"{OUT}/safari-pinned-tab.svg")

import os
print("written:")
for f in ["favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png",
          "android-chrome-192x192.png", "favicon.ico", "safari-pinned-tab.svg"]:
    p = f"{OUT}/{f}"
    extra = ""
    if f.endswith(".png"):
        extra = str(Image.open(p).size)
    if f.endswith(".svg"):
        extra = f"{n_rects} rects"
    print("  %-28s %6d bytes  %s" % (f, os.path.getsize(p), extra))

# Regenerate from the repo root, after replacing
# packages/app/src/assets/demand-ai-logo.png:
#
#   python packages/app/scripts/generate-icons.py
#
# Requires Pillow and NumPy. Nothing at build or run time depends on this
# script -- the icons it writes are committed.
