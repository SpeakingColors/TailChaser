#!/usr/bin/env python3
"""Builds the mockup from docs/mockups/src/template.html + core/tailchaser_core.js.
Outputs: docs/mockup/index.html (fonts next to it) and a standalone copy with fonts inlined."""
import base64, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ver = sys.argv[1] if len(sys.argv) > 1 else 'v1'
tpl = open(f'{root}/docs/mockups/src/template.html').read()
core = open(f'{root}/core/tailchaser_core.js').read()
fonts = [('Barlow Condensed',600,'barlow-condensed-latin-600-normal'),('Barlow Condensed',700,'barlow-condensed-latin-700-normal'),('JetBrains Mono',500,'jetbrains-mono-latin-500-normal')]
def css(inline):
    out = []
    for fam, w, f in fonts:
        if inline:
            b = base64.b64encode(open(f'{root}/docs/mockup/fonts/{f}.woff2','rb').read()).decode()
            src = f'url(data:font/woff2;base64,{b})'
        else:
            src = f'url(fonts/{f}.woff2)'
        out.append(f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;src:{src} format('woff2')}}")
    return '\n'.join(out)
def build(inline):
    return tpl.replace('/*FONTS*/', css(inline)).replace('/*CORE*/', core)
open(f'{root}/docs/mockup/index.html','w').write(build(False))
open(f'{root}/docs/mockups/TailChaser_mockup_{ver}.html','w').write(build(True))
print('built', ver)
