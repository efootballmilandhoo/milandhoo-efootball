// Sends web push notifications when tournaments or Hall of Fame entries change.
// Called by the docs_notify database trigger (pg_net) with a shared secret header.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type Obj = Record<string, any>;
const has = (v: unknown) => v !== null && v !== undefined && v !== "";
const RECENT_MS = 60 * 60 * 1000;

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

async function eventsFor(body: Obj): Promise<Obj[]> {
  const { coll, id, old: o, new: n } = body;
  const out: Obj[] = [];
  if (!n) return out;
  const fresh = (iso?: string) => !iso || Date.now() - Date.parse(iso) < RECENT_MS;
  if (coll === "halloffame") {
    if (o || !fresh(n.createdAt)) return out;
    const label = n.type === "champion" ? "Champion" : n.type === "runner_up" ? "Runner-up" : n.type === "third" ? "Third place" : (n.title || "Award");
    const nm = n.playerName || (await names())[n.playerId] || "A player";
    out.push({ title: `Hall of Fame: ${nm}`, body: `${label}${n.tournament ? " · " + n.tournament : ""}`, url: "/#halloffame", tag: "hof-" + id });
    return out;
  }
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

  const nm = await names();
  const P = (pid: string) => nm[pid] || "TBD";
  const oldFx = new Map((o.fixtures || []).map((f: Obj) => [f.id, f]));
  const results: Obj[] = [];
  (n.fixtures || []).forEach((f: Obj) => {
    if (!has(f.score1) || !has(f.score2)) return;
    const p = oldFx.get(f.id) as Obj | undefined;
    if (p && p.score1 === f.score1 && p.score2 === f.score2) return;
    results.push({ title: `${P(f.team1)} ${f.score1}–${f.score2} ${P(f.team2)}`, body: `${tn}${f.group ? " · Group " + f.group : ""}` });
  });
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

Deno.serve(async (req) => {
  try {
    const s = await secrets();
    if (req.method !== "POST" || req.headers.get("x-hook-secret") !== s.hook_secret) return new Response("forbidden", { status: 403 });
    const body = await req.json();
    const events = await eventsFor(body);
    if (!events.length) return Response.json({ sent: 0 });
    webpush.setVapidDetails(s.vapid_subject, s.vapid_public, s.vapid_private);
    const { data: subs } = await sb.from("push_subscriptions").select("endpoint,p256dh,auth");
    let sent = 0;
    const gone: string[] = [];
    for (const ev of events) {
      const payload = JSON.stringify(ev);
      await Promise.all((subs || []).map(async (sub: Obj) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 60 * 60 * 24, urgency: "normal" });
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
