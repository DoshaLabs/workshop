# The README banner's words ("workshop" and a tagline) in Nunito, the app's interface face (OFL,
# assets/fonts/), outlined as SVG paths: GitHub shows an SVG through <img>, where no web font loads.
#
# Run once, by hand, when the word or its weight changes. Its output (scripts/wordmark.json) is
# committed and read by scripts/knot-svg.mjs, so the banner itself needs no Python. Needs fontTools
# and brotli (for the .woff2), in a throwaway virtualenv:
#   python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
#   /tmp/ft/bin/python scripts/wordmark.py
import json
import os

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# (text, weight, tracking in units per em). Heavy Nunito sets a little loose for a wordmark.
RUNS = {
    "word": ("workshop", 800, -12),
    "tagline": ("Claude Code sessions in one window, and tiles anyone can build", 600, 4),
}

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def num(v):
    return ("%.1f" % v).rstrip("0").rstrip(".")


def outline(text, weight, track):
    font = instantiateVariableFont(TTFont(os.path.join(root, "assets", "fonts", "nunito.woff2")), {"wght": weight})
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"]
    pen = SVGPathPen(glyphs, ntos=num)
    x = 0
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        # y is up in the font and down in SVG: flip about the baseline.
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        x += hmtx[name][0] + (track if i < len(text) - 1 else 0)
    os2 = font["OS/2"]
    return {
        "text": text,
        "weight": weight,
        "unitsPerEm": font["head"].unitsPerEm,
        "advance": x,
        "ascender": os2.sTypoAscender,
        "descender": os2.sTypoDescender,
        "capHeight": getattr(os2, "sCapHeight", 0),
        "xHeight": getattr(os2, "sxHeight", 0),
        "d": pen.getCommands(),
    }


out = {"font": "Nunito", **{k: outline(*v) for k, v in RUNS.items()}}
with open(os.path.join(root, "scripts", "wordmark.json"), "w") as f:
    json.dump(out, f)
    f.write("\n")
for k in RUNS:
    print(k, "advance", out[k]["advance"], "path chars", len(out[k]["d"]))
