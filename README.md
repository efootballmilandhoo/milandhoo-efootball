# EduMaldives Smart Learning Portal (web)

Static site for Vercel, backed by Supabase project `pnzchmpvcucoctfbvvit` (EduMaldives).

- `index.html` – the portal
- `edu-supabase.js` – connects the portal to Supabase (login, database, file uploads, AI)
- `seed/` – built-in analysed papers, repeated questions and study packs
- `dpe/`, `tq/` – Dhivehi/Islam SSC papers and other bundled files

Deploy: import this repository in Vercel (Framework preset: Other, no build command, output directory: root).
In Supabase → Authentication → URL Configuration, set the Site URL to the Vercel address.
