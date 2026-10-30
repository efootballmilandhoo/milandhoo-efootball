
/* =========================
   UPDATES FEED (in-app) + ADD TO HOME SCREEN
   Push notifications reach closed apps (see sbdb.js). While the app is open,
   updates are also detected from live data and kept in a per-device feed.
   ========================= */
const APP_LINK = location.origin;
const NOTIF = {
  feed: LS.get('notif_feed', []) || [],
  lastRead: LS.get('notif_read', 0) || 0,
  popups: LS.get('notif_popups', true) !== false,
  seeded: false, timer: null, open: false
};
function nsave(k, v){ try{ localStorage.setItem('mec_'+k, JSON.stringify(v)) }catch{} }

function scoreLine(a, b){ return `${a}–${b}` }
function deriveEvents(){
  const ev = [];
  const name = id => playerName(id);
  STORE.tournaments.forEach(t=>{
    if(t.status==='draft') return;
    const tn = t.name || 'Tournament';
    ev.push({key:'tn:'+t.id, kind:'new', title:`New tournament: ${tn}`, sub: t.status==='open' ? 'Registration is open' : 'Added to tournaments', tid:t.id});
    if(t.startedAt || t.groupsDrawn) ev.push({key:'ts:'+t.id, kind:'start', title:`${tn} has started`, sub: t.groupsDrawn && t.format!=='single_elimination' ? 'Groups and fixtures are out' : 'The bracket is out', tid:t.id});
    if(t.format==='group_knockout' && t.knockoutDrawn) ev.push({key:'kd:'+t.id, kind:'draw', title:`${tn}: knockout draw is out`, sub:'See who plays who in the bracket', tid:t.id});
    // Group-stage results are not announced one by one; each group is announced once all its fixtures have scores.
    const quietGroups = t.format==='group_knockout';
    if(quietGroups) (t.groupData||[]).forEach(g=>{
      const fx = (t.fixtures||[]).filter(f=>f.group===g.name);
      if(!fx.length || !fx.every(f=>hasScore(f.score1) && hasScore(f.score2))) return;
      const top = computeStandings(t, g).slice(0, Math.max(1, t.qualifyPerGroup||1)).map(r=>name(r.playerId));
      ev.push({key:`gc:${t.id}:${g.name}`, kind:'result', title:`${tn}: Group ${g.name} is complete`, sub: top.length ? `Through to the knockouts: ${top.join(', ')}` : 'See the final group standings', tid:t.id});
    });
    (t.fixtures||[]).forEach(f=>{
      if(quietGroups && f.group) return;
      if(!hasScore(f.score1) || !hasScore(f.score2)) return;
      ev.push({key:`fx:${t.id}:${f.id}:${f.score1}-${f.score2}`, kind:'result', title:`${name(f.team1)} ${scoreLine(f.score1,f.score2)} ${name(f.team2)}`, sub:`${tn}${f.group?' · Group '+f.group:''}`, tid:t.id});
    });
    (t.knockoutBracket||[]).forEach(round=>round.forEach(m=>{
      if(m.isBye || !m.winner || !m.team1 || !m.team2) return;
      const loser = m.winner===m.team1 ? m.team2 : m.team1;
      let sc = '';
      try{ const r = koResult(t, m); if(r && r.total){ const w = m.winner===m.team1 ? 0 : 1; sc = ' ' + scoreLine(r.total[w], r.total[1-w]) + (r.byPens ? ' (pens)' : '') } }catch{}
      ev.push({key:`ko:${t.id}:${m.id}:${m.winner}`, kind:'result', title:`${name(m.winner)} beat ${name(loser)}${sc}`, sub:`${tn} · ${m.round || 'Knockout'}`, tid:t.id});
    }));
    if(t.status==='completed' && t.champion) ev.push({key:'tc:'+t.id, kind:'champion', title:`${name(t.champion)} won ${tn}!`, sub: t.runnerUp ? `Runner-up: ${name(t.runnerUp)}` : 'Tournament complete', tid:t.id});
  });
  // Deadline reminders: shown once, during the last 2 hours before a deadline with matches still to play.
  const now = Date.now(), soon = d => { const ms = new Date(d).getTime(); return ms > now && ms - now <= 2*3600e3 };
  const hhmm = d => new Date(d).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  STORE.tournaments.forEach(t=>{
    if(t.status!=='active') return;
    const tn = t.name || 'Tournament', league = t.format==='league';
    if(t.format!=='single_elimination' && t.groupDeadline && !t.deadlineProcessed && soon(t.groupDeadline)){
      const left = (t.fixtures||[]).filter(f=>(league || f.group) && !(hasScore(f.score1) && hasScore(f.score2))).length;
      if(left) ev.push({key:`dl:g:${t.id}:${t.groupDeadline}`, kind:'reminder', title:`2 hours left: ${tn}`, sub:`${league?'League':'Group stage'} deadline ${hhmm(t.groupDeadline)} · ${left} match${left>1?'es':''} to play`, tid:t.id});
    }
    Object.entries(t.rules?.roundDeadlines||{}).forEach(([round, d])=>{
      if(!d || !soon(d)) return;
      const ms = ((t.knockoutBracket||[]).find(r=>r?.[0]?.round===round)||[]).filter(m=>!m.isBye && m.team1 && m.team2 && !m.winner).length;
      if(ms) ev.push({key:`dl:k:${t.id}:${round}:${d}`, kind:'reminder', title:`2 hours left: ${tn} · ${round}`, sub:`Round deadline ${hhmm(d)} · ${ms} match${ms>1?'es':''} to play`, tid:t.id});
    });
  });
  return ev;
}

