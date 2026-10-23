# Milandhoo eFootball Community

Installable web app (PWA) for the Milandhoo eFootball community: tournaments, live results,
brackets, leaderboard and Hall of Fame, with push notifications.

- **Hosting:** Vercel serves the `public/` folder (no build step on Vercel).
- **Database, sign-in, live updates:** Supabase project `pdgkxbkxpzinlbyedvco`.
- **Push notifications:** a database trigger calls the `push-notify` Edge Function
  (`supabase/functions/push-notify`), which sends Web Push to every subscribed device.

## Editing

The page is assembled from `src/`:

| File | What it holds |
|---|---|
| `src/theme.css`, `src/web.css` | Styles |
| `src/shell.html` | Sidebar, top bar and page frame |
| `src/sbdb.js` | Supabase data layer, organiser sign-in, push subscription |
| `src/app.js` | The app: tournaments, fixtures, brackets, exports, admin |
| `src/notify.js` | Updates bell, pop-up alerts, install guide |

After editing, run `python3 build.py` to regenerate `public/index.html`, then commit and push.
Vercel redeploys automatically.

## Organisers

Organisers sign in from the Admin Panel with email and password. Only emails on the
organiser list (Admin Panel → Organisers) can change data; the owner manages that list.
