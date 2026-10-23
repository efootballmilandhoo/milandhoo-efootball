#!/usr/bin/env python3
"""Builds public/ from src/.

- public/assets/app.<hash>.css  styles (minified), cached for a year
- public/assets/app.<hash>.js   the app, cached for a year
- public/index.html             small page that loads the two files above
- public/sw.js                  service worker with the list of files to keep offline

Run `python3 build.py` after editing anything in src/, then commit and push.
"""
import hashlib, json, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(ROOT, 'public')
ASSETS = os.path.join(PUB, 'assets')
src = lambda f: open(os.path.join(ROOT, 'src', f), encoding='utf-8').read()

SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'
FONTS = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap'
ICONS = ['/icons/icon-192.png?v=2', '/icons/icon-512.png?v=2', '/icons/badge-96.png?v=2', '/icons/apple-touch-icon.png?v=2', '/icons/favicon-32.png?v=2']


def minify_css(css):
    """Removes comments and spare whitespace. Strings are kept exactly as written."""
    parts, i, n = [], 0, len(css)
    buf = []
    def flush():
        if buf:
            seg = ''.join(buf)
            seg = re.sub(r'\s+', ' ', seg)
            seg = re.sub(r'\s*([{};,>])\s*', r'\1', seg)
            seg = re.sub(r':\s+', ':', seg)
            parts.append(seg)
            buf.clear()
    while i < n:
        c = css[i]
        if c in '"\'':
            flush()
            j = i + 1
            while j < n and css[j] != c:
                j += 2 if css[j] == '\\' else 1
            parts.append(css[i:j + 1])
            i = j + 1
            continue
        if css.startswith('/*', i):
            j = css.find('*/', i + 2)
            i = n if j < 0 else j + 2
            buf.append(' ')
            continue
        buf.append(c)
        i += 1
    flush()
    out = ''.join(parts)
    return out.replace(';}', '}').strip()


def short_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:10]


def build():
    app = src('app.js')
    assert app.rstrip().endswith("setInterval(()=>{ if(isAdmin()) STORE.tournaments.filter(t=>t.status==='active').forEach(t=>processDeadline(t.id)) }, 30000);")
    app = app.replace('\n/* Init */\nboot();\n', '\n')
    assert '\nboot();\n' not in app
    js = '\n'.join([src('sbdb.js'), app, src('perf.js'), src('notify.js'), '/* Init */\nboot();\n'])
    css = minify_css(src('theme.css') + src('web.css') + src('ui.css'))

    os.makedirs(ASSETS, exist_ok=True)
    for f in os.listdir(ASSETS):
        os.remove(os.path.join(ASSETS, f))
    js_name = f'app.{short_hash(js)}.js'
    css_name = f'app.{short_hash(css)}.css'
    open(os.path.join(ASSETS, js_name), 'w', encoding='utf-8').write(js)
    open(os.path.join(ASSETS, css_name), 'w', encoding='utf-8').write(css)

    html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MG Efootball</title>
<meta name="description" content="Tournaments, live results, brackets, leaderboard and Hall of Fame for the MG Efootball community.">
<meta name="theme-color" content="#0B1B3F">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" id="appFavicon" type="image/png" sizes="32x32" href="https://pdgkxbkxpzinlbyedvco.supabase.co/functions/v1/app-icon?s=32">
<link rel="apple-touch-icon" id="appTouchIcon" href="https://pdgkxbkxpzinlbyedvco.supabase.co/functions/v1/app-icon?s=180">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="MG Efootball">
<meta property="og:title" content="MG Efootball">
<meta property="og:description" content="Tournaments, live results, brackets, leaderboard and Hall of Fame.">
<meta property="og:image" content="https://pdgkxbkxpzinlbyedvco.supabase.co/functions/v1/app-icon?s=512">
<link rel="preconnect" href="https://pdgkxbkxpzinlbyedvco.supabase.co" crossorigin>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="/assets/{css_name}">
<link rel="preload" as="style" crossorigin="anonymous" href="{FONTS}" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" crossorigin="anonymous" href="{FONTS}"></noscript>
<script id="sbjs" src="{SUPABASE_JS}" async crossorigin="anonymous" onerror="window.__sbFailed=1"></script>
<script src="/assets/{js_name}" defer></script>
</head>
<body>
{src('shell.html').strip()}
</body>
</html>
'''
    open(os.path.join(PUB, 'index.html'), 'w', encoding='utf-8').write(html)

    precache = ['/', f'/assets/{css_name}', f'/assets/{js_name}'] + ICONS
    version = short_hash(html + js_name + css_name + src('sw.js'))
    sw = src('sw.js').replace("'__VERSION__'", repr(version)).replace('__PRECACHE__', json.dumps(precache))
    open(os.path.join(PUB, 'sw.js'), 'w', encoding='utf-8').write(sw)

    print(f'index.html {len(html):,} B · {css_name} {len(css):,} B · {js_name} {len(js):,} B · sw {version}')


if __name__ == '__main__':
    build()
