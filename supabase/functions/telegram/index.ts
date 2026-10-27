// Telegram bot @MGefootballbot: players link their Telegram by sharing their phone number,
// then receive their own fixtures privately.
//
// Callers:
// - Telegram webhook (header x-telegram-bot-api-secret-token): /start, contact sharing, /fixtures, /stop.
// - Organisers from the app (signed-in session): {action:"texts"|"send", tid} and {action:"info"}.
// - push-notify (header x-hook-secret): {action:"auto", tid} after a draw, {action:"remind", tid, round?, clock}.
//   The group-stage reminder (sent automatically at 18:00 on deadline day) lists each player's unplayed matches
//   and the deadline rules. Players can also send /deadline; organisers can send it from the app.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP = "https://milandhoo-efootball.vercel.app";
const TZ = "Indian/Maldives";
const LOCAL_OFFSET = "+05:00";
const BOT = "MGefootballbot";

type Obj = Record<string, any>;
const has = (v: unknown) => v !== null && v !== undefined && v !== "";
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

let secretsCache: Obj | null = null;
async function secrets() {
  if (secretsCache) return secretsCache;
  const { data } = await sb.from("app_secrets").select("name,value");
  secretsCache = Object.fromEntries((data || []).map((r: Obj) => [r.name, r.value]));
  return secretsCache!;
}
async function tg(method: string, body: Obj) {
  const s = await secrets();
  const r = await fetch(`https://api.telegram.org/bot${s.telegram_token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({ ok: false }));
}
const say = (chat_id: number, text: string, extra: Obj = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

async function names(): Promise<Record<string, string>> {
  const { data } = await sb.from("docs").select("id,data->>name").eq("coll", "players");
  return Object.fromEntries((data || []).map((r: Obj) => [r.id, r.name]));
}
async function tournament(tid: string): Promise<Obj | null> {
  const { data } = await sb.from("docs").select("id,data").eq("coll", "tournaments").eq("id", tid).maybeSingle();
  return data ? { ...data.data, id: data.id } : null;
}
async function activeTournaments(): Promise<Obj[]> {
  const { data } = await sb.from("docs").select("id,data").eq("coll", "tournaments");
  return (data || []).map((r: Obj) => ({ ...r.data, id: r.id })).filter((t: Obj) => t.status === "active");
}

/* ---- Dates ---- */
function deadlineMs(v: unknown): number {
  if (!has(v)) return NaN;
  const s = String(v);
  return Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : (s.length === 16 ? s + ":00" : s) + LOCAL_OFFSET);
}
function when(v: unknown): string {
  const ms = deadlineMs(v);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}
/* Local calendar helpers (Maldives time). */
const localDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
const localAt = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00${LOCAL_OFFSET}`);
const dayName = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
/* Players must report an opponent who won't play before 21:00 on deadline day (or by the deadline, if that is earlier). */
function reportCutoff(dl: number): number { const c = localAt(localDay(dl), "21:00"); return Math.min(c, dl); }

/* The group-stage deadline rules, written the same way in every reminder. */
function deadlineRules(t: Obj, html = true, now = Date.now()): string[] {
  const b = (s: string) => (html ? `<b>${esc(s)}</b>` : s);
  const dl = deadlineMs(t.groupDeadline);
  if (!Number.isFinite(dl)) return [];
  const cut = reportCutoff(dl);
  const cutText = cut < dl ? `before 21:00 on ${dayName(dl)}` : `before the deadline (${when(t.groupDeadline)})`;
  return [
    html ? "📌 <b>Rules</b>" : "📌 Rules",
    `• Any match not played by the deadline is counted as ${b("0–0")}.`,
    now < cut
      ? `• If your opponent doesn't play your match, ${b("inform an admin " + cutText)}. ${b("Reports after that won't be accepted.")}`
      : `• ${b("Reports of an opponent not playing are closed")} since ${b(new Date(cut).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }))}.`,
    `• A player who doesn't play gets a ${b("1–0 loss")}: ${b("the win goes to their opponent")}.`,
  ];
}

/* Group-stage deadline reminder for one player: their unplayed matches and the rules. */
function deadlineText(t: Obj, pid: string, nm: Record<string, string>, kind: string, html = true): string | null {
  if (t.status !== "active" || t.format === "single_elimination" || t.deadlineProcessed) return null;
  const dl = deadlineMs(t.groupDeadline), now = Date.now();
  if (!Number.isFinite(dl) || dl <= now) return null;
  const isLeague = t.format === "league";
  const left = (t.fixtures || []).filter((f: Obj) => (f.team1 === pid || f.team2 === pid) && (isLeague || f.group) && !(has(f.score1) && has(f.score2)))
    .sort((a: Obj, c: Obj) => (a.matchday || 0) - (c.matchday || 0));
  if (!left.length) return null;
  const b = (s: string) => (html ? `<b>${esc(s)}</b>` : s);
  const e = (s: unknown) => (html ? esc(s) : String(s ?? ""));
  const stage = isLeague ? "League" : "Group stage";
  const lines = [`⏰ ${b("Reminder!")}`, "", `🏆 ${b(t.name || "Tournament")}`, `📅 ${e(stage)} deadline: ${b(when(t.groupDeadline))}`, ""];
  lines.push(`${nm[pid] ? b(nm[pid]) + ", you" : "You"} have ${b(`${left.length} match${left.length > 1 ? "es" : ""} left to play`)}:`);
  left.forEach((f: Obj, i: number) => {
    const opp = f.team1 === pid ? f.team2 : f.team1;
    lines.push(`${i + 1}. vs ${b(nm[opp] || "TBD")}${!isLeague && f.group ? `  (Group ${e(f.group)})` : ""}`);
  });
  lines.push("", ...deadlineRules(t, html, now), "", `Table and results: ${APP}/#t=${t.id}`);
  return lines.join("\n");
}

const KO_FMT: Obj = { bo3: "best of 3 games", "2leg": "two legs, aggregate score", single: "one match" };

/* ---- A player's fixtures as a message. html=false gives plain text for WhatsApp / SMS. ---- */
function fixturesText(t: Obj, pid: string, nm: Record<string, string>, html = true): string | null {
  const b = (s: string) => (html ? `<b>${esc(s)}</b>` : s);
  const e = (s: unknown) => (html ? esc(s) : String(s ?? ""));
  const P = (id: string) => nm[id] || "TBD";
  const link = `${APP}/#t=${t.id}`;
  const lines: string[] = [];
  const isLeague = t.format === "league";

  // Knockout: the player's tie that is still to be decided, in the latest drawn round.
  const rounds: Obj[][] = t.knockoutBracket || [];
  let koTie: Obj | null = null, koRound = "";
  if (t.knockoutDrawn) {
    for (const r of rounds) for (const m of r || []) {
      if (!m || m.isBye || !(m.team1 === pid || m.team2 === pid)) continue;
      if (!m.winner && m.team1 && m.team2) { koTie = m; koRound = m.round || "Knockout"; }
    }
  }
  if (koTie) {
    const opp = koTie.team1 === pid ? koTie.team2 : koTie.team1;
    const dl = t.rules?.roundDeadlines?.[koRound];
    lines.push(`🏆 ${b(t.name || "Tournament")}`, `${e(koRound)} · ${KO_FMT[t.knockoutFormat] || KO_FMT.single}`, "");
    lines.push(`Your opponent: ${b(P(opp))}`);
    if (dl) lines.push(`⏰ Play by: ${b(when(dl))}`);
    lines.push("", `Good luck, ${e(P(pid))}!`, `See the bracket: ${link}`);
    return lines.join("\n");
  }

  // Group stage / league
  const fx = (t.fixtures || []).filter((f: Obj) => f.team1 === pid || f.team2 === pid);
  if (!fx.length || !t.groupsDrawn) return null;
  const group = fx[0].group;
  const left = fx.filter((f: Obj) => !(has(f.score1) && has(f.score2)));
  // Once the knockout is drawn, players without a tie to play only hear about unfinished group matches.
  if (t.knockoutDrawn && !left.length) return null;
  lines.push(`🏆 ${b(t.name || "Tournament")}`);
  lines.push(isLeague ? `League · ${fx.length} matches` : `Group ${e(group)} · ${fx.length} matches`);
  if (t.groupDeadline) lines.push(`⏰ Deadline: ${b(when(t.groupDeadline))}`);
  lines.push("", `Your fixtures, ${e(P(pid))}:`);
  fx.sort((a: Obj, c: Obj) => (a.matchday || 0) - (c.matchday || 0)).forEach((f: Obj, i: number) => {
    const home = f.team1 === pid, opp = home ? f.team2 : f.team1;
    const done = has(f.score1) && has(f.score2);
    const res = done ? (() => { const me = home ? f.score1 : f.score2, them = home ? f.score2 : f.score1; return `  ${me > them ? "✅" : me < them ? "❌" : "➖"} ${me}–${them}`; })() : "";
    lines.push(`${i + 1}. vs ${done ? e(P(opp)) : b(P(opp))}${res}`);
  });
  lines.push("", left.length ? `${left.length} match${left.length > 1 ? "es" : ""} to play.` : "All your matches are played.");
  if (left.length && t.groupDeadline && !t.deadlineProcessed && deadlineMs(t.groupDeadline) > Date.now()) lines.push("", ...deadlineRules(t, html));
  lines.push("");
  lines.push(`Table and results: ${link}`);
  return lines.join("\n");
}

/* ---- Linking ---- */
async function linkByPhone(msg: Obj) {
  const chat = msg.chat.id, c = msg.contact;
  if (!c || c.user_id !== msg.from?.id) return say(chat, "Please share <b>your own</b> number with the button below.", contactKeyboard());
  const d = digits(c.phone_number);
  const last7 = d.slice(-7);
  const { data } = await sb.from("private_docs").select("id,data").eq("coll", "phones");
  const match = (data || []).find((r: Obj) => { const p = digits(r.data?.phone); return p && p.slice(-7) === last7; });
  if (!match) return say(chat, `Sorry, the number ending ${esc(last7.slice(-4))} isn't on the player list.\nAsk an organiser to add your number in the app, then tap /start again.`, { reply_markup: { remove_keyboard: true } });
  const nm = await names();
  await sb.from("telegram_links").delete().eq("chat_id", chat).neq("player_id", match.id);
  await sb.from("telegram_links").upsert({ player_id: match.id, chat_id: chat, tg_name: [msg.from?.first_name, msg.from?.username ? "@" + msg.from.username : ""].filter(Boolean).join(" "), linked_at: new Date().toISOString() });
  await say(chat, `✅ Linked to <b>${esc(nm[match.id] || "your player profile")}</b>.\nYou'll get your groups, fixtures and deadline reminders here.\n\nSend /fixtures any time to see them again, /deadline for the matches you still have to play before the group deadline, or /stop to unlink.`, { reply_markup: { remove_keyboard: true } });
  await sendCurrent(chat, match.id, nm);
}
function contactKeyboard() {
  return { reply_markup: { keyboard: [[{ text: "📱 Share my phone number", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
}
async function sendCurrent(chat: number, pid: string, nm?: Record<string, string>) {
  nm = nm || await names();
  const texts = (await activeTournaments()).map((t) => fixturesText(t, pid, nm!)).filter(Boolean) as string[];
  if (!texts.length) return say(chat, "You have no fixtures in a live tournament right now. You'll get them here as soon as the next draw is made.");
  for (const x of texts) await say(chat, x);
}

async function onUpdate(u: Obj) {
  const msg = u.message;
  if (!msg || msg.chat?.type !== "private") return;
  const chat = msg.chat.id;
  if (msg.contact) return linkByPhone(msg);
  const text = String(msg.text || "").trim();
  const { data: link } = await sb.from("telegram_links").select("player_id").eq("chat_id", chat).maybeSingle();
  if (/^\/stop\b/.test(text)) {
    await sb.from("telegram_links").delete().eq("chat_id", chat);
    return say(chat, "You're unlinked and won't get messages from this bot. Tap /start to link again.");
  }
  if (/^\/fixtures\b/.test(text) && link) return sendCurrent(chat, link.player_id);
  if (/^\/deadline\b/.test(text) && link) {
    const nm = await names();
    const texts = (await activeTournaments()).map((t) => deadlineText(t, link.player_id, nm, "now")).filter(Boolean) as string[];
    if (!texts.length) return say(chat, "✅ You have no group-stage matches left to play before a deadline right now.");
    for (const x of texts) await say(chat, x);
    return;
  }
  if (link) {
    const nm = await names();
    return say(chat, `You're linked as <b>${esc(nm[link.player_id] || "a player")}</b>.\n/fixtures – your current fixtures\n/deadline – group deadline and the matches you still have to play\n/stop – unlink this Telegram`);
  }
  return say(chat, "👋 Welcome to <b>MG eFootball</b>.\n\nTap the button below to share your phone number. It's matched with the number the organisers have for you, so your groups, fixtures and deadline reminders come straight here.", contactKeyboard());
}

/* ---- Sending to a tournament's players ---- */
async function linksFor(pids: string[]) {
  const { data } = await sb.from("telegram_links").select("player_id,chat_id").in("player_id", pids.length ? pids : ["-"]);
  return new Map((data || []).map((r: Obj) => [r.player_id, r.chat_id]));
}
async function sendTournament(t: Obj, only?: (pid: string) => string | null, onlyPids?: string[]) {
  const nm = await names();
  const pids = (t.registrations || []).map((r: Obj) => r.playerId).filter((p: string) => !onlyPids || onlyPids.includes(p));
  const links = await linksFor(pids);
  let sent = 0, failed = 0, skipped = 0;
  for (const pid of pids) {
    const chat = links.get(pid);
    if (!chat) continue;
    const text = only ? only(pid) : fixturesText(t, pid, nm);
    if (!text) { skipped++; continue; }
    const r = await say(chat, text);
    if (r?.ok) sent++;
    else { failed++; if (r?.error_code === 403) await sb.from("telegram_links").delete().eq("chat_id", chat); }
    await new Promise((res) => setTimeout(res, 40));
  }
  return { sent, failed, skipped, linked: [...links.keys()].length, total: pids.length };
}

async function isOrganiser(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await user.rpc("is_organiser");
  return data === true;
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const s = await secrets();
    // Telegram webhook
    if (req.headers.get("x-telegram-bot-api-secret-token")) {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== s.telegram_webhook_secret) return new Response("forbidden", { status: 403 });
      await onUpdate(await req.json());
      return new Response("ok");
    }
    const body = await req.json().catch(() => ({}));
    const internal = req.headers.get("x-hook-secret") === s.hook_secret;
    if (!internal && !(await isOrganiser(req))) return json({ error: "Organisers only" }, 403);

    if (body.action === "setup" && internal) {
      const r = await tg("setWebhook", { url: `${URL_}/functions/v1/telegram`, secret_token: s.telegram_webhook_secret, allowed_updates: ["message"], drop_pending_updates: true });
      await tg("setMyCommands", { commands: [{ command: "fixtures", description: "My current fixtures" }, { command: "deadline", description: "Group deadline and my matches left" }, { command: "stop", description: "Unlink this Telegram" }] });
      return json(r);
    }
    if (body.action === "info") {
      const { count } = await sb.from("telegram_links").select("player_id", { count: "exact", head: true });
      return json({ bot: BOT, link: `https://t.me/${BOT}?start=link`, linked: count || 0 });
    }
    const t = body.tid ? await tournament(body.tid) : null;
    if (!t) return json({ error: "Tournament not found" }, 404);

    if (body.action === "texts") {
      const nm = await names();
      const pids = (t.registrations || []).map((r: Obj) => r.playerId);
      const links = await linksFor(pids);
      return json({ players: pids.map((pid: string) => ({ pid, linked: links.has(pid), text: fixturesText(t, pid, nm, false) })) });
    }
    if (body.action === "deadline") {
      const nm = await names();
      if (body.preview) {
        const pids = (t.registrations || []).map((r: Obj) => r.playerId);
        const links = await linksFor(pids);
        return json({ players: pids.map((pid: string) => ({ pid, linked: links.has(pid), text: deadlineText(t, pid, nm, "now", false) })) });
      }
      return json(await sendTournament(t, (pid) => deadlineText(t, pid, nm, "now")));
    }
    if (body.action === "send" || body.action === "auto") return json(await sendTournament(t, undefined, Array.isArray(body.pids) ? body.pids : undefined));
    if (body.action === "remind" && internal) {
      // body.left: { [playerId]: matches still to play } for the stage whose deadline is near.
      if (!body.round) { const nm = await names(); return json(await sendTournament(t, (pid) => deadlineText(t, pid, nm, "auto"))); }
      const left: Obj = body.left || {};
      const label = body.round ? `${body.round}` : t.format === "league" ? "League" : "Group stage";
      return json(await sendTournament(t, (pid) => left[pid] ? `⏰ <b>2 hours left</b> · ${esc(t.name)}\n${esc(label)} deadline is <b>${esc(body.clock || "")}</b>.\nYou still have <b>${left[pid]}</b> match${left[pid] > 1 ? "es" : ""} to play.${body.round ? "" : " Unplayed matches count as 0-0 draws."}\n${APP}/#t=${t.id}` : null));
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error" }, 500);
  }
});
