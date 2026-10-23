#!/usr/bin/env python3
"""Assembles public/index.html from src/ (theme + web CSS, shell markup, scripts)."""
import os
ROOT = os.path.dirname(os.path.abspath(__file__))
src = lambda f: open(os.path.join(ROOT, 'src', f), encoding='utf-8').read()
app = src('app.js')
assert app.rstrip().endswith("setInterval(()=>{ if(isAdmin()) STORE.tournaments.filter(t=>t.status==='active').forEach(t=>processDeadline(t.id)) }, 30000);")
app = app.replace('\n/* Init */\nboot();\n', '\n')
assert '\nboot();\n' not in app
head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Milandhoo eFootball Community</title>
<meta name="description" content="Tournaments, live results, brackets, leaderboard and Hall of Fame for the Milandhoo eFootball community.">
<meta name="theme-color" content="#0B1B3F">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png?v=2">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png?v=2">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Milandhoo">
<meta property="og:title" content="Milandhoo eFootball Community">
<meta property="og:description" content="Tournaments, live results, brackets, leaderboard and Hall of Fame.">
<meta property="og:image" content="/icons/icon-512.png?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" defer></script>
<style>
'''
css = src('theme.css') + src('web.css')
html = head + css + '\n</style>\n</head>\n<body>\n' + src('shell.html') + '<script>\n' + src('sbdb.js') + '\n' + app + '\n' + src('notify.js') + '\n/* Init */\nboot();\n</script>\n</body>\n</html>\n'
open(os.path.join(ROOT, 'public', 'index.html'), 'w', encoding='utf-8').write(html)
print('public/index.html', len(html), 'bytes')
