"""Side-by-side images of the comparison: the current page and the prototype, same size and scenario, one picture each.

Reads screenshots/{current,prototype}/<size>-NN-<scenario>.png written by compare-run.mjs and writes
side-by-side/<size>-NN-<scenario>.jpg. Headers are in English to avoid Arabic shaping in Pillow; the report names each
picture in Arabic. Usage: python docs/audit/stationing-ux/redesign/side-by-side.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "screenshots"
OUT = HERE / "side-by-side"
MAX_WIDTH = 2400  # the two pictures together, before the gap
GAP, HEAD = 24, 46


def font(size):
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    OUT.mkdir(exist_ok=True)
    f = font(22)
    made = 0
    for cur in sorted((SHOTS / "current").glob("*.png")):
        proto = SHOTS / "prototype" / cur.name
        if not proto.exists():
            continue
        a, b = Image.open(cur).convert("RGB"), Image.open(proto).convert("RGB")
        scale = min(1.0, MAX_WIDTH / (a.width + b.width))
        if scale < 1:
            a = a.resize((round(a.width * scale), round(a.height * scale)), Image.LANCZOS)
            b = b.resize((round(b.width * scale), round(b.height * scale)), Image.LANCZOS)
        w, h = a.width + GAP + b.width, HEAD + max(a.height, b.height)
        img = Image.new("RGB", (w, h), (238, 242, 241))
        d = ImageDraw.Draw(img)
        size, _, scenario = cur.stem.split("-", 2)
        label = f"{size} px  ·  {scenario}"
        d.rectangle([0, 0, a.width, HEAD - 6], fill=(92, 104, 108))
        d.rectangle([a.width + GAP, 0, w, HEAD - 6], fill=(19, 124, 104))
        d.text((12, 9), "CURRENT  ·  " + label, font=f, fill="white")
        d.text((a.width + GAP + 12, 9), "PROPOSED PROTOTYPE  ·  " + label, font=f, fill="white")
        img.paste(a, (0, HEAD))
        img.paste(b, (a.width + GAP, HEAD))
        img.save(OUT / (cur.stem + ".jpg"), quality=85, optimize=True)
        made += 1
    print(f"{made} side-by-side images in {OUT}")


if __name__ == "__main__":
    main()
