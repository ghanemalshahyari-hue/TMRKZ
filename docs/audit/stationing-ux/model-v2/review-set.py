"""The small final review set (owner brief D, 3 Nov 2026; 17 after correction A6): composite images, each two or three
screenshots of the model-run.mjs evidence side by side at a common height. Captions are in English to avoid Arabic
shaping in Pillow; the report names each image in Arabic.
Usage: python docs/audit/stationing-ux/model-v2/review-set.py [17 ...]   (numbers limit the build to those images)
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "screenshots"
OUT = HERE / "review"
HEIGHT, GAP, HEAD, MAX_WIDTH = 900, 20, 44, 2600

SET = [
    ("01-current-stationing", "Current stationing", ["1366/01-current-stationing", "390/01-current-stationing"]),
    ("02-associated-areas", "Associated primary / alternative areas", ["1366/02-associated-areas", "390/02-associated-areas"]),
    ("03-whole-unit-relocation", "Whole-unit permanent re-stationing", ["1366/03-whole-permanent", "390/03-whole-permanent"]),
    ("04-partial-unit-temporary", "Partial-unit temporary re-stationing", ["1366/05-partial-scope", "390/05-partial-scope"]),
    ("05-polygon-drag", "Actual polygon drag: before / after", ["1366/B1-1-primary-before", "1366/B1-2-primary-moved"]),
    ("06-current-primary-alternative", "Current -> primary -> alternative", ["1366/06-current-primary-alternative", "390/06-current-primary-alternative"]),
    ("07-fallback-to-alternative", "Primary not accepted -> switch dialog -> alternative", ["1366/07a-primary-not-accepted", "1366/07-dialog-switch", "1366/07b-alternative-under-review"]),
    ("08-approved-not-activated", "Approved, not activated: approver blocked / independent activator", ["1366/08a-final-approver-blocked", "1366/08b-independent-activator"]),
    ("09-temporary-active", "Temporary active over the kept permanent stationing", ["1366/10-temporary-active", "390/10-temporary-active"]),
    ("10-extension", "Extension approved not activated -> dialog -> activated", ["1366/11a-extension-approved-not-activated", "1366/11-dialog-extension", "1366/11b-extension-activated"]),
    ("11-cancellation-pending", "Cancellation pending blocks activation", ["1366/15-cancellation-pending-blocks-activation", "390/15-cancellation-pending-blocks-activation"]),
    ("12-cancel-before-start", "Activated temporary cancelled before its start", ["1366/19-dialog-cancel-before-start", "1366/19a-cancelled-before-start", "1366/19b-organisation-after-cancel-before-start"]),
    ("13-atomic-transition", "Temporary -> permanent: one atomic operation", ["1366/14-dialog-atomic", "1366/14a-atomic-transition-request", "1366/14b-atomic-transition-organisation"]),
    ("14-conflicts-and-scope", "Covered child: no self-conflict / uncovered unit: blocked / other org: exception", ["1366/20-covered-child-no-self-conflict", "1366/21-uncovered-unit-blocked", "1366/22b-exception-approved-audited"]),
    ("15-parent-selected-units", "Scenario 18: parent with selected units away (collapsed / revealed)", ["1366/18a-parent-units-collapsed", "1366/18b-parent-units-expanded", "390/18b-parent-units-expanded"]),
    ("16-mobile-polygon-editing", "Phone: drag in the collapsed sheet / expanded sheet", ["390/B1-2-primary-moved", "390/B1-3-primary-invalid", "390/B1-5-sheet-expanded"]),
    # owner correction A6: a start cancellation still pending at the planned start holds the start
    ("17-start-held", "Start held by a pending cancellation / rejected later: effective from the decision / window expired", ["1366/23a-start-held", "1366/23b-rejected-after-start-effective-from-decision", "1366/24b-window-expired-without-start"]),
]


def font(size):
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    OUT.mkdir(exist_ok=True)
    f, small = font(24), font(18)
    only = set(sys.argv[1:])
    built = 0
    for name, title, parts in SET:
        if only and name.split("-", 1)[0] not in only:
            continue
        built += 1
        imgs = []
        for p in parts:
            im = Image.open(SHOTS / (p + ".png")).convert("RGB")
            imgs.append((p, im.resize((round(im.width * HEIGHT / im.height), HEIGHT), Image.LANCZOS)))
        width = sum(im.width for _, im in imgs) + GAP * (len(imgs) - 1)
        scale = min(1.0, MAX_WIDTH / width)
        if scale < 1:
            imgs = [(p, im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)) for p, im in imgs]
            width = sum(im.width for _, im in imgs) + GAP * (len(imgs) - 1)
        h = HEAD * 2 + max(im.height for _, im in imgs)
        out = Image.new("RGB", (width, h), (238, 242, 241))
        d = ImageDraw.Draw(out)
        d.rectangle([0, 0, width, HEAD - 4], fill=(22, 50, 79))
        d.text((14, 8), name.split("-", 1)[0] + "  " + title, font=f, fill="white")
        x = 0
        for p, im in imgs:
            d.text((x + 8, HEAD + 6), p.replace("/", " px  ·  "), font=small, fill=(60, 70, 74))
            out.paste(im, (x, HEAD * 2))
            x += im.width + GAP
        out.save(OUT / (name + ".jpg"), quality=86, optimize=True)
    print(f"{built} of {len(SET)} review images built in {OUT}")


if __name__ == "__main__":
    main()
