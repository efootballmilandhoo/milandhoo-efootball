# Milandhoo eFootball Community

Installable web app (PWA) for the Milandhoo eFootball community: tournaments, live results,
brackets, leaderboard and Hall of Fame, with push notifications.

- **Hosting:** Vercel serves the `public/` folder (no build step on Vercel).
- **Database, sign-in, live updates:** Supabase project `pdgkxbkxpzinlbyedvco`.
- **Push notifications:** a database trigger calls the `push-notify` Edge Function
  (`supabase/functions/push-notify`), which sends Web Push to every subscribed device.

## Editing

The site is built from `src/`:

| File | What it holds |
|---|---|
| `src/theme.css`, `src/web.css`, `src/ui.css` | Styles (design, motion, layout polish) |
| `src/shell.html` | Sidebar, top bar, phone header and bottom navigation |
| `src/sbdb.js` | Supabase data layer, organiser sign-in, push subscription |
| `src/app.js` | The app: tournaments, fixtures, brackets, exports, admin |
| `src/perf.js` | Instant start from saved data, picture storage, lazy libraries, update notice |
| `src/notify.js` | Updates bell, pop-up alerts, install guide, animations |
| `src/sw.js` | Service worker template (offline shell, caching, push) |

Run `python3 build.py` after editing. It writes `public/index.html`, versioned files in
`public/assets/` (cached for a year) and `public/sw.js`. Commit and push; Vercel redeploys
automatically and open apps offer a one-tap reload.

Pictures (player photos, logos, banners) are stored in the Supabase Storage bucket `media`;
any picture saved inline is moved there automatically when an organiser is signed in.

## Organisers

Organisers sign in from the Admin Panel with email and password. Only emails on the
organiser list (Admin Panel → Organisers) can change data; the owner manages that list.

## Deployment

Pushing to `main` deploys automatically through Vercel's GitHub integration
(production: https://milandhoo-efootball.vercel.app).
