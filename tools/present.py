"""Presentation video in the @designers style:
title card → phone rises in → camera zooms into the details → outro card.

in:  demo/build/screen60.mp4 (390x844 @3x, 60 fps), demo/build/soundtrack-present.wav
out: demo/live-weather-presentation.mp4 (+ -silent.mp4)
"""
import argparse, io, math, multiprocessing as mp, pathlib, shutil, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
B = ROOT / 'demo' / 'build'
ap = argparse.ArgumentParser(); ap.add_argument('--preview', default='', help='comma list of seconds → PNGs only')
ap.add_argument('--screen', default=str(pathlib.Path(__file__).resolve().parent.parent / 'demo/build/screen60.mp4'))
ap.add_argument('--workers', type=int, default=2)
a = ap.parse_args()

S, FPS = 1920, 60
PT = 3                                # px per pt in the screen recording
SW, SH = 390 * PT, 844 * PT           # 1170 x 2532
INTRO, DEMO, OUTRO = 3.0, 48.0, 2.6
TOTAL = INTRO + DEMO + OUTRO

# ---------------------------------------------------------------- phone layers (drawn once)
BZ, RIM, RAD, M = 11 * PT, 3 * PT + 1, 55 * PT, 170
PW, PH = SW + 2 * (BZ + RIM), SH + 2 * (BZ + RIM)
CW, CH = PW + 2 * M, PH + 2 * M
OX, OY = M + BZ + RIM, M + BZ + RIM        # screen origin inside the canvas

under = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
sh = Image.new('L', (CW, CH), 0)
ImageDraw.Draw(sh).rounded_rectangle([M + 20, M + 70, M + PW - 20, M + PH + 10], RAD + BZ + RIM, fill=120)
under.putalpha(sh.filter(ImageFilter.GaussianBlur(55)))
under = Image.composite(Image.new('RGBA', (CW, CH), (25, 30, 80, 255)), Image.new('RGBA', (CW, CH), (0, 0, 0, 0)), under.getchannel('A'))
d = ImageDraw.Draw(under)
for x, y, h in ((M - 7, M + 300, 95), (M - 7, M + 450, 190), (M - 7, M + 670, 190), (M + PW - 3, M + 520, 290)):  # buttons
    d.rounded_rectangle([x, y, x + 10, y + h], 5, fill=(120, 124, 132, 255))
d.rounded_rectangle([M, M, M + PW, M + PH], RAD + BZ + RIM, fill=(150, 154, 162, 255))              # titanium rim
d.rounded_rectangle([M + 2, M + 2, M + PW - 2, M + PH - 2], RAD + BZ + RIM - 2, fill=(205, 208, 214, 255))
d.rounded_rectangle([M + 4, M + 4, M + PW - 4, M + PH - 4], RAD + BZ + RIM - 4, fill=(118, 122, 130, 255))
d.rounded_rectangle([M + RIM, M + RIM, M + PW - RIM, M + PH - RIM], RAD + BZ, fill=(6, 6, 8, 255))  # black bezel

mask = Image.new('L', (SW, SH), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SW - 1, SH - 1], RAD, fill=255)

over = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
o = ImageDraw.Draw(over)
iw, ih = 126 * PT, 37 * PT
ix, iy = OX + (SW - iw) // 2, OY + 11 * PT
o.rounded_rectangle([ix, iy, ix + iw, iy + ih], ih // 2, fill=(0, 0, 0, 255))                     # dynamic island
o.ellipse([ix + iw - 52, iy + ih // 2 - 14, ix + iw - 24, iy + ih // 2 + 14], fill=(18, 24, 40, 255))

# ---------------------------------------------------------------- camera
# (demo seconds, zoom, focus x pt, focus y pt) — zoom 1 = whole phone
FULL = (195, 422)
KEYS = [
    (0.0, 1, *FULL), (5.0, 1, *FULL),
    (6.1, 1.75, 195, 560), (12.8, 1.75, 195, 560),      # snow piles up, typing, scroll → snow falls off
    (13.7, 1, *FULL), (15.8, 1, *FULL),
    (16.8, 1.8, 195, 600), (19.0, 1.8, 195, 600),       # send in the rain → drops part, splashes
    (19.6, 1, *FULL), (32.3, 1, *FULL),                 # storm, fog, night
    (33.3, 1.6, 240, 250), (35.9, 1.6, 240, 250),       # stars & moon
    (36.4, 1, *FULL), (38.4, 1, *FULL),
    (39.4, 1.9, 195, 400), (42.0, 1.9, 195, 400),       # night snow on the bubbles
    (42.6, 1, *FULL), (DEMO, 1, *FULL),
]
ease = lambda x: x * x * (3 - 2 * x)
def camera(ts):
    for (t0, z0, x0, y0), (t1, z1, x1, y1) in zip(KEYS, KEYS[1:]):
        if t0 <= ts <= t1:
            e = ease((ts - t0) / (t1 - t0)) if t1 > t0 else 1
            # interpolate zoom in log space so the motion feels even
            return np.exp(np.log(z0) + (np.log(z1) - np.log(z0)) * e), x0 + (x1 - x0) * e, y0 + (y1 - y0) * e
    return 1, *FULL

K_FULL = 1760 / PH                     # whole phone fits with margins
def place(z, fx, fy, dy=0.0):
    k = K_FULL * z
    cx, cy = OX + fx * PT, OY + fy * PT            # focus in canvas px
    if z <= 1.0001: cx, cy = CW / 2, M + PH / 2
    return k, S / 2 - cx * k, S / 2 - cy * k + dy  # output = canvas*k + offset

# ---------------------------------------------------------------- title / outro / bg from the card page
CARDS = B / 'cards'
def render_cards():
    CARDS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=shutil.which('google-chrome'))
        pg = br.new_page(viewport={'width': S, 'height': S})
        pg.goto((ROOT / 'tools/titlecard.html').as_uri()); pg.wait_for_function('window.__ready'); pg.evaluate('document.fonts.ready')
        for i in range(int(INTRO * FPS)):
            pg.evaluate(f"__render({i / FPS}, 'intro')"); pg.screenshot(path=str(CARDS / f'i{i:04d}.png'))
        for i in range(int(OUTRO * FPS) + 2):
            pg.evaluate(f"__render({i / FPS}, 'outro')"); pg.screenshot(path=str(CARDS / f'o{i:04d}.png'))
        pg.evaluate("__render(0, 'bg')"); pg.screenshot(path=str(CARDS / 'bg.png'))
        br.close()
    print('cards rendered', flush=True)
def card(kind, i): return Image.open(CARDS / f'{kind}{i:04d}.png').convert('RGB')
BG = None

# ---------------------------------------------------------------- screen frames (sequential decoder per worker)
dec, nscreen, last = None, 0, None
def open_decoder(first):
    global dec, nscreen, last
    dec = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-ss', f'{first / FPS:.6f}', '-i', a.screen,
                            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    nscreen, last = first, None
def screen_frame(idx):
    global nscreen, last
    while nscreen <= idx or last is None:
        buf = dec.stdout.read(SW * SH * 3)
        if len(buf) < SW * SH * 3: break
        last = Image.frombuffer('RGB', (SW, SH), buf); nscreen += 1
    return last

def phone(img):
    c = under.copy(); c.paste(img, (OX, OY), mask); c.alpha_composite(over); return c

def compose(base, ph, k, ox, oy, alpha=1.0):
    # sub-pixel exact: pick whole output pixels, map them back to a float source box
    X0, Y0 = max(0, math.ceil(ox)), max(0, math.ceil(oy))
    X1, Y1 = min(S, math.floor(ox + CW * k)), min(S, math.floor(oy + CH * k))
    if X1 <= X0 or Y1 <= Y0: return base
    box = ((X0 - ox) / k, (Y0 - oy) / k, min(CW, (X1 - ox) / k), min(CH, (Y1 - oy) / k))
    img = ph.resize((X1 - X0, Y1 - Y0), Image.BICUBIC, box=box, reducing_gap=None if k >= 1 else 2.0)
    if alpha < 1: img.putalpha(img.getchannel('A').point(lambda v: int(v * alpha)))
    base = base.convert('RGBA'); base.alpha_composite(img, (X0, Y0))
    return base.convert('RGB')

def frame(t):
    if t < INTRO - 0.55:                                   # title card
        return card('i', min(int(t * FPS), int(INTRO * FPS) - 1))
    if t < INTRO:                                          # phone rises in over the fading title
        e = 1 - (1 - (t - (INTRO - 0.55)) / 0.55) ** 3
        k, ox, oy = place(1, *FULL, dy=(1 - e) * 700)
        return compose(card('i', min(int(t * FPS), int(INTRO * FPS) - 1)), phone(screen_frame(0)), k, ox, oy, e)
    ts = t - INTRO
    if ts <= DEMO - 0.5:
        z, fx, fy = camera(ts)
        k, ox, oy = place(z, fx, fy)
        return compose(BG, phone(screen_frame(int(ts * FPS))), k, ox, oy)
    # outro: the phone sinks away completely, then the card animates in on a clean background
    if ts < DEMO:
        e = min(1, (ts - (DEMO - 0.5)) / 0.45); e3 = e ** 3
        k, ox, oy = place(1, *FULL, dy=e3 * 900)
        return compose(BG, phone(screen_frame(int(min(ts, DEMO - 1 / FPS) * FPS))), k, ox, oy, 1 - e3 * 0.6)
    return card('o', min(int((ts - DEMO) * FPS), int(OUTRO * FPS)))

def encode(out):
    return subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{S}x{S}',
                             '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
                             '-pix_fmt', 'yuv420p', str(out)], stdin=subprocess.PIPE)

