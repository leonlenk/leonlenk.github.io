"""Regenerate Latin webfonts with fonttools[woff] 4.65.0; retain full fallbacks."""
from pathlib import Path
import re

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
UNICODES = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-21FF,U+2212,U+2215,U+FEFF,U+FFFD"
for source in sorted((ROOT / "public/fonts").glob("*/*_wght.woff2")):
    subset.main([
        str(source),
        f"--output-file={source.with_name(source.stem + '-latin.woff2')}",
        "--flavor=woff2", f"--unicodes={UNICODES}", "--layout-features=*",
    ])

# Declare only supported non-Latin glyphs for the full fallback. A catch-all
# range would download entire fonts for symbols they do not even contain.
css_path = ROOT / "src/styles/global.css"
css = css_path.read_text()

def fallback_ranges(match):
    block = match.group()
    url = re.search(r'url\("([^\"]+)"\)', block)
    if not url:
        return block
    if "-latin.woff2" in url[1]:
        return re.sub(r"unicode-range:[^;]+;", f"unicode-range: {UNICODES};", block)
    source = ROOT / ("public" + url[1])
    compact = source.with_name(source.stem + "-latin.woff2")
    with TTFont(source) as full, TTFont(compact) as latin:
        codes = sorted(set(full.getBestCmap()) - set(latin.getBestCmap()))
    ranges = []
    for code in codes:
        if ranges and code == ranges[-1][1] + 1:
            ranges[-1][1] = code
        else:
            ranges.append([code, code])
    value = ", ".join(f"U+{a:X}" + (f"-{b:X}" if a != b else "") for a, b in ranges)
    return re.sub(r"unicode-range:[^;]+;", f"unicode-range: {value};", block)

css_path.write_text(re.sub(r"@font-face\s*\{[^}]+}", fallback_ranges, css))
