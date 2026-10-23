// Sends web push notifications.
// 1. Tournament changes: called by the docs_notify database trigger (pg_net).
// 2. Deadline reminders: called every 5 minutes by pg_cron with {"kind":"reminders"}.
//    Sends one reminder 2 hours before the group-stage deadline and before each knockout round deadline.
// Both callers send the shared secret in the x-hook-secret header.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type Obj = Record<string, any>;
const has = (v: unknown) => v !== null && v !== undefined && v !== "";
const RECENT_MS = 60 * 60 * 1000;
const REMIND_MS = 2 * 60 * 60 * 1000;
// Deadlines are saved without a time zone, in the organisers' local time (Maldives, UTC+5).
const LOCAL_OFFSET = "+05:00";
const LOCAL_TZ = "Indian/Maldives";

let secretsCache: Obj | null = null;
async function secrets() {
  if (secretsCache) return secretsCache;
  const { data } = await sb.from("app_secrets").select("name,value");
  secretsCache = Object.fromEntries((data || []).map((r: Obj) => [r.name, r.value]));
  return secretsCache!;
}

async function names(): Promise<Record<string, string>> {
  const { data } = await sb.from("docs").select("id,data->>name").eq("coll", "players");
  return Object.fromEntries((data || []).map((r: Obj) => [r.id, r.name]));
}

function koScore(fmt: string, m: Obj): string {
  const w = m.winner === m.team1 ? 0 : 1;
  const pick = (a: number, b: number) => (w === 0 ? `${a}–${b}` : `${b}–${a}`);
  if (fmt === "bo3" && Array.isArray(m.games)) {
    let a = 0, b = 0;
    m.games.forEach((g: Obj) => { if (has(g?.a) && has(g?.b) && g.a !== g.b) g.a > g.b ? a++ : b++; });
    return a + b ? ` (${pick(a, b)} in games)` : "";
  }
  if (!has(m.score1) || !has(m.score2)) return "";
  let a = Number(m.score1), b = Number(m.score2);
  if (fmt === "2leg" && has(m.leg2Score1) && has(m.leg2Score2)) { a += Number(m.leg2Score1); b += Number(m.leg2Score2); }
  const tb = m.tb && has(m.tb.a) && has(m.tb.b) ? `, tie-breaker ${pick(m.tb.a, m.tb.b)}` : "";
  const pens = m.pens && has(m.pens.a) && has(m.pens.b) ? `, ${pick(m.pens.a, m.pens.b)} on pens` : "";
  return ` ${pick(a, b)}${fmt === "2leg" ? " agg" : ""}${tb}${pens}`;
}

// Same order as the app's standings: points, goal difference, goals scored, wins.
function groupTable(t: Obj, g: Obj) {
  const rows: Record<string, Obj> = {};
  (g.players || []).forEach((p: Obj) => { rows[p.playerId] = { id: p.playerId, pts: 0, gf: 0, ga: 0, w: 0 }; });
  (t.fixtures || []).forEach((f: Obj) => {
    if (f.group !== g.name || !has(f.score1) || !has(f.score2)) return;
    const a = rows[f.team1], b = rows[f.team2]; if (!a || !b) return;
    const s1 = Number(f.score1), s2 = Number(f.score2);
    a.gf += s1; a.ga += s2; b.gf += s2; b.ga += s1;
    if (s1 > s2) { a.pts += 3; a.w++; } else if (s2 > s1) { b.pts += 3; b.w++; } else { a.pts++; b.pts++; }
  });
  return Object.values(rows).sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || y.w - x.w);
}