def part(args):
    k, f0, f1 = args
    global BG
    BG = Image.open(CARDS / 'bg.png').convert('RGB')
    # the screen frame needed at output frame f0
    t0 = f0 / FPS - INTRO
    open_decoder(max(0, min(int(t0 * FPS), int(DEMO * FPS) - 1)))
    out = B / f'part{k}.mp4'; enc = encode(out)
    for i in range(f0, f1):
        enc.stdin.write(frame(i / FPS).tobytes())
        if (i - f0) % 300 == 0: print(f'[{k}] frame {i}/{f1}', flush=True)
    enc.stdin.close(); enc.wait(); dec.kill()
    return out

if __name__ == '__main__':
    render_cards()
    BG = Image.open(CARDS / 'bg.png').convert('RGB')
    n = int(TOTAL * FPS)
    if a.preview:
        for sec in a.preview.split(','):
            t = float(sec); open_decoder(max(0, int((t - INTRO) * FPS)))
            frame(t).save(B / f'preview_{sec}.png'); dec.kill(); print('preview', sec)
        raise SystemExit
    cuts = [round(n * j / a.workers) for j in range(a.workers + 1)]
    with mp.Pool(a.workers) as pool:
        parts = pool.map(part, [(j, cuts[j], cuts[j + 1]) for j in range(a.workers)])
    lst = B / 'parts.txt'; lst.write_text(''.join(f"file '{p_}'\n" for p_ in parts))
    silent = ROOT / 'demo' / 'live-weather-presentation-silent.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy',
                    '-movflags', '+faststart', str(silent)], check=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(silent), '-i', str(B / 'soundtrack-present.wav'), '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', str(ROOT / 'demo' / 'live-weather-presentation.mp4')], check=True)
    print('saved', silent, 'and live-weather-presentation.mp4')
