"""Render the scripted demo frame-by-frame and encode an MP4 (no sound).

Every animation in the demo runs on one virtual clock and Math.random is seeded,
so each frame is exact and the result is perfectly smooth on any machine.
Frames are rendered by several browser workers in parallel; each worker first
fast-forwards the (deterministic) simulation to its segment, then captures it.

usage: python3 tools/record.py [--fps 60] [--dpr 3] [--workers 2] [--out demo/build/screen.mp4]
       python3 tools/record.py --stills 0,5000,12000     # quick preview PNGs
       python3 tools/record.py --events-only             # only the event timeline (for sound)
"""
import argparse, base64, json, multiprocessing as mp, pathlib, shutil, subprocess, tempfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

def open_page(p, a):
    browser = p.chromium.launch(executable_path=a.chrome, args=['--force-color-profile=srgb'])
    page = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=a.dpr)
    page.goto((ROOT / 'index.html').as_uri() + f'?record&dpr={a.dpr}')
    page.wait_for_function('window.__ready === true')
    page.evaluate('document.fonts.ready')
    return browser, page

def worker(args):
    a, start, end, frames = args
    with sync_playwright() as p:
        browser, page = open_page(p, a)
        cdp = page.context.new_cdp_session(page)
        dt = 1000 / a.fps
        if start:  # fast-forward the simulation in batches, no screenshots
            page.evaluate(f'(() => {{ for (let i = 0; i < {start}; i++) __render(i * {dt}); }})()')
        for i in range(start, end):
            page.evaluate(f'__render({i * dt})')
            shot = cdp.send('Page.captureScreenshot', {'format': 'jpeg', 'quality': 93, 'optimizeForSpeed': True,
                                                       'clip': {'x': 0, 'y': 0, 'width': 390, 'height': 844, 'scale': a.dpr}})
            (pathlib.Path(frames) / f'{i:05d}.jpg').write_bytes(base64.b64decode(shot['data']))
            if (i - start) % 300 == 0: print(f'[{start}] frame {i}/{end}', flush=True)
        events = None
        if start == 0:  # finish the simulation to get the full event timeline
            page.evaluate(f'(() => {{ for (let i = {end}; i < {a.seconds * a.fps}; i++) __render(i * {dt}); }})()')
            events = page.evaluate('window.__events')
        browser.close()
    return events

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fps', type=int, default=60)
    ap.add_argument('--seconds', type=float, default=48)
    ap.add_argument('--dpr', type=float, default=3)
    ap.add_argument('--workers', type=int, default=max(1, mp.cpu_count()))
    ap.add_argument('--out', default=str(ROOT / 'demo' / 'build' / 'screen.mp4'))
    ap.add_argument('--stills', default='')
    ap.add_argument('--events-only', action='store_true')
    ap.add_argument('--chrome', default=shutil.which('google-chrome') or shutil.which('chromium'))
    a = ap.parse_args()
    out = pathlib.Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    n = int(a.seconds * a.fps)

    if a.events_only or a.stills:
        with sync_playwright() as p:
            browser, page = open_page(p, a)
            dt = 1000 / a.fps
            if a.events_only:
                page.evaluate(f'(() => {{ for (let i = 0; i < {n}; i++) __render(i * {dt}); }})()')
                (out.parent / 'events.json').write_text(json.dumps(page.evaluate('window.__events')))
                print('saved', out.parent / 'events.json')
            else:
                sd = ROOT / 'demo' / 'stills'; sd.mkdir(parents=True, exist_ok=True); t = 0
                for target in sorted(int(x) for x in a.stills.split(',')):
                    while t < target: t = min(target, t + dt); page.evaluate(f'__render({t})')
                    page.screenshot(path=str(sd / f'{target:06d}.png')); print('still', target)
            browser.close()
        raise SystemExit

    frames = tempfile.mkdtemp()
    cuts = [round(n * k / a.workers) for k in range(a.workers + 1)]
    with mp.Pool(a.workers) as pool:
        results = pool.map(worker, [(a, cuts[k], cuts[k + 1], frames) for k in range(a.workers)])
    (out.parent / 'events.json').write_text(json.dumps(results[0]))
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(a.fps), '-i', f'{frames}/%05d.jpg',
                    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14',
                    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out)], check=True)
    shutil.rmtree(frames)
    print('saved', out)
