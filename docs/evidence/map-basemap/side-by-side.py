# Before/after pictures of the basemap fix (ADR-030) from the screenshots of tests/acceptance/map-basemap.mjs:
# the same view of «مساحة التمركز» (map element only) on the previous build (image overlay) and on the new one (tiles).
# Usage: python -I docs/evidence/map-basemap/side-by-side.py   -> docs/evidence/map-basemap/side-by-side/*.jpg
import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'side-by-side'
OUT.mkdir(exist_ok=True)
before = json.loads((ROOT / 'before' / 'results.json').read_text(encoding='utf-8'))
after = json.loads((ROOT / 'after' / 'results.json').read_text(encoding='utf-8'))


def font(size):
    for name in ('segoeui.ttf', 'arial.ttf', 'DejaVuSans.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def frames(run, step):
    f = (run or {}).get('frames', {}).get('z+%d' % step)
    return 'p95 %s ms, worst %s ms, %s frames > 50 ms' % (f['p95'], f['max'], f['over50']) if f else ''


made = []
for a in after['runs']:
    b = next((x for x in before['runs'] if x['size'] == a['size']), None)
    for step in (4, 6):
        name = '%s-z%d' % (a['size'], step)
        pb, pa = ROOT / 'before' / (name + '-map.png'), ROOT / 'after' / (name + '-map.png')
        if not (pb.exists() and pa.exists()):
            continue
        ib, ia = Image.open(pb).convert('RGB'), Image.open(pa).convert('RGB')
        scale = min(1.0, 900 / max(ib.width, 1))
        ib = ib.resize((round(ib.width * scale), round(ib.height * scale)))
        ia = ia.resize((round(ia.width * scale), round(ia.height * scale)))
        zoom = next((v['view'][0] for v in a['views'] if v['step'] == step), '?')
        head = 92
        img = Image.new('RGB', (ib.width + ia.width + 30, max(ib.height, ia.height) + head + 10), 'white')
        d = ImageDraw.Draw(img)
        d.text((10, 6), '%s, zoom %s - same view, before (left) and after (right)' % (a['size'], zoom), fill='black', font=font(20))
        d.text((10, 36), 'before: image overlay', fill='#a3594f', font=font(15))
        d.text((10, 58), frames(b, step), fill='#a3594f', font=font(14))
        d.text((ib.width + 20, 36), 'after: vector tiles', fill='#0d5d4e', font=font(15))
        d.text((ib.width + 20, 58), frames(a, step), fill='#0d5d4e', font=font(14))
        img.paste(ib, (10, head))
        img.paste(ia, (ib.width + 20, head))
        img.save(OUT / (name + '.jpg'), quality=86)
        made.append(name)
print('\n'.join(made))
