"""Generates frontend/src/styles/theme.generated.css: the fixed colours of the stylesheets, for the light and dark themes.

prototype.css stays verbatim and the screens keep their own files, so their literal colours are overridden here rather than
edited: a surface follows the theme, text follows the theme, and a saturated colour that means something (status, map symbols,
a filled button) stays. Light is the sand of the sign-in page, so its greys warm up and the teal accent becomes brown. Colours held in variables are set by hand in theme.css. Run after changing a stylesheet:

    python3 ops/tools/gen-theme.py
"""
import colorsys
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src"
SOURCES = ["styles/prototype.css", "styles/app.css", "styles/map.css", "styles/shell.css", "styles/stationing.css",
           "pages/requests.css", "pages/restationing.css", "pages/workflowStudio.css", "components/workspace/terrain3d.css"]
COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b")
TEXT_PROPS = {"color", "fill", "stroke", "caret-color", "-webkit-text-fill-color"}
SURFACE = ("background", "border", "outline", "box-shadow")
ACCENTS = ("--accent", "--green", "--red", "--orange", "--blue", "--tz-teal", "--tz-amber", "--tz-red", "--tz-green", "--tz-cyan", "--tz-coral")


WARM = 0.11  # the hue of the sand
BROWN = 0.083  # the hue of its brown button


def is_teal(h, s):
    return s > 0.3 and 0.44 <= h <= 0.52


def parse(token):
    t = token.lower()
    if t == "white":
        return 255, 255, 255, 1.0
    if t == "black":
        return 0, 0, 0, 1.0
    if t.startswith("#"):
        h = t[1:]
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a
    n = [float(x) for x in re.findall(r"[\d.]+", t)]
    return int(n[0]), int(n[1]), int(n[2]), (n[3] if len(n) > 3 else 1.0)


def show(r, g, b, a):
    r, g, b = [max(0, min(255, round(x))) for x in (r, g, b)]
    return "#%02x%02x%02x" % (r, g, b) if a >= 0.999 else "rgba(%d, %d, %d, %s)" % (r, g, b, round(a, 3))


def hls(c):
    return colorsys.rgb_to_hls(c[0] / 255, c[1] / 255, c[2] / 255)


def make(h, l, s, a):
    r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), max(0, min(1, s)))
    return show(r * 255, g * 255, b * 255, a)


def surface(theme, token, prop):
    c = parse(token)
    a = c[3]
    h, l, s = hls(c)
    if theme == "dark":
        if l > 0.82:
            if a < 0.6:  # a light veil: a faint white over a dark surface
                return show(255, 255, 255, min(a, 0.08))
            if s > 0.25 and l < 0.93:  # a tinted pastel keeps its hue
                return make(h, 0.17, 0.38, a)
            return make(0.57, 0.125 + (1 - l) * 0.45, 0.52, a)
        if l > 0.55 and s < 0.35:  # a neutral line
            return make(h, 0.3, 0.2, a)
        return None
    # light is the sand of the sign-in page: greys warm up, and the teal accent becomes its brown
    if a < 0.6 and l > 0.8:  # a white veil over a dark surface becomes a warm dark one
        return show(74, 59, 34, a)
    if a < 0.6 and l <= 0.35 and "shadow" in prop:
        return show(74, 59, 34, a * 0.4)
    if a < 0.6 and s > 0.15 and l > 0.45:  # a line or a tint of a bright colour
        return show(184, 151, 90, min(1, a * 1.3)) if is_teal(h, s) else make(h, 0.35, s, a)
    if l < 0.3 and a > 0.6 and s < 0.75:  # a dark surface
        return make(WARM, 0.985 - l * 0.28, 0.45, a)
    if a > 0.6 and is_teal(h, s) and 0.2 < l < 0.7:
        return make(BROWN, 0.36, 0.53, a)
    if a > 0.6 and l >= 0.995:
        return "#fffcf6"
    if a > 0.6 and l > 0.7 and s < 0.42:  # a cool or greenish pale surface or line
        return make(WARM, l, max(s, 0.35), a)
    return None


