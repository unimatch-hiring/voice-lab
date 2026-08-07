#!/usr/bin/env python3
"""Builds the mouth sprites in public/face/ from the generated frames.

Two non-obvious requirements, each of which cost real debugging time:

1. Outside the mouth region every frame must be BIT-IDENTICAL. The generator
   repaints the whole image, so fur, suit and background drift and the entire
   character shimmers on a viseme change. Fixed by compositing: one background
   plus the mouth region pasted through a blurred mask.

2. The palette is computed ONCE for all frames. A per-frame adaptive palette
   drifts by a few values and the "identical" background starts flickering again.

Verified by src/scene/sprites.test.ts.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vl-face/racoon"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "face")

WORK = 768          # composite resolution
FINAL = 384         # what lands in public: the window renders at ~400px
COLORS = 220

# Mouth region as a fraction of the frame — measured off a grid on the reference.
X0, X1, Y0, Y1 = 0.34, 0.64, 0.455, 0.615

VISEMES = ["MBP", "AI", "E", "O", "U", "FV", "L", "WQ"]


def mouth_mask(size: int) -> Image.Image:
    box = (int(X0 * size), int(Y0 * size), int(X1 * size), int(Y1 * size))
    blur = size * 0.022
    pad = int(blur * 1.5)
    mask = Image.new("L", (size, size), 0)
    # The ellipse is shrunk by the blur radius, otherwise the mask spreads past the
    # box and drags along background that has to stay untouched.
    ImageDraw.Draw(mask).ellipse(
        (box[0] + pad, box[1] + pad, box[2] - pad, box[3] - pad), fill=255
    )
    mask = mask.filter(ImageFilter.GaussianBlur(blur))

    hard = Image.new("L", (size, size), 0)
    hard.paste(255, box)
    return Image.composite(mask, Image.new("L", (size, size), 0), hard)


def main() -> int:
    base_path = os.path.join(SRC, "base.png")
    if not os.path.exists(base_path):
        print(f"missing reference: {base_path}", file=sys.stderr)
        return 1

    base = Image.open(base_path).convert("RGB").resize((WORK, WORK), Image.LANCZOS)
    mask = mouth_mask(WORK)

    frames = {"rest": base.copy()}
    for name in VISEMES:
        # Three opening phases per viseme: q (quarter) -> h (half) -> full. With
        # only two points the amplitude step between neighbouring frames is large
        # enough that the crossfade reads as a jolt.
        for suffix in ("", "h", "q"):
            path = os.path.join(SRC, f"{name}{suffix}.png")
            if not os.path.exists(path):
                print(f"skipping (no frame): {name}{suffix}")
                continue
            src = Image.open(path).convert("RGB").resize((WORK, WORK), Image.LANCZOS)
            frames[f"{name}{suffix}"] = Image.composite(src, base, mask)

    # Order phases by MEASURED openness rather than by filename: the generator does
    # not always hit the requested amplitude (on stops like /f/ and /m/ the quarter
    # and the half come out nearly equal and sometimes swap). Keeping filename order
    # would open the mouth wider and then snap it shut mid-viseme — a visible jolt.
    def openness(img: Image.Image) -> float:
        ref = frames["rest"].convert("L").crop(
            (int(0.36 * WORK), int(0.46 * WORK), int(0.64 * WORK), int(0.62 * WORK))
        )
        cur = img.convert("L").crop(
            (int(0.36 * WORK), int(0.46 * WORK), int(0.64 * WORK), int(0.62 * WORK))
        )
        dark = sum(
            1 for a, b in zip(ref.getdata(), cur.getdata()) if a - b > 25
        )
        return dark / (ref.width * ref.height)

    for name in VISEMES:
        phases = [f"{name}q", f"{name}h", name]
        if not all(p in frames for p in phases):
            continue
        by_open = sorted(phases, key=lambda p: openness(frames[p]))
        if by_open != phases:
            print(f"  {name}: phases reordered by measurement -> {' < '.join(by_open)}")
            reordered = {slot: frames[src] for slot, src in zip(phases, by_open)}
            frames.update(reordered)

    order = list(frames)
    small = {n: frames[n].resize((FINAL, FINAL), Image.LANCZOS) for n in order}

    # Outside the mouth, take pixels FROM rest rather than each frame's own. The
    # composite already made the background equal, but quantising to a palette gave
    # neighbouring shades different indices and the background drifted by tens of
    # levels again — the whole face shimmered on a viseme change. Here drift is
    # impossible by construction.
    keep = Image.new("L", (FINAL, FINAL), 0)
    keep.paste(
        255,
        (
            int(X0 * FINAL),
            int(Y0 * FINAL),
            int(X1 * FINAL),
            int(Y1 * FINAL),
        ),
    )
    for name in order:
        if name != "rest":
            small[name] = Image.composite(small[name], small["rest"], keep)

    # One shared palette for every frame: the same colour table in all files.
    sheet = Image.new("RGB", (FINAL, FINAL * len(order)))
    for i, name in enumerate(order):
        sheet.paste(small[name], (0, i * FINAL))
    palette = sheet.quantize(colors=COLORS, method=Image.MEDIANCUT)

    os.makedirs(OUT, exist_ok=True)
    total = 0
    for name in order:
        out = small[name].quantize(palette=palette, dither=Image.NONE)
        path = os.path.join(OUT, f"{name}.png")
        out.save(path, optimize=True)
        total += os.path.getsize(path)
        print(f"  {name:6} {os.path.getsize(path) / 1024:6.1f} KB")

    print(f"total: {total / 1024 / 1024:.2f} MB across {len(order)} frames")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