// Private Telegram messages go through the telegram function (players who linked the bot).
// They run in the background so the database trigger gets its answer straight away.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
function telegramLater(body: Obj) { EdgeRuntime.waitUntil(telegram(body)); }
async function telegram(body: Obj) {
  try {
    const s = await secrets();
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram`, { method: "POST", headers: { "Content-Type": "application/json", "x-hook-secret": s.hook_secret }, body: JSON.stringify(body) });
    console.log("telegram", body.action, await r.text());
  } catch (e) { console.error("telegram call failed", e); }
}

async function eventsFor(body: Obj): Promise<Obj[]> {
  const { coll, id, old: o, new: n } = body;
  const out: Obj[] = [];
  if (!n) return out;
  const fresh = (iso?: string) => !iso || Date.now() - Date.parse(iso) < RECENT_MS;
  // Hall of Fame changes are not announced.
  if (coll !== "tournaments" || n.status === "draft") return out;
  const tn = n.name || "Tournament";
  const url = `/#t=${id}`;
  if (!o) {
    if (fresh(n.createdAt) && n.status !== "completed") out.push({ title: `New tournament: ${tn}`, body: n.status === "open" ? "Registration is open. Check it out!" : "Added to tournaments", url, tag: "t-" + id });
    return out;
  }
  if (o.status === "draft" && n.status !== "draft") out.push({ title: `New tournament: ${tn}`, body: "Registration is open. Check it out!", url, tag: "t-" + id });
  if (!o.groupsDrawn && n.groupsDrawn) out.push({ title: `${tn} has started`, body: "Groups and fixtures are out", url, tag: "t-" + id });
  else if (o.status !== "active" && n.status === "active" && !n.groupsDrawn) out.push({ title: `${tn} has started`, body: "The bracket is out", url, tag: "t-" + id });
  if (n.format === "group_knockout" && !o.knockoutDrawn && n.knockoutDrawn) out.push({ title: `${tn}: knockout draw is out`, body: "See who plays who in the bracket", url, tag: "t-" + id });

  // Telegram: everyone gets their fixtures when groups or the bracket are drawn;
  // later, the two players of a knockout tie hear as soon as their opponent is known.
  if (n.status === "active") {
    const drew = (!o.groupsDrawn && n.groupsDrawn) || (!o.knockoutDrawn && n.knockoutDrawn) || (o.status !== "active" && (n.groupsDrawn || n.knockoutDrawn));
    if (drew) telegramLater({ action: "auto", tid: id });
    else if (n.knockoutDrawn && o.knockoutDrawn) {
      const before = new Map(((o.knockoutBracket || []).flat()).map((m: Obj) => [m.id, m]));
      const pids: string[] = [];
      ((n.knockoutBracket || []).flat()).forEach((m: Obj) => {
        if (!m || m.isBye || !m.team1 || !m.team2 || m.winner) return;
        const p = before.get(m.id) as Obj | undefined;
        if (p && p.team1 === m.team1 && p.team2 === m.team2) return;
        pids.push(m.team1, m.team2);
      });
      if (pids.length) telegramLater({ action: "auto", tid: id, pids });
    }
  }

  const nm = await names();
  const P = (pid: string) => nm[pid] || "TBD";
  const oldFx = new Map((o.fixtures || []).map((f: Obj) => [f.id, f]));
  const results: Obj[] = [];
  // Group-stage matches are not announced one by one; a group is announced once all its fixtures have scores.
  const quietGroups = n.format === "group_knockout";
  (n.fixtures || []).forEach((f: Obj) => {
    if (quietGroups && f.group) return;
    if (!has(f.score1) || !has(f.score2)) return;
    const p = oldFx.get(f.id) as Obj | undefined;
    if (p && p.score1 === f.score1 && p.score2 === f.score2) return;
    results.push({ title: `${P(f.team1)} ${f.score1}–${f.score2} ${P(f.team2)}`, body: `${tn}${f.group ? " · Group " + f.group : ""}` });
  });
  if (quietGroups) {
    const done = (t: Obj, g: string) => { const fx = (t.fixtures || []).filter((f: Obj) => f.group === g); return fx.length > 0 && fx.every((f: Obj) => has(f.score1) && has(f.score2)); };
    (n.groupData || []).forEach((g: Obj) => {
      if (!done(n, g.name) || done(o, g.name)) return;
      const q = Math.max(1, Number(n.qualifyPerGroup) || 1);
      const top = groupTable(n, g).slice(0, q).map((r) => P(r.id));
      out.push({ title: `${tn}: Group ${g.name} is complete`, body: top.length ? `Through to the knockouts: ${top.join(", ")}` : "See the final group standings", url, tag: `grp-${id}-${g.name}` });
    });
  }
  const oldKo = new Map(((o.knockoutBracket || []).flat()).map((m: Obj) => [m.id, m]));
  ((n.knockoutBracket || []).flat()).forEach((m: Obj) => {
    if (m.isBye || !m.winner || !m.team1 || !m.team2) return;
    const p = oldKo.get(m.id) as Obj | undefined;
    if (p && p.winner === m.winner) return;
    const loser = m.winner === m.team1 ? m.team2 : m.team1;
    results.push({ title: `${P(m.winner)} beat ${P(loser)}${koScore(n.knockoutFormat, m)}`, body: `${tn} · ${m.round || "Knockout"}` });
  });
  if (results.length > 3) out.push({ title: `${results.length} new results`, body: `${tn}: tap to see the latest scores`, url, tag: "res-" + id });
  else results.forEach((r, i) => out.push({ ...r, url, tag: `res-${id}-${Date.now()}-${i}` }));

  if (o.status !== "completed" && n.status === "completed" && n.champion) out.push({ title: `🏆 ${P(n.champion)} won ${tn}!`, body: n.runnerUp ? `Runner-up: ${P(n.runnerUp)}${n.thirdPlace ? " · Third: " + P(n.thirdPlace) : ""}` : "Tournament complete", url, tag: "t-" + id });
  return out;
}

/* ---- Deadline reminders ---- */
function deadlineMs(v: unknown): number {
  if (!has(v)) return NaN;
  const s = String(v);
  const withZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : (s.length === 16 ? s + ":00" : s) + LOCAL_OFFSET;
  return Date.parse(withZone);
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: LOCAL_TZ });