function checkUpdates(){
  if(!(STORE.loaded && STORE.loaded.players && STORE.loaded.tournaments)) return;
  let events; try{ events = deriveEvents() }catch(e){ console.error(e); return }
  const keys = events.map(e=>e.key);
  const seen = LS.get('notif_seen', null);
  if(!seen){ nsave('notif_seen', keys); NOTIF.seeded = true; renderBell(); return }
  const seenSet = new Set(seen);
  // First run with group-complete notices: groups finished earlier count as already seen.
  if(!LS.get('notif_gc_v1', false)){ keys.filter(k=>k.startsWith('gc:')).forEach(k=>seenSet.add(k)); nsave('notif_gc_v1', true) }
  const fresh = events.filter(e=>!seenSet.has(e.key));
  nsave('notif_seen', keys);
  NOTIF.seeded = true;
  if(!fresh.length){ renderBell(); return }
  const now = Date.now();
  const mine = now - (STORE.lastLocalWrite||0) < 5000;
  fresh.forEach((e,i)=>{ e.at = now + i; e.mine = mine });
  NOTIF.feed = [...fresh.reverse(), ...NOTIF.feed].slice(0, 60);
  nsave('notif_feed', NOTIF.feed);
  if(mine){ NOTIF.lastRead = Math.max(NOTIF.lastRead, now + fresh.length); nsave('notif_read', NOTIF.lastRead) }
  else if(NOTIF.popups) showAlert(fresh);
  renderBell();
  if(!mine) ringBell();
  if(NOTIF.open) renderNotifPanel();
}
function scheduleUpdateCheck(){ clearTimeout(NOTIF.timer); NOTIF.timer = setTimeout(checkUpdates, 350) }

const KIND_ICON = {
  result:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7l3 2.2-1.1 3.6h-3.8L9 9.2z"/></svg>',
  champion:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 14v3M8 21h8M9 17h6"/></svg>',
  hof:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/></svg>',
  reminder:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 3L2 6M19 3l3 3"/></svg>',
  new:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  start:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4l12 8-12 8z"/></svg>',
  draw:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h5v12H4M20 9h-5v6h5M9 12h6"/></svg>'
};
const BELL_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