def text(theme, token):
    c = parse(token)
    a = c[3]
    h, l, s = hls(c)
    if theme == "dark":
        if l >= 0.5:
            return None
        if s > 0.3:
            return make(h, max(0.68, 1 - l), min(s, 0.65), a)
        return make(0.55, 1 - l * 0.7, 0.3, a)
    if is_teal(h, s):
        return make(BROWN, 0.31, 0.55, a)
    if s < 0.35:  # greys and grey-greens warm up, dark enough to read
        return make(WARM, min(l, 0.34) if l <= 0.62 else 0.72 - l * 0.5, min(s, 0.2) if l <= 0.62 else 0.22, a)
    if l > 0.62 and l < 0.9:
        return make(h, 0.3, min(s, 0.75), a)
    if l >= 0.9:
        return make(WARM, 0.25, 0.22, a)
    return None


def remap(value, theme, prop, on_accent):
    def one(m):
        token = m.group(0)
        if prop in TEXT_PROPS:
            if on_accent:
                return "#04221c" if theme == "dark" else "#ffffff"
            out = text(theme, token)
        else:
            out = surface(theme, token, prop)
        return out if out else token
    return COLOR.sub(one, value)


def split_selectors(s):
    parts, depth, cur = [], 0, ""
    for ch in s:
        depth += ch in "(["
        depth -= ch in ")]"
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def blocks(css):
    """Top-level items as (prelude, body), matching braces."""
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0:
            return
        depth, k = 1, j + 1
        while k < n and depth:
            depth += (css[k] == "{") - (css[k] == "}")
            k += 1
        yield css[i:j].strip(), css[j + 1:k - 1]
        i = k


def rules(css, theme):
    out = []
    for prelude, body in blocks(css):
        if prelude.startswith("@media") or prelude.startswith("@supports"):
            inner = rules(body, theme)
            if inner:
                out.append(prelude + " {\n" + "\n".join("  " + x for x in inner) + "\n}")
            continue
        if prelude.startswith("@") or "{" in body:
            continue
        selectors = [s for s in split_selectors(prelude) if s not in (":root",)]
        if not selectors:
            continue
        decls = [d.strip() for d in re.split(r";(?![^(]*\))", body) if ":" in d]
        accent = any(d.split(":", 1)[0].strip().startswith("background") and any("var(" + a + ")" in d or "var(" + a + "-" in d for a in ACCENTS)
                     and "-soft" not in d for d in decls)
        # text on its own filled colour stays
        filled = False
        for d in decls:
            if d.split(":", 1)[0].strip().lower().startswith("background"):
                for token in COLOR.findall(d.split(":", 1)[1]):
                    h0, l0, s0 = hls(parse(token))
                    filled = filled or (parse(token)[3] > 0.8 and s0 > 0.3 and 0.18 < l0 < 0.66)
        changed = []
        for d in decls:
            prop, value = d.split(":", 1)
            prop = prop.strip().lower()
            if prop.startswith("--") or not (prop in TEXT_PROPS or prop.startswith(SURFACE)):
                continue
            if filled and not accent and prop in TEXT_PROPS:
                continue
            mapped = remap(value.strip(), theme, prop, accent and prop == "color")
            if mapped != value.strip():
                changed.append(prop + ": " + mapped)
        if changed:
            head = ", ".join(':root[data-theme="%s"] %s' % (theme, s) for s in selectors)
            out.append(head + " { " + "; ".join(changed) + "; }")
    return out


def main():
    out = ["/* Generated by ops/tools/gen-theme.py. Do not edit: change the sources or theme.css. */"]
    for name in SOURCES:
        css = re.sub(r"/\*.*?\*/", "", (ROOT / name).read_text(encoding="utf8"), flags=re.S)
        for theme in ("light", "dark"):
            got = rules(css, theme)
            if got:
                out.append("\n/* %s — %s */" % (name, theme))
                out.extend(got)
    (ROOT / "styles" / "theme.generated.css").write_text("\n".join(out) + "\n", encoding="utf8")
    print(sum(1 for line in out if "{" in line), "rules")


main()