// Reminders whose deadline is between now and 2 hours from now, for stages that still have matches to play.
async function dueReminders(): Promise<Obj[]> {
  const now = Date.now();
  const soon = (ms: number) => Number.isFinite(ms) && ms > now && ms - now <= REMIND_MS;
  const { data } = await sb.from("docs").select("id,data").eq("coll", "tournaments");
  const out: Obj[] = [];
  for (const row of data || []) {
    const t: Obj = row.data || {};
    if (t.status !== "active") continue;
    const tn = t.name || "Tournament";
    const url = `/#t=${row.id}`;
    const isLeague = t.format === "league";

    const gd = deadlineMs(t.groupDeadline);
    if (t.format !== "single_elimination" && soon(gd) && !t.deadlineProcessed) {
      const left = (t.fixtures || []).filter((f: Obj) => (isLeague || f.group) && !(has(f.score1) && has(f.score2))).length;
      if (left) out.push({
        tg: { action: "remind", tid: row.id, clock: clock(gd), left: (() => { const m: Obj = {}; (t.fixtures || []).forEach((f: Obj) => { if ((isLeague || f.group) && !(has(f.score1) && has(f.score2))) { m[f.team1] = (m[f.team1] || 0) + 1; m[f.team2] = (m[f.team2] || 0) + 1; } }); return m; })() },
        key: `g:${row.id}:${t.groupDeadline}`,
        title: `⏰ 2 hours left: ${tn}`,
        body: `${isLeague ? "League" : "Group stage"} deadline is ${clock(gd)}. ${left} match${left > 1 ? "es" : ""} still to play; unplayed matches count as 0-0 draws.`,
        url, tag: `dl-${row.id}-group`,
      });
    }

    const dls: Obj = t.rules?.roundDeadlines || {};
    const rounds: Obj[][] = t.knockoutBracket || [];
    for (const [round, val] of Object.entries(dls)) {
      const ms = deadlineMs(val);
      if (!soon(ms)) continue;
      const matches = rounds.find((r) => r?.[0]?.round === round) || [];
      const left = matches.filter((m: Obj) => !m.isBye && m.team1 && m.team2 && !m.winner).length;
      if (!left) continue;
      out.push({
        tg: { action: "remind", tid: row.id, round, clock: clock(ms), left: Object.fromEntries(matches.filter((m: Obj) => !m.isBye && m.team1 && m.team2 && !m.winner).flatMap((m: Obj) => [[m.team1, 1], [m.team2, 1]])) },
        key: `k:${row.id}:${round}:${val}`,
        title: `⏰ 2 hours left: ${tn} · ${round}`,
        body: `${round} deadline is ${clock(ms)}. ${left} match${left > 1 ? "es" : ""} still to be played.`,
        url, tag: `dl-${row.id}-${round}`,
      });
    }
  }
  if (!out.length) return out;
  // Each reminder is sent once; a changed deadline gives a new key and a new reminder.
  const { data: sent } = await sb.from("deadline_reminders").select("key").in("key", out.map((r) => r.key));
  const done = new Set((sent || []).map((r: Obj) => r.key));
  const due = out.filter((r) => !done.has(r.key));
  if (due.length) await sb.from("deadline_reminders").insert(due.map((r) => ({ key: r.key })));
  if (due.length) EdgeRuntime.waitUntil((async () => { for (const r of due) await telegram(r.tg); })());
  return due.map(({ key: _k, tg: _t, ...ev }) => ev);
}

Deno.serve(async (req) => {
  try {
    const s = await secrets();
    if (req.method !== "POST" || req.headers.get("x-hook-secret") !== s.hook_secret) return new Response("forbidden", { status: 403 });
    const body = await req.json();
    const events = body?.kind === "reminders" ? await dueReminders() : await eventsFor(body);
    if (!events.length) return Response.json({ sent: 0 });
    webpush.setVapidDetails(s.vapid_subject, s.vapid_public, s.vapid_private);
    const { data: subs } = await sb.from("push_subscriptions").select("endpoint,p256dh,auth");
    let sent = 0;
    const gone: string[] = [];
    for (const ev of events) {
      const payload = JSON.stringify(ev);
      await Promise.all((subs || []).map(async (sub: Obj) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: body?.kind === "reminders" ? 60 * 60 : 60 * 60 * 24, urgency: body?.kind === "reminders" ? "high" : "normal" });
          sent++;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(sub.endpoint);
          else console.error("push failed", e?.statusCode, e?.body);
        }
      }));
    }
    if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", [...new Set(gone)]);
    else if (sent) await sb.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).in("endpoint", (subs || []).map((x: Obj) => x.endpoint));
    return Response.json({ events: events.length, sent, removed: gone.length });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