const isUnread = e => !e.read && e.at > NOTIF.lastRead;
function unreadCount(){ return NOTIF.feed.filter(isUnread).length }
function renderBell(){
  document.querySelectorAll('[data-bell]').forEach(btn=>{
    const n = unreadCount();
    const html = BELL_SVG + (n ? `<span class="bell-badge">${n>9?'9+':n}</span>` : '');
    if(btn._html!==html){ btn.innerHTML = html; btn._html = html }
    btn.setAttribute('aria-label', n ? `Updates, ${n} unread` : 'Updates');
    btn.setAttribute('aria-expanded', NOTIF.open ? 'true' : 'false');
  });
}
function timeAgo(ms){
  const s = Math.max(0, (Date.now()-ms)/1000);
  if(s<60) return 'Just now';
  if(s<3600) return Math.floor(s/60)+' min ago';
  if(s<86400) return Math.floor(s/3600)+' h ago';
  if(s<86400*7) return Math.floor(s/86400)+' d ago';
  return fmtDate(ms);
}
function notifItem(e){
  const unread = isUnread(e);
  return `<button type="button" class="notif-item ${unread?'unread':''}" onclick="openUpdate('${esc(e.key)}')">
    <span class="notif-ic k-${e.kind}">${KIND_ICON[e.kind]||KIND_ICON.result}</span>
    <span class="notif-txt"><b>${esc(e.title)}</b><span>${esc(e.sub||'')}</span></span>
    <span class="notif-time">${timeAgo(e.at)}</span>
  </button>`;
}
function renderNotifPanel(){
  let p = document.getElementById('notifPanel');
  if(!p){ p = document.createElement('div'); p.id = 'notifPanel'; p.className = 'notif-panel'; p.setAttribute('role','dialog'); p.setAttribute('aria-label','Updates'); document.body.appendChild(p) }
  const n = unreadCount();
  p.innerHTML = `
    <div class="notif-head">
      <div><b>Updates</b><span>${n ? n+' new' : 'You’re all caught up'}</span></div>
      <div class="flex gap-8">
        ${n ? `<button type="button" class="btn btn-ghost btn-sm" onclick="markAllRead()">Mark all read</button>` : ''}
        <button type="button" class="btn btn-ghost btn-icon" onclick="toggleNotifPanel(false)" aria-label="Close updates">${ICON_X}</button>
      </div>
    </div>
    <div class="notif-list">
      ${NOTIF.feed.length ? NOTIF.feed.map(notifItem).join('') : `<div class="notif-empty">${BELL_SVG}<b>No updates yet</b><span>New tournaments, results, champions and deadline reminders will show up here.</span></div>`}
    </div>
    <div class="notif-foot">
      ${pushControlHTML()}
      <label class="switch-row"><span><b>Pop-up alerts</b><span>Show a card when something new happens while the app is open</span></span>
        <input type="checkbox" class="switch" ${NOTIF.popups?'checked':''} onchange="setPopups(this.checked)"></label>
      ${isStandalone() ? '' : `<button type="button" class="btn btn-secondary btn-block" onclick="toggleNotifPanel(false);installApp()">${INSTALL_SVG} Add to home screen</button>`}
    </div>`;
}
function toggleNotifPanel(force){
  NOTIF.open = typeof force==='boolean' ? force : !NOTIF.open;
  if(NOTIF.open){ renderNotifPanel(); document.getElementById('notifPanel').classList.add('show'); document.getElementById('notifScrim')?.classList.add('show') }
  else { document.getElementById('notifPanel')?.classList.remove('show'); document.getElementById('notifScrim')?.classList.remove('show') }
  renderBell();
}
function markAllRead(){
  NOTIF.lastRead = Math.max(Date.now(), ...NOTIF.feed.map(e=>e.at)); nsave('notif_read', NOTIF.lastRead);
  renderBell(); if(NOTIF.open) renderNotifPanel();
}
function setPopups(on){ NOTIF.popups = on; nsave('notif_popups', on); toast(on ? 'Pop-up alerts on' : 'Pop-up alerts off') }
function openUpdate(key){
  const e = NOTIF.feed.find(x=>x.key===key); if(!e) return;
  e.read = true; nsave('notif_feed', NOTIF.feed); renderBell();
  toggleNotifPanel(false); dismissAlert();
  if(e.tid && STORE.tournaments.some(t=>t.id===e.tid)) navigate('tournament-detail', e.tid);
  else if(e.view) navigate(e.view);
}

function showAlert(list){
  dismissAlert();
  const a = document.createElement('div');
  a.className = 'live-alert'; a.id = 'liveAlert'; a.setAttribute('role','status'); a.setAttribute('aria-live','polite');
  const top = list.slice(-1)[0], more = list.length - 1;
  a.innerHTML = `
    <span class="notif-ic k-${top.kind}">${KIND_ICON[top.kind]||KIND_ICON.result}</span>
    <span class="notif-txt"><span class="live-alert-tag">${more ? list.length+' new updates' : 'New update'}</span><b>${esc(top.title)}</b><span>${esc(top.sub||'')}${more ? ` · and ${more} more` : ''}</span></span>
    <span class="live-alert-actions">
      <button type="button" class="btn btn-primary btn-sm" onclick="${more ? 'dismissAlert();toggleNotifPanel(true)' : `openUpdate('${esc(top.key)}')`}">${more ? 'See all' : 'View'}</button>
      <button type="button" class="live-alert-x" onclick="dismissAlert()" aria-label="Dismiss">&times;</button>
    </span>`;
  document.body.appendChild(a);
  NOTIF.alertTimer = setTimeout(dismissAlert, 9000);
}
function dismissAlert(){ clearTimeout(NOTIF.alertTimer); document.getElementById('liveAlert')?.remove() }

