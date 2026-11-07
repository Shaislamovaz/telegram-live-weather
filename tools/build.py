"""Inline CSS + JS into one self-contained file: dist/live-weather.html"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
html = (ROOT / 'index.html').read_text()
html = html.replace('<link rel="stylesheet" href="src/styles.css">',
                    '<style>\n' + (ROOT / 'src/styles.css').read_text() + '\n</style>')
for name in ('weather-layer', 'weather-provider', 'app'):
    js = (ROOT / f'src/{name}.js').read_text()
    html = html.replace(f'<script src="src/{name}.js"></script>', '<script>\n' + js + '\n</script>')
assert not re.search(r'src="src/', html)
out = ROOT / 'dist' / 'live-weather.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html)
print('built', out, len(html), 'bytes')