/* ---- Add to home screen ---- */
const INSTALL_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M12 7v7M9 11l3 3 3-3M10 18h4"/></svg>';
function detectDevice(){
  const ua = navigator.userAgent || '';
  if(/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if(/Android/.test(ua)) return 'android';
  return 'desktop';
}
const INSTALL_STEPS = {
  ios: {label:'iPhone / iPad', steps:[
    'Open this site in <b>Safari</b> (if you opened the link inside Instagram, Facebook or WhatsApp, tap <b>⋯</b> and choose <b>Open in Safari</b> first).',
    'Tap the <b>Share</b> button (the square with an arrow pointing up).',
    'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.',
    'Open the app from your home screen, tap the <b>bell</b> and press <b>Turn on</b> to get notifications (iOS 16.4 or newer).']},
  android: {label:'Android', steps:[
    'Open this site in <b>Chrome</b>.',
    'Tap the <b>⋮</b> menu at the top right.',
    'Tap <b>Install app</b> (on some phones it says <b>Add to Home screen</b>), then <b>Install</b>.',
    'Open the app, tap the <b>bell</b> and press <b>Turn on</b> to get notifications.']},
  desktop: {label:'Computer', steps:[
    'Open this site in <b>Chrome</b> or <b>Edge</b>.',
    'Click the <b>install</b> icon at the right end of the address bar (a screen with a down arrow), then <b>Install</b>.',
    'Open the app, click the <b>bell</b> and press <b>Turn on</b> to get notifications.']}
};
let installTab = null;
function openInstallModal(tab){
  installTab = tab || installTab || detectDevice();
  const cur = INSTALL_STEPS[installTab];
  openModal(`
    <div class="modal-head"><div class="modal-title">Install the app</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">${ICON_X}</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:16px">
      <div class="seg-tabs" role="tablist">${Object.entries(INSTALL_STEPS).map(([k,v])=>`<button type="button" role="tab" aria-selected="${k===installTab}" class="${k===installTab?'on':''}" onclick="openInstallModal('${k}')">${v.label}</button>`).join('')}</div>
      <ol class="install-steps">${cur.steps.map(s=>`<li><span>${s}</span></li>`).join('')}</ol>
      <div class="link-box">
        <input class="form-input" id="appLink" readonly value="${APP_LINK}" aria-label="App link" onclick="this.select()">
        <button type="button" class="btn btn-primary" onclick="copyAppLink()">Copy link</button>
      </div>
      <div class="config-helper">Share this link with the community so everyone can install the app and get notifications.</div>
    </div>
    <div class="modal-foot"><button type="button" class="btn btn-primary" onclick="closeModal()">Done</button></div>`);
}
async function copyAppLink(){
  const inp = document.getElementById('appLink');
  try{ await navigator.clipboard.writeText(APP_LINK); toast('Link copied') }
  catch{ try{ inp.select(); document.execCommand('copy') ? toast('Link copied') : toast('Select the link and copy it', true) }catch{ toast('Select the link and copy it', true) } }
}
function installBannerHTML(){
  if(LS.get('install_hide', false) || isStandalone()) return '';
  return `<div class="install-banner" id="installBanner">
    <span class="install-ic">${INSTALL_SVG}</span>
    <span class="notif-txt"><b>Install the ${esc(titleCase(commName()))} app</b><span>Open it in one tap from your home screen and get notified about results, draws and champions.</span></span>
    <span class="install-actions"><button type="button" class="btn btn-primary btn-sm" onclick="installApp()">${deferredInstall ? 'Install' : 'Show me how'}</button><button type="button" class="btn btn-ghost btn-sm" onclick="hideInstallBanner()">Not now</button></span>
  </div>`;
}
function hideInstallBanner(){ nsave('install_hide', true); document.getElementById('installBanner')?.remove() }

document.addEventListener('keydown', e=>{ if(e.key==='Escape' && NOTIF.open) toggleNotifPanel(false) });
setInterval(()=>{ checkUpdates(); if(NOTIF.open) renderNotifPanel() }, 60000);

/* =========================
   MOTION
   Entrance animations play only when a page or tab opens (not on live data
   refreshes), and never while an image export is being captured.
   ========================= */
function reduceMotion(){ try{ return window.matchMedia('(prefers-reduced-motion: reduce)').matches }catch{ return false } }
let enterTimer = null;
function playEnter(){
  const m = document.getElementById('main'); if(!m || reduceMotion()) return;
  m.classList.remove('enter'); void m.offsetWidth; m.classList.add('enter');
  clearTimeout(enterTimer); enterTimer = setTimeout(()=>m.classList.remove('enter'), 1200);
  countUp(m);
}
function countUp(root){
  root.querySelectorAll('.stat-value').forEach(el=>{
    const txt = el.textContent.trim();
    if(!/^\d{1,6}$/.test(txt)) return;
    const end = +txt; if(end < 2) return;
    const t0 = performance.now(), dur = Math.min(1100, 500 + end*8);
    const step = now=>{
      if(!el.isConnected) return;
      const k = Math.min(1, (now - t0)/dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(end*e));
      if(k < 1) requestAnimationFrame(step); else el.textContent = txt;
    };
    el.textContent = '0'; requestAnimationFrame(step);
  });
}
function ringBell(){
  if(reduceMotion()) return;
  document.querySelectorAll('[data-bell]').forEach(b=>{ b.classList.remove('ring'); void b.offsetWidth; b.classList.add('ring'); setTimeout(()=>b.classList.remove('ring'), 1000) });
}
