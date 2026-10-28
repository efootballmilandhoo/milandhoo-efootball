/* =========================
   SUPABASE BACKEND
   A small adapter with the same shape the app already uses:
   db.collection(path).onSnapshot(cb, err) and db.doc(path).set(data) / .delete().
   Public data lives in "docs"; phone numbers in "private_docs" (organisers only).
   ========================= */
const SUPABASE_URL = 'https://pdgkxbkxpzinlbyedvco.supabase.co';
const SUPABASE_KEY = 'sb_publishable_VmXfs5971PXNgwnRu4yp6g_rwXlriC-';
const VAPID_PUBLIC = 'BHY6YiUTlYM17L_WvFhp5ZFYR4nE9EOS76Zp6n_jxoah1c8Si-seaHLwAfxUOZbS3tkPM3tWiqT8gKpBvWpdB40';

function sbPath(path){
  const s = String(path).split('/');
  if(s[0]==='data' && s[1]==='private') return {table:'private_docs', coll:s[2], id:s[3]};
  return {table:'docs', coll:s[0], id:s[1]};
}
function sbError(error){
  const e = new Error(error?.message || 'error');
  const code = String(error?.code || '');
  e.code = code==='42501' || /row-level security|permission/i.test(error?.message||'') ? 'invalid_argument'
    : /fetch|network|timeout|Failed/i.test(error?.message||'') || code==='' ? 'unavailable'
    : code==='54000' || /too large|payload/i.test(error?.message||'') ? 'quota_exceeded' : 'error';
  return e;
}

function makeSupabaseDb(sb){
  const watchers = {docs:new Map(), private_docs:new Map()}; // coll -> {rows:Map, cbs:[]}
  const channels = {};
  function emit(table, coll){
    const w = watchers[table].get(coll); if(!w) return;
    const docs = [...w.rows.entries()].map(([id, data])=>({id, exists:true, data:()=>data}));
    w.cbs.forEach(c=>{ try{ c.cb({docs, size:docs.length, empty:!docs.length}) }catch(e){ console.error(e) } });
  }
  /* Loads a whole collection; on a bad connection it keeps retrying quietly (3s, 6s, 12s … up to a minute). */
  async function loadAll(table, coll, attempt=0){
    const w = watchers[table].get(coll); if(!w) return;
    clearTimeout(w.retry);
    const rows = new Map();
    for(let from=0;;from+=1000){
      let res;
      try{ res = await sb.from(table).select('id,data').eq('coll', coll).order('id').range(from, from+999) }catch(e){ res = {error:{message:String(e && e.message || 'Failed to fetch')}} }
      const {data, error} = res;
      if(error){
        if(attempt===0) w.cbs.forEach(c=>c.err && c.err(sbError(error)));
        w.retry = setTimeout(()=>loadAll(table, coll, attempt+1), Math.min(60000, 3000*2**attempt));
        return;
      }
      data.forEach(r=>rows.set(r.id, r.data));
      if(data.length<1000) break;
    }
    w.rows = rows; w.loaded = true; emit(table, coll);
  }
  async function loadOne(table, coll, id){
    const w = watchers[table].get(coll); if(!w) return;
    const {data, error} = await sb.from(table).select('id,data').eq('coll', coll).eq('id', id).maybeSingle();
    if(error) return;
    if(data) w.rows.set(id, data.data); else w.rows.delete(id);
    emit(table, coll);
  }
  function ensureChannel(table){
    if(channels[table]) return;
    let wasDown = false;
    channels[table] = sb.channel('rt-'+table)
      .on('postgres_changes', {event:'*', schema:'public', table}, p=>{
        const rec = p.eventType==='DELETE' ? p.old : p.new;
        if(!rec || !rec.coll || !watchers[table].has(rec.coll)) return;
        const w = watchers[table].get(rec.coll);
        if(p.eventType==='DELETE'){ w.rows.delete(rec.id); emit(table, rec.coll); return }
        // Large rows can arrive without their data; fetch them when that happens.
        if(rec.data && typeof rec.data==='object'){ w.rows.set(rec.id, rec.data); emit(table, rec.coll) }
        else loadOne(table, rec.coll, rec.id);
      })
      .subscribe(status=>{
        if(status==='SUBSCRIBED'){ if(wasDown){ watchers[table].forEach((_, coll)=>loadAll(table, coll)) } wasDown = false }
        else if(status==='CHANNEL_ERROR' || status==='TIMED_OUT' || status==='CLOSED') wasDown = true;
      });
  }
  // Phones and tablets drop live connections in the background, so refresh on return.
  const reloadAll = ()=>Object.keys(watchers).forEach(table=>watchers[table].forEach((_, coll)=>loadAll(table, coll)));
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') reloadAll() });
  window.addEventListener('online', reloadAll);
  return {
    collection(path){
      const m = sbPath(path);
      return {
        onSnapshot(cb, err){
          let w = watchers[m.table].get(m.coll);
          if(!w){ w = {rows:new Map(), cbs:[], loaded:false}; watchers[m.table].set(m.coll, w) }
          w.cbs.push({cb, err});
          ensureChannel(m.table);
          if(w.loaded) emit(m.table, m.coll); else loadAll(m.table, m.coll);
          return ()=>{ w.cbs = w.cbs.filter(x=>x.cb!==cb) };
        }
      };
    },
    doc(path){
      const m = sbPath(path);
      return {
        async set(data){
          const {error} = await sb.from(m.table).upsert({coll:m.coll, id:m.id, data, updated_at:new Date().toISOString()});
          if(error) throw sbError(error);
          const w = watchers[m.table].get(m.coll); if(w){ w.rows.set(m.id, data) }
        },
        async delete(){
          const {error} = await sb.from(m.table).delete().eq('coll', m.coll).eq('id', m.id);
          if(error) throw sbError(error);
          const w = watchers[m.table].get(m.coll); if(w){ w.rows.delete(m.id) }
        }
      };
    }
  };
}

/* ---- Organiser sign-in ---- */
const AUTH = {sb:null, user:null, role:null, organisers:[]};
async function loadRole(){
  const {data:{session}} = await AUTH.sb.auth.getSession();
  AUTH.user = session?.user || null;
  AUTH.role = null;
  if(AUTH.user){ const {data, error} = await AUTH.sb.rpc('my_role'); if(!error) AUTH.role = data || null }
  STORE.admin = !!AUTH.role;
  STORE.owner = AUTH.role==='owner';
}
async function signIn(){
  if(!AUTH.sb){ toast('Still connecting. Try again in a moment.', true); return }
  const email = document.getElementById('si_email').value.trim().toLowerCase(), pw = document.getElementById('si_pw').value;
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ toast('Enter your email address', true); return }
  if(pw.length<8){ toast('Passwords are at least 8 characters', true); return }
  setBusy('si_btn', true);
  const {error} = await AUTH.sb.auth.signInWithPassword({email, password:pw});
  setBusy('si_btn', false);
  if(error){
    toast(/confirm/i.test(error.message) ? 'Confirm your email first: open the link we emailed you.' : /invalid/i.test(error.message) ? 'Wrong email or password' : error.message, true);
    return;
  }
  location.reload();
}
async function signUp(){
  if(!AUTH.sb){ toast('Still connecting. Try again in a moment.', true); return }
  const email = document.getElementById('si_email').value.trim().toLowerCase(), pw = document.getElementById('si_pw').value;
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ toast('Enter your email address', true); return }
  if(pw.length<8){ toast('Choose a password with at least 8 characters', true); return }
  setBusy('su_btn', true);
  const {data, error} = await AUTH.sb.auth.signUp({email, password:pw, options:{emailRedirectTo: location.origin + '/#admin'}});
  setBusy('su_btn', false);
  if(error){ toast(error.message, true); return }
  if(data.session){ location.reload(); return }
  document.getElementById('si_msg').innerHTML = `<div class="config-helper"><b>Check your email.</b> We sent a confirmation link to ${esc(email)}. Open it, then come back here and sign in.</div>`;
}
async function forgotPassword(){
  if(!AUTH.sb){ toast('Still connecting. Try again in a moment.', true); return }
  const email = document.getElementById('si_email').value.trim().toLowerCase();
  if(!email){ toast('Enter your email first', true); document.getElementById('si_email').focus(); return }
  const {error} = await AUTH.sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + '/#reset'});
  if(error){ toast(error.message, true); return }
  document.getElementById('si_msg').innerHTML = `<div class="config-helper">If ${esc(email)} has an account, a link to reset the password is on its way.</div>`;
}
async function signOut(){
  if(!AUTH.sb){ toast('Still connecting. Try again in a moment.', true); return }
  const ok = await confirmDialog('Sign out', 'Sign out of organiser tools on this device?', 'Sign out');
  if(!ok) return;
  try{ localStorage.removeItem(ROLE_KEY) }catch{}
  await AUTH.sb.auth.signOut();
  location.hash = ''; location.reload();
}
function setBusy(id, on){ const b = document.getElementById(id); if(b){ b.disabled = on; b.classList.toggle('busy', on) } }

function renderSignIn(main, mark){
  const signedInNotOrganiser = !!AUTH.user;
  main.innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="login-brand">${mark}<h1>Organiser sign in</h1><p>Players, fixtures and results are managed by the community's organisers. Everyone else can follow along from the other pages.</p></div>
      ${signedInNotOrganiser ? `
        <div class="config-helper">You're signed in as <b>${esc(AUTH.user.email)}</b>, but that email isn't on the organiser list yet. Ask the community owner to add it in the Admin Panel, then reload.</div>
        <button type="button" class="btn btn-secondary btn-block mt-16" onclick="signOut()">Sign out</button>` : `
        <div class="form-group"><label class="form-label" for="si_email">Email</label><input class="form-input" type="email" id="si_email" autocomplete="email" placeholder="you@example.com"></div>
        <div class="form-group"><label class="form-label" for="si_pw">Password</label><input class="form-input" type="password" id="si_pw" autocomplete="current-password" placeholder="At least 8 characters" onkeydown="if(event.key==='Enter')signIn()"></div>
        <button type="button" class="btn btn-primary btn-block" id="si_btn" onclick="signIn()">Sign in</button>
        <div class="signin-alt">
          <button type="button" class="btn-link" onclick="forgotPassword()">Forgot password?</button>
          <span>First time? <button type="button" class="btn-link" id="su_btn" onclick="signUp()">Create your account</button></span>
        </div>
        <div id="si_msg"></div>
        <div class="text-xs text-muted" style="text-align:center;margin-top:14px">Only emails on the organiser list can manage the community. Creating an account with another email gives view-only access.</div>`}
    </div></div>`;
  setTimeout(()=>document.getElementById('si_email')?.focus(), 50);
}

function renderResetPassword(main, mark){
  main.innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <div class="login-brand">${mark}<h1>Choose a new password</h1><p>Enter a new password for ${esc(AUTH.user?.email||'your account')}.</p></div>
      <div class="form-group"><label class="form-label" for="rp_pw">New password</label><input class="form-input" type="password" id="rp_pw" autocomplete="new-password" placeholder="At least 8 characters" onkeydown="if(event.key==='Enter')saveNewPassword()"></div>
      <button type="button" class="btn btn-primary btn-block" id="rp_btn" onclick="saveNewPassword()">Save password</button>
    </div></div>`;
}
async function saveNewPassword(){
  const pw = document.getElementById('rp_pw').value;
  if(pw.length<8){ toast('Use at least 8 characters', true); return }
  setBusy('rp_btn', true);
  const {error} = await AUTH.sb.auth.updateUser({password:pw});
  setBusy('rp_btn', false);
  if(error){ toast(error.message, true); return }
  STORE.resetMode = false; location.hash = '#admin'; location.reload();
}

/* ---- Organiser list (owner manages) ---- */
async function loadOrganisers(){
  const {data, error} = await AUTH.sb.from('organisers').select('email,role,added_at').order('role', {ascending:false}).order('email');
  AUTH.orgLoaded = true;
  if(!error){ AUTH.organisers = data || []; if(currentView==='admin') renderOrganiserList() }
}
function organisersCardHTML(){
  return `
    <section class="card card-navy" style="display:flex;flex-direction:column;gap:12px">
      <h2 class="card-title">Organisers</h2>
      <p style="color:var(--on-navy-soft);font-size:14px">Signed in as <b style="color:#fff">${esc(AUTH.user?.email||'')}</b> (${AUTH.role==='owner'?'owner':'organiser'}). People on this list can manage players, tournaments and results after signing in. Everyone else sees results read-only.</p>
      <div id="orgList" class="org-list"><div class="text-sm" style="color:var(--on-navy-soft)">Loading…</div></div>
      ${STORE.owner ? `<div class="org-add"><input class="form-input" type="email" id="org_email" placeholder="Add organiser email" aria-label="Organiser email" onkeydown="if(event.key==='Enter')addOrganiser()"><button type="button" class="btn btn-primary" onclick="addOrganiser()">Add</button></div>
      <div class="text-xs" style="color:var(--on-navy-soft)">They create their account with this email from the Admin Panel sign-in page.</div>` : ''}
      <div class="toolbar-actions" style="margin-top:auto"><button type="button" class="btn btn-outline-navy" onclick="signOut()">Sign out</button></div>
    </section>`;
}
function renderOrganiserList(){
  const el = document.getElementById('orgList'); if(!el) return;
  if(!AUTH.orgLoaded){ el.innerHTML = '<div class="text-sm" style="color:var(--on-navy-soft)">Loading…</div>'; return }
  el.innerHTML = AUTH.organisers.map(o=>`<div class="org-row"><span class="org-email">${esc(o.email)}</span><span class="org-role">${o.role==='owner'?'Owner':'Organiser'}</span>${STORE.owner && o.role!=='owner' ? `<button type="button" class="btn btn-sm btn-outline-navy" onclick="removeOrganiser('${esc(o.email)}')">Remove</button>`:''}</div>`).join('') || '<div class="text-sm">No organisers yet</div>';
}
async function addOrganiser(){
  const inp = document.getElementById('org_email'); const email = inp.value.trim().toLowerCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ toast('Enter a valid email', true); return }
  const {error} = await AUTH.sb.from('organisers').insert({email, role:'organiser'});
  if(error){ toast(/duplicate/i.test(error.message) ? 'That email is already an organiser' : 'Could not add organiser', true); return }
  inp.value = ''; toast('Organiser added'); loadOrganisers();
}
async function removeOrganiser(email){
  const ok = await confirmDialog('Remove organiser', `Remove ${email}? They will lose access to organiser tools.`, 'Remove');
  if(!ok) return;
  const {error} = await AUTH.sb.from('organisers').delete().eq('email', email);
  if(error){ toast('Could not remove organiser', true); return }
  toast('Organiser removed'); loadOrganisers();
}

/* ---- Push notifications ---- */
const PUSH = {supported:false, sub:null, reg:null};
function urlB64ToUint8(b64){ const p = '='.repeat((4 - b64.length % 4) % 4); const s = atob((b64 + p).replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(s, c=>c.charCodeAt(0)) }
function isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true }
async function initPush(){
  PUSH.supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if(!('serviceWorker' in navigator)) return;
  try{
    PUSH.reg = await navigator.serviceWorker.register('/sw.js');
    watchForUpdates(PUSH.reg);
    if(PUSH.supported) PUSH.sub = await PUSH.reg.pushManager.getSubscription();
    if(PUSH.sub) AUTH.sb.rpc('push_subscribe', subArgs(PUSH.sub)); // keep the server copy fresh
  }catch(e){ console.warn('service worker', e) }
  renderBell(); if(NOTIF.open) renderNotifPanel();
}
function subArgs(sub){ const j = sub.toJSON(); return {p_endpoint:j.endpoint, p_p256dh:j.keys.p256dh, p_auth:j.keys.auth} }
function pushState(){
  if(!PUSH.supported) return detectDevice()==='ios' && !isStandalone() ? 'ios-install' : 'unsupported';
  if(Notification.permission==='denied') return 'denied';
  return PUSH.sub ? 'on' : 'off';
}
async function enablePush(){
  if(!PUSH.reg){ toast('Notifications are still loading. Try again in a moment.', true); return }
  try{
    const perm = await Notification.requestPermission();
    if(perm!=='granted'){ toast('Notifications were not allowed', true); renderNotifPanel(); return }
    PUSH.sub = await PUSH.reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:urlB64ToUint8(VAPID_PUBLIC)});
    const {error} = await AUTH.sb.rpc('push_subscribe', subArgs(PUSH.sub));
    if(error) throw error;
    toast('Notifications on. You’ll hear about results, draws and champions.');
  }catch(e){ console.error(e); toast('Could not turn on notifications on this device', true) }
  renderBell(); if(NOTIF.open) renderNotifPanel();
}
async function disablePush(){
  try{ if(PUSH.sub){ await AUTH.sb.rpc('push_unsubscribe', {p_endpoint:PUSH.sub.endpoint}); await PUSH.sub.unsubscribe() } }catch(e){ console.error(e) }
  PUSH.sub = null; toast('Notifications off on this device');
  renderBell(); if(NOTIF.open) renderNotifPanel();
}
function pushControlHTML(){
  const st = pushState();
  if(st==='on') return `<div class="push-row on"><span><b>Notifications are on</b><span>Results, draws and champions arrive on this device even when the app is closed.</span></span><button type="button" class="btn btn-ghost btn-sm" onclick="disablePush()">Turn off</button></div>`;
  if(st==='off') return `<div class="push-row"><span><b>Get notifications</b><span>Results, draws and champions, even when the app is closed.</span></span><button type="button" class="btn btn-primary btn-sm" onclick="enablePush()">Turn on</button></div>`;
  if(st==='denied') return `<div class="push-row"><span><b>Notifications are blocked</b><span>Allow notifications for this site in your browser or phone settings, then reload.</span></span></div>`;
  if(st==='ios-install') return `<div class="push-row"><span><b>Notifications on iPhone</b><span>Add the app to your home screen first, then open it from there and turn notifications on.</span></span><button type="button" class="btn btn-primary btn-sm" onclick="toggleNotifPanel(false);openInstallModal()">How</button></div>`;
  return `<div class="push-row"><span><b>Notifications</b><span>This browser can't receive notifications. Updates still show here while the app is open.</span></span></div>`;
}

/* ---- Native install prompt (Android / desktop Chrome) ---- */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredInstall = e; if(currentView==='dashboard') renderDashboard() });
window.addEventListener('appinstalled', ()=>{ deferredInstall = null; nsave('install_hide', true); toast('Installed. Find it on your home screen.'); document.getElementById('installBanner')?.remove() });
async function installApp(){
  if(deferredInstall){ deferredInstall.prompt(); const r = await deferredInstall.userChoice.catch(()=>null); deferredInstall = null; if(r && r.outcome==='accepted') hideInstallBanner(); return }
  openInstallModal();
}

/* =========================
   UTILITIES
   ========================= */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,9) }
const clone = x => JSON.parse(JSON.stringify(x));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => (String(s || 'export').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'') || 'export');
const hasScore = v => v !== null && v !== undefined && v !== '' && !Number.isNaN(v);
/* A real result: both scores in and not an automatic 0-0 recorded at the deadline (those give no points). */
const realResult = f => !!f && hasScore(f.score1) && hasScore(f.score2) && !f.autoDraw;
/* Group-stage deadline (saved in Maldives time, UTC+5). Scores can be edited up to 30 minutes after it, then they lock. */
function deadlineMsOf(v){ if(!v) return NaN; const s = String(v); return Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : (s.length===16 ? s+':00' : s) + '+05:00') }
const GROUP_EDIT_GRACE = 30*60*1000;
function groupLocked(t){ const d = deadlineMsOf(t?.groupDeadline); return !!(t && t.format!=='single_elimination' && Number.isFinite(d) && Date.now() > d + GROUP_EDIT_GRACE) }
function groupLockAt(t){ const d = deadlineMsOf(t?.groupDeadline); return Number.isFinite(d) ? new Date(d + GROUP_EDIT_GRACE) : null }
function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a }
function localDT(d){ const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}` }
/* Date + time picker pair: a calendar for the date, a clock for the time. Read with readDT(id). */
function dtField(id, value, defTime='23:59', attrs=''){
  const [d, t] = String(value||'').split('T');
  return `<div class="dt-field" id="${id}" data-deftime="${defTime}" ${attrs}>
    <label class="dt-part" title="Pick a date"><span class="dt-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></span><input type="date" id="${id}_d" value="${d||''}" onclick="openPicker(this)" onchange="dtChanged('${id}')" aria-label="Date"></label>
    <label class="dt-part" title="Pick a time"><span class="dt-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span><input type="time" id="${id}_t" value="${(t||'').slice(0,5)}" onclick="openPicker(this)" aria-label="Time"></label>
    <button type="button" class="dt-clear" onclick="clearDT('${id}')" aria-label="Clear date and time" title="Clear">✕</button>
  </div>`;
}
function openPicker(el){ try{ if(el.showPicker) el.showPicker() }catch{} }
function dtChanged(id){ const t = document.getElementById(id+'_t'); const d = document.getElementById(id+'_d'); if(d.value && t && !t.value) t.value = document.getElementById(id).dataset.deftime || '23:59' }
function clearDT(id){ document.getElementById(id+'_d').value = ''; document.getElementById(id+'_t').value = '' }
function readDT(id){ const d = document.getElementById(id+'_d')?.value; if(!d) return ''; const t = document.getElementById(id+'_t')?.value || document.getElementById(id)?.dataset.deftime || '23:59'; return `${d}T${t}` }

function fmtDate(d){ if(!d) return '—'; const dt=new Date(d); if(isNaN(dt)) return '—'; return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) }
function fmtDateTime(d){ if(!d) return '—'; const dt=new Date(d); if(isNaN(dt)) return '—'; return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) + ' · ' + dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) }
function nextPow2(n){ let p=1; while(p<n) p*=2; return p }
const ICON_DL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

/* =========================
   DATA LAYER
   Shared mode: artifact db (players/{id}, tournaments/{id}), admins = owner + editors.
   Local mode: this browser's localStorage, admin via password (original behaviour).
   ========================= */
const STORE = { mode:'pending', players:[], tournaments:[], hof:[], settings:{}, cover:{}, sidecard:{}, hofcover:{}, phones:{}, admin:false, db:null, chains:{}, loaded:{players:false,tournaments:false}, offlineInViewer:false };

const LS = {
  get(k, d){ try{ const v = localStorage.getItem('mec_'+k); return v ? JSON.parse(v) : d }catch{ return d } },
  set(k, v){ try{ localStorage.setItem('mec_'+k, JSON.stringify(v)) }catch{ toast('This browser blocked saving. Changes will be lost on reload.', true) } }
};

const COLL = {players:'players', tournaments:'tournaments', hof:'halloffame'};
const HOF_TYPE_ORDER = {champion:0, runner_up:1, third:2, award:3};
function hofWhen(h){
  const src = h.sourceId && (typeof STORE!=='undefined') ? STORE.tournaments.find(t=>t.id===h.sourceId) : null;
  if(src && src.completedAt) return String(src.completedAt);
  if(h.when) return String(h.when);
  const d = String(h.date||'');
  return d.length===4 ? d+'-12-31' : d.length===7 ? d+'-31' : d;
}
const hofSort = (a,b)=> hofWhen(b).localeCompare(hofWhen(a)) || String(b.createdAt||'').localeCompare(String(a.createdAt||'')) || (HOF_TYPE_ORDER[a.type]??9)-(HOF_TYPE_ORDER[b.type]??9);
const DB = {
  get(key, def){
    if(COLL[key]) return clone(STORE[key]);
    return LS.get(key, def ?? null);
  },
  set(key, val){
    if(COLL[key]){
      const prev = STORE[key];
      STORE[key] = clone(val);
      if(STORE.mode==='shared') syncCollection(COLL[key], prev, STORE[key]);
      else LS.set(key, STORE[key]);
      return;
    }
    LS.set(key, val);
  }
};

function syncCollection(key, prev, next){
  const before = new Map(prev.map(x=>[x.id, JSON.stringify(x)]));
  const ids = new Set();
  next.forEach(x=>{
    ids.add(x.id);
    const json = JSON.stringify(x);
    if(before.get(x.id) !== json) queueWrite(`${key}/${x.id}`, ()=>STORE.db.doc(`${key}/${x.id}`).set(JSON.parse(json)));
  });
  prev.forEach(x=>{ if(!ids.has(x.id)) queueWrite(`${key}/${x.id}`, ()=>STORE.db.doc(`${key}/${x.id}`).delete()) });
}

function queueWrite(path, fn){
  STORE.lastLocalWrite = Date.now();
  const run = () => fn().catch(async e=>{
    if(e && e.code==='unavailable'){ await new Promise(r=>setTimeout(r, 400+Math.random()*900)); return fn() }
    throw e;
  });
  STORE.chains[path] = (STORE.chains[path] || LIVE_READY).then(run).then(()=>scheduleOffload()).catch(e=>{
    console.error(e);
    const code = e && e.code;
    if(/GROUP_LOCKED/.test(String(e && (e.message || e)))) toast('Group stage results are locked 30 minutes after the deadline. That change was not saved.', true);
    else if(code==='invalid_argument') toast('Save refused: only signed-in organisers can change community data. Sign in again from the Admin Panel.', true);
    else if(code==='quota_exceeded') toast('Storage is full. Delete old tournaments or player photos, then try again.', true);
    else toast('A change could not be saved. Check your connection and try again.', true);
  });
}

/* Phone numbers live under data/private, which only organisers can read or write. */
const PHONE_PATH = 'data/private/phones';
function setPhone(pid, phone){
  const next = {...STORE.phones};
  if(phone) next[pid] = phone; else delete next[pid];
  STORE.phones = next;
  if(STORE.mode==='shared') queueWrite(`${PHONE_PATH}/${pid}`, ()=> phone ? STORE.db.doc(`${PHONE_PATH}/${pid}`).set({phone}) : STORE.db.doc(`${PHONE_PATH}/${pid}`).delete());
  else LS.set('phones', next);
}
function savePicDoc(key, image){
  STORE[key] = image ? {image, updatedAt:new Date().toISOString()} : {};
  if(STORE.mode==='shared') queueWrite('settings/'+key, ()=> image ? STORE.db.doc('settings/'+key).set(clone(STORE[key])) : STORE.db.doc('settings/'+key).delete());
  else LS.set(key, STORE[key]);
}
const PIC_SLOTS = {
  hofcover: {title:'Hall of Fame picture', label:'Picture behind the Hall of Fame banner', hint:'A trophy lift or team photo works well. A dark blue shade keeps the title readable. Remove it to go back to plain navy.', opts:{shape:'wide', fit:'cover', aspect:3.5, out:1400, maxChars:220000, srcMax:2000, keepSrc:false, rec:{w:1400, h:400, minW:1050, minH:300, ratio:'7:2 (wide)', fmt:'JPG'}}, done:'Hall of Fame picture'}
};
function openPicModal(key){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const slot = PIC_SLOTS[key];
  openModal(`
    <div class="modal-head"><div class="modal-title">${slot.title}</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">${imageFieldHTML('pic', slot.label, slot.hint, true)}</div>
    <div class="modal-foot"><button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button><button type="button" class="btn btn-primary" onclick="savePicFromModal('${key}')">Save picture</button></div>`, 'lg');
  initImageField('pic', slot.opts, STORE[key]?.image ? {image:STORE[key].image} : null);
}
function savePicFromModal(key){
  const v = imageFieldValue('pic');
  if(v===undefined){ closeModal(); return }
  savePicDoc(key, v ? v.image : null);
  closeModal(); rerender();
  toast(`${PIC_SLOTS[key].done} ${v?'updated':'removed'}`);
}
function saveSideCard(image){
  STORE.sidecard = image ? {image, updatedAt:new Date().toISOString()} : {};
  if(STORE.mode==='shared') queueWrite('settings/sidecard', ()=> image ? STORE.db.doc('settings/sidecard').set(clone(STORE.sidecard)) : STORE.db.doc('settings/sidecard').delete());
  else LS.set('sidecard', STORE.sidecard);
}
function saveCover(image){
  STORE.cover = image ? {image, updatedAt:new Date().toISOString()} : {};
  if(STORE.mode==='shared') queueWrite('settings/cover', ()=> image ? STORE.db.doc('settings/cover').set(clone(STORE.cover)) : STORE.db.doc('settings/cover').delete());
  else LS.set('cover', STORE.cover);
}

function saveSettings(patch){
  const next = {...STORE.settings};
  Object.entries(patch).forEach(([k,v])=>{ if(v===undefined) return; next[k] = v });
  STORE.settings = next;
  if(STORE.mode==='shared') queueWrite('settings/community', ()=>STORE.db.doc('settings/community').set(clone(next)));
  else LS.set('settings', next);
}

const commName = () => (STORE.settings?.name || 'MG EFOOTBALL').trim() || 'MG EFOOTBALL';
const commTag = () => (STORE.settings?.tagline ?? 'eFOOTBALL COMMUNITY').trim();
const commFull = () => [commName(), commTag()].filter(Boolean).join(' ');
const titleCase = x => x.replace(/\S+/g, w => /^e[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase()+w.slice(1).toLowerCase());

const DEFAULT_MARK = size => `<svg width="${Math.round(size*0.6)}" height="${Math.round(size*0.6)}" viewBox="0 0 24 24" fill="none" stroke="#3D8BFF" stroke-width="2.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 19V5l9 8 9-8v14"/></svg>`;
function communityMark(size){
  const logo = STORE.settings?.logo;
  if(logo && isImgSrc(logo)) return `<span class="logo-mark has-img" style="width:${size}px;height:${size}px"><img src="${esc(logo)}"${imgAttrs(logo)} alt="${esc(commFull())} logo"></span>`;
  return `<span class="logo-mark" style="width:${size}px;height:${size}px">${DEFAULT_MARK(size)}</span>`;
}
function tournamentLogo(t, size, cls=''){
  if(t && t.logo && isImgSrc(t.logo)) return `<span class="t-logo ${cls}" style="width:${size}px;height:${size}px"><img src="${esc(t.logo)}"${imgAttrs(t.logo)} alt=""></span>`;
  return '';
}

function isAdmin(){
  return canManage() && isUnlocked();
}

function initLocal(){
  STORE.mode = 'local';
  loadPinLocal();
  let players = LS.get('players', null);
  if(!players || players.length===0){
    players = [
      {id:uid(), name:'MG L30', achievements:'Champion Season 4'},
      {id:uid(), name:'AXE77', achievements:'Runner-up Season 3'},
      {id:uid(), name:'FALCON', achievements:'Champion Season 3'},
      {id:uid(), name:'PRODIGY'},{id:uid(), name:'NIGHT'},{id:uid(), name:'SHADOW'},{id:uid(), name:'RAVEN'},{id:uid(), name:'BLAZE'}
    ];
    LS.set('players', players);
  }
  STORE.players = players;
  STORE.tournaments = LS.get('tournaments', []) || [];
  STORE.settings = LS.get('settings', {}) || {};
  STORE.hof = (LS.get('hof', []) || []).sort(hofSort);
  STORE.cover = LS.get('cover', {}) || {};
  STORE.sidecard = LS.get('sidecard', {}) || {};
  STORE.hofcover = LS.get('hofcover', {}) || {};
  STORE.phones = LS.get('phones', {}) || {};
  updateModeNote();
  rerender();
}

function attachShared(db){
  db.collection('halloffame').onSnapshot(snap=>{
    const arr = snap.docs.map(d=>({...clone(d.data()), id:d.id})).sort(hofSort);
    const same = JSON.stringify(arr)===JSON.stringify(STORE.hof);
    if(!same) STORE.hof = arr;
    markLive('halloffame');
    if(same) return;
    if(STORE.loaded.players && STORE.loaded.tournaments) scheduleRender();
  }, ()=>{});
  db.collection('settings').onSnapshot(snap=>{
    const doc = snap.docs.find(d=>d.id==='community'), cov = snap.docs.find(d=>d.id==='cover'), sc = snap.docs.find(d=>d.id==='sidecard'), hc = snap.docs.find(d=>d.id==='hofcover');
    const next = doc ? clone(doc.data()) : {}, nextCover = cov ? clone(cov.data()) : {}, nextSide = sc ? clone(sc.data()) : {}, nextHof = hc ? clone(hc.data()) : {};
    if(JSON.stringify(next)===JSON.stringify(STORE.settings) && JSON.stringify(nextCover)===JSON.stringify(STORE.cover) && JSON.stringify(nextSide)===JSON.stringify(STORE.sidecard) && JSON.stringify(nextHof)===JSON.stringify(STORE.hofcover)){ markLive('settings'); return }
    STORE.settings = next; STORE.cover = nextCover; STORE.sidecard = nextSide; STORE.hofcover = nextHof;
    markLive('settings');
    if(STORE.loaded.players && STORE.loaded.tournaments) scheduleRender(); else renderChrome();
  }, ()=>{});
  ['players','tournaments'].forEach(key=>{
    db.collection(key).onSnapshot(snap=>{
      const arr = snap.docs.map(d=>({...clone(d.data()), id:d.id}));
      if(key==='tournaments') arr.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
      if(key==='players') arr.sort((a,b)=>String(a.createdAt||a.id).localeCompare(String(b.createdAt||b.id)));
      const first = !STORE.loaded[key];
      STORE.loaded[key] = true;
      const same = !first && JSON.stringify(arr)===JSON.stringify(STORE[key]);
      if(!same) STORE[key] = arr;
      markLive(key);
      if(same) return;
      scheduleRender();
    }, ()=>{
      toast(STORE.live ? 'Live updates paused. Reconnecting…' : STORE.fromSnapshot ? "Can't reach the server right now. Showing the last saved results." : "Can't reach the server right now. Retrying…", true);
    });
  });
}

/* Phone numbers: organisers only, attached once the server confirms the role. */
let privateAttached = false;
function attachPrivate(db){
  if(privateAttached) return; privateAttached = true;
  db.collection(PHONE_PATH).onSnapshot(snap=>{
    const next = {}; snap.docs.forEach(d=>{ const v = d.data(); if(v && v.phone) next[d.id] = v.phone });
    if(JSON.stringify(next)===JSON.stringify(STORE.phones)) return;
    STORE.phones = next;
    if(STORE.loaded.players && STORE.loaded.tournaments) scheduleRender();
  }, ()=>{});
}

let renderQueued = false;
function scheduleRender(){
  if(renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(()=>{ renderQueued=false; if(STORE.loaded.players && STORE.loaded.tournaments){ rerender(); applyHashRoute(); if(STORE.live){ scheduleUpdateCheck(); saveSnapshotSoon() } } });
}

async function boot(){
  STORE.mode = 'shared';
  STORE.pin = null; STORE.pinLoaded = true;
  const hint = readRoleHint();
  if(hint){ STORE.admin = true; STORE.owner = hint==='owner' }
  const snap = readSnapshot();
  if(snap){ applySnapshot(snap); scheduleRender() } else renderSkeleton();
  updateModeNote();
  const ok = await waitForSupabase();
  if(!ok){ if(snap) toast('You are offline. Showing the last saved results.', true); else renderOffline(); return }
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  AUTH.sb = sb;
  sb.auth.onAuthStateChange(ev=>{ if(ev==='PASSWORD_RECOVERY'){ STORE.resetMode = true; navigate('admin') } });
  STORE.db = makeSupabaseDb(sb);
  attachShared(STORE.db);
  try{ await loadRole() }catch(e){ console.error(e) }
  if(/type=recovery/.test(location.hash) || location.hash==='#reset') STORE.resetMode = !!AUTH.user;
  saveRoleHint();
  updateModeNote();
  if(STORE.admin){ attachPrivate(STORE.db); loadOrganisers() }
  scheduleRender();
  initPush();
}
function renderOffline(){
  setHeader('Welcome', 'Dashboard');
  document.getElementById('main').innerHTML = `<div class="card empty"><div class="empty-title">Can't reach the community server</div><div class="text-sm">Check your internet connection and try again.</div><button type="button" class="btn btn-primary mt-16" onclick="location.reload()">Try again</button></div>`;
}

/* Deep links: #t=<tournament id>, #halloffame, #players, #leaderboard, #tournaments, #admin */
let hashRouted = false;
function applyHashRoute(){
  if(hashRouted) return; hashRouted = true;
  playEnter();
  routeTo(location.hash);
}
function routeTo(hash){
  const h = String(hash||'').replace(/^#/, '');
  if(!h || /access_token|type=|error=/.test(h)) { if(h) history.replaceState(null, '', location.pathname); return }
  const m = h.match(/^t=([A-Za-z0-9_\-.~:@+]{1,120})$/);
  if(m && STORE.tournaments.some(t=>t.id===m[1])) navigate('tournament-detail', m[1]);
  else if(['halloffame','players','leaderboard','tournaments','admin','dashboard','h2h'].includes(h)) navigate(h);
  else if(h==='reset') navigate('admin');
  history.replaceState(null, '', location.pathname);
}
window.addEventListener('hashchange', ()=>{ if(STORE.loaded && STORE.loaded.players && STORE.loaded.tournaments) routeTo(location.hash) });
if('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e=>{ if(e.data && e.data.type==='open' && e.data.url){ try{ routeTo(new URL(e.data.url, location.origin).hash) }catch{} } });

function updateModeNote(){
  const el = document.getElementById('modeNote');
  if(!el) return;
  if(STORE.mode==='shared') el.textContent = isAdmin() ? 'Live · signed in as organiser' : 'Live · results update automatically';
  else el.textContent = STORE.offlineInViewer ? 'Offline copy · saved in this browser only' : 'Saved in this browser';
}

function renderLoading(){ renderSkeleton() }

/* =========================
   MOBILE SIDEBAR
   ========================= */
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('mobileOverlay').classList.toggle('show');
}

/* =========================
   TOURNAMENT ENGINE
   ========================= */
function formatLabel(f){ return {group_knockout:'Group + Knockout', league:'League', single_elimination:'Single Elimination'}[f] || f }
function koLabel(k){ return k==='bo3' ? 'Best of 3' : k==='2leg' ? '2-Leg · Aggregate' : 'Single Match' }

function distributePlayersToGroups(playerCount, numGroups){
  if(numGroups < 1) numGroups = 1;
  if(playerCount < numGroups) numGroups = Math.max(1, playerCount);
  const base = Math.floor(playerCount/numGroups), rem = playerCount % numGroups;
  return Array.from({length:numGroups}, (_,i)=> i<rem ? base+1 : base);
}

function roundRobin(ids){
  const list = [...ids];
  if(list.length % 2) list.push(null);
  const n = list.length, rounds = [];
  for(let r=0; r<n-1; r++){
    const pairs = [];
    for(let i=0;i<n/2;i++){
      const a = list[i], b = list[n-1-i];
      if(a && b) pairs.push(r%2 ? [b,a] : [a,b]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

function buildFixtures(t){
  const fixtures = [];
  (t.groupData||[]).forEach(g=>{
    const ids = g.players.map(p=>p.playerId);
    const rounds = roundRobin(ids);
    rounds.forEach((pairs, ri)=>pairs.forEach(([a,b])=>fixtures.push({id:uid(), group:g.name, matchday:ri+1, team1:a, team2:b, score1:null, score2:null})));
    if(t.format==='league' && t.leagueRounds===2){
      rounds.forEach((pairs, ri)=>pairs.forEach(([a,b])=>fixtures.push({id:uid(), group:g.name, matchday:rounds.length+ri+1, team1:b, team2:a, score1:null, score2:null})));
    }
  });
  fixtures.sort((x,y)=> x.matchday-y.matchday || String(x.group).localeCompare(String(y.group)));
  return fixtures;
}

function computeStandings(t, g){
  const rows = {};
  g.players.forEach(p=>{ rows[p.playerId] = {playerId:p.playerId, played:0, wins:0, draws:0, losses:0, nr:0, gf:0, ga:0, points:0} });
  (t.fixtures||[]).forEach(f=>{
    if(f.group!==g.name || !hasScore(f.score1) || !hasScore(f.score2)) return;
    const a = rows[f.team1], b = rows[f.team2];
    if(!a || !b) return;
    // Not played by the deadline: counts as played, shown under NR (no result), no goals and no points.
    if(f.autoDraw){ a.played++; b.played++; a.nr++; b.nr++; return }
    a.played++; b.played++;
    a.gf += f.score1; a.ga += f.score2; b.gf += f.score2; b.ga += f.score1;
    if(f.score1 > f.score2){ a.wins++; a.points+=3; b.losses++ }
    else if(f.score2 > f.score1){ b.wins++; b.points+=3; a.losses++ }
    else { a.draws++; b.draws++; a.points++; b.points++ }
  });
  return Object.values(rows).sort((x,y)=> y.points-x.points || (y.gf-y.ga)-(x.gf-x.ga) || y.gf-x.gf || y.wins-x.wins);
}

function seedOrder(P){ let o=[1]; while(o.length<P){ const n=o.length*2; o=o.flatMap(s=>[s, n+1-s]) } return o }
function roundLabel(matches){ return matches===1 ? 'Final' : matches===2 ? 'Semi Finals' : matches===4 ? 'Quarter Finals' : `Round of ${matches*2}` }
function emptyMatch(){ return {id:uid(), team1:null, team2:null, score1:null, score2:null, leg2Score1:null, leg2Score2:null, games:null, pens:null, winner:null} }

const sameGroup = (a,b) => !!(a && b && a.group && a.group===b.group);

/* Keep every top seed where seeding put it; when a first-round tie pairs two players
   from the same group, swap the lower seed with another tie's lower seed, preferring
   one from the same finishing position and the closest seed number. */
function resolveGroupClashes(slots){
  const n = slots.length/2;
  for(let pass=0; pass<6; pass++){
    let changed = false;
    for(let k=0;k<n;k++){
      const top = slots[2*k], bot = slots[2*k+1];
      if(!sameGroup(top, bot)) continue;
      let best = -1, bestScore = -Infinity;
      for(let j=0;j<n;j++){
        if(j===k) continue;
        const t2 = slots[2*j], b2 = slots[2*j+1];
        if(!t2 || !b2) continue;
        if(sameGroup(top, b2) || sameGroup(t2, bot)) continue;
        const score = (b2.pos===bot.pos ? 1000 : 0) + (sameGroup(t2,b2) ? 100 : 0) - Math.abs((b2.seed||0)-(bot.seed||0));
        if(score > bestScore){ bestScore = score; best = j }
      }
      if(best>=0){ const tmp = slots[2*k+1]; slots[2*k+1] = slots[2*best+1]; slots[2*best+1] = tmp; changed = true }
    }
    if(!changed) break;
  }
  return slots;
}

/* seeds: [{playerId, tag, group?, pos?}] best first */
function buildBracket(seeds){
  seeds = seeds.map((s,i)=>({...s, seed:i+1}));
  const P = nextPow2(seeds.length), order = seedOrder(P);
  const slots = order.map(s=>seeds[s-1] || null);
  resolveGroupClashes(slots);
  const r1 = [];
  for(let i=0;i<P;i+=2){
    const a = slots[i], b = slots[i+1];
    const m = emptyMatch();
    m.team1 = a ? a.playerId : null;
    m.team2 = b ? b.playerId : null;
    if(!a || !b){ m.isBye = true; m.winner = m.team1 || m.team2; m.label = (a||b)?.tag ? `${(a||b).tag} · Bye` : 'Bye' }
    else m.label = a.tag && b.tag ? `${a.tag} vs ${b.tag}` : 'Match';
    r1.push(m);
  }
  const rounds = [r1];
  let count = r1.length;
  while(count > 1){ count /= 2; rounds.push(Array.from({length:count}, emptyMatch)) }
  rounds.forEach(r=>{ const l = roundLabel(r.length); r.forEach(m=>{ m.round = l; if(!m.label) m.label = l==='Final' ? 'Final' : 'Winners advance' }) });
  propagateBracket(rounds);
  return rounds;
}

function propagateBracket(rounds){
  for(let r=1; r<rounds.length; r++){
    rounds[r].forEach((m,i)=>{
      const a = rounds[r-1][2*i]?.winner || null, b = rounds[r-1][2*i+1]?.winner || null;
      if(m.team1!==a || m.team2!==b){
        m.team1 = a; m.team2 = b;
        m.score1 = m.score2 = m.leg2Score1 = m.leg2Score2 = null;
        m.games = null; m.pens = null; m.tb = null;
        m.winner = null;
      }
    });
  }
}

/* ---- Knockout results: legs / games / penalties ---- */
function koLegCount(fmt){ return fmt==='bo3' ? 3 : fmt==='2leg' ? 2 : 1 }
function koLegLabels(fmt){ return fmt==='bo3' ? ['G1','G2','G3'] : fmt==='2leg' ? ['L1','L2'] : [] }
function koTotalLabel(fmt){ return fmt==='bo3' ? 'Won' : fmt==='2leg' ? 'Agg' : 'Score' }
function koLegs(t, m){
  if(t.knockoutFormat==='bo3') return Array.isArray(m.games) ? [0,1,2].map(i=>[m.games[i]?.a ?? null, m.games[i]?.b ?? null]) : [[null,null],[null,null],[null,null]];
  if(t.knockoutFormat==='2leg') return [[m.score1, m.score2],[m.leg2Score1, m.leg2Score2]];
  return [[m.score1, m.score2]];
}
/* tb: [a, b] tie-breaker match scores when the tournament plays one for level 2-leg ties; undefined otherwise. */
function evalKO(fmt, legs, pens, tb){
  const r = {total:null, goals:null, complete:false, winner:null, level:false, byPens:false, byTb:false, needTb:false, tbLevel:false, played:0};
  const played = legs.filter(l=>hasScore(l[0]) && hasScore(l[1]));
  r.played = played.length;
  if(!played.length) return r;
  r.goals = [0,0]; played.forEach(l=>{ r.goals[0]+=l[0]; r.goals[1]+=l[1] });
  if(fmt==='bo3'){
    const w=[0,0], g=[0,0]; let used = 0;
    for(const l of played){ if(w[0]>=2 || w[1]>=2) break; used++; g[0]+=l[0]; g[1]+=l[1]; if(l[0]>l[1]) w[0]++; else if(l[1]>l[0]) w[1]++ }
    r.goals = g; r.played = used;
    r.total = w; r.complete = w[0]>=2 || w[1]>=2 || used>=3;
  } else { r.total = r.goals.slice(); r.complete = played.length >= koLegCount(fmt) }
  if(r.complete){
    if(r.total[0]!==r.total[1]) r.winner = r.total[0]>r.total[1] ? 0 : 1;
    else {
      r.level = true;
      if(Array.isArray(tb)){
        r.needTb = true;
        if(!(hasScore(tb[0]) && hasScore(tb[1]))) return r;
        if(tb[0]!==tb[1]){ r.winner = tb[0]>tb[1] ? 0 : 1; r.byTb = true; return r }
        r.tbLevel = true;
      }
      if(pens && hasScore(pens[0]) && hasScore(pens[1]) && pens[0]!==pens[1]){ r.winner = pens[0]>pens[1] ? 0 : 1; r.byPens = true }
    }
  }
  return r;
}
/* Two-leg ties that end level on aggregate go to a tie-breaker match when the knockout match settings say so. */
/* How a 2-leg tie that is level on aggregate is decided: 'MATCH' (tie-breaker match) or 'PENS'.
   Set in the Tie-breaker match section; older tournaments kept it in the knockout settings. */
function tbMode(t){ return t.rules?.tbMatch?.tiebreak || t.rules?.koMatch?.tiebreak || '' }
function koTieMatch(t){ return t.knockoutFormat==='2leg' && tbMode(t)==='MATCH' }
function koResult(t, m){
  if(t.knockoutFormat==='bo3' && !Array.isArray(m.games) && hasScore(m.score1) && hasScore(m.score2)){
    // older saves stored only the series score
    return {total:[m.score1, m.score2], goals:null, complete:true, played:1, level:m.score1===m.score2, byPens:false, winner: m.winner===m.team1?0:m.winner===m.team2?1:null, legacy:true};
  }
  return evalKO(t.knockoutFormat, koLegs(t,m), m.pens ? [m.pens.a, m.pens.b] : null, koTieMatch(t) ? [m.tb?.a ?? null, m.tb?.b ?? null] : undefined);
}
function matchTotals(t, m){ const r = koResult(t, m); return r.complete ? r.total : null }

function getQualifiers(t){
  const q = [];
  (t.groupData||[]).forEach(g=>{
    computeStandings(t, g).slice(0, t.qualifyPerGroup||1).forEach((row,i)=>q.push({...row, group:g.name, pos:i+1}));
  });
  return q;
}

/* =========================
   FACEBOOK-SIZE EXPORTS (1080 × 1350, portrait 4:5)
   Each export has its own layout with large text for phone screens. Pages are always exactly
   1080 × 1350; anything taller is scaled to fit so the size never changes.
   ========================= */
const EXPORT_CTX = {};
const FB = {w:1080, h:1350};
async function renderFbSheets(pages, width, base, format, ready){
  const pdfReady = format==='pdf' ? ensureJsPDF() : null;
  if(typeof html2canvas !== 'function'){ toast('Preparing export…'); await ready }
  if(typeof html2canvas !== 'function'){ toast('Export is unavailable right now. Check your connection and try again.', true); return }
  if(pdfReady && !(await pdfReady)){ toast('PDF export is unavailable right now. Check your connection and try again.', true); return }
  toast(pages.length>1 ? `Generating ${pages.length} Facebook images…` : 'Generating Facebook image…');
  const designed = EXPORT_CTX.fb || pages.every(h=>String(h).includes('class="fbp"'));
  const built = pages.map(html=>buildSheet(html, designed ? FB.w : width));
  if(designed) built.forEach(b=>b.sheet.classList.add('fb'));
  const S = 2, FW = FB.w*S, FH = FB.h*S;
  try{
    for(const b of built) await sheetReady(b.sheet);
    // One text size for every page of this export: the largest that lets every page fit.
    // Lists keep one text size on every page; mixed pages (rules, stats) each fill their own page.
    if(designed){
      const zs = built.map(b=>fbBestZ(b.sheet));
      if(EXPORT_CTX.zPerPage) built.forEach((b,i)=>fbSetZ(b.sheet, zs[i]));
      else { const z = Math.min(...zs); built.forEach(b=>fbSetZ(b.sheet, z)) }
    }
    const canvases = [];
    for(let i=0;i<built.length;i++){
      const sh = built[i].sheet;
      if(built.length>1) toast(`Generating image ${i+1} of ${built.length}…`);
      const W = Math.ceil(sh.scrollWidth), H = Math.ceil(sh.scrollHeight);
      if(designed && H > FB.h + 2) console.warn('fb export taller than 1350, scaled to fit:', base, i+1, H);
      const c = await sheetCanvas(sh, W, H, S);
      const out = document.createElement('canvas'); out.width = FW; out.height = FH;
      const g = out.getContext('2d'); g.fillStyle = exportBg(); g.fillRect(0,0,FW,FH);
      const k = Math.min(FW/c.width, FH/c.height);
      const dw = c.width*k, dh = c.height*k;
      g.imageSmoothingQuality = 'high';
      g.drawImage(c, (FW-dw)/2, designed ? 0 : (FH-dh)/2, dw, dh);
      canvases.push(out);
    }
    const name = `${base}_facebook`;
    if(format==='pdf'){
      const pdf = new window.jspdf.jsPDF({orientation:'portrait', unit:'px', format:[FB.w, FB.h], hotfixes:['px_scaling'], compress:true});
      canvases.forEach((c,i)=>{ if(i) pdf.addPage([FB.w, FB.h], 'portrait'); pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, FB.w, FB.h, undefined, 'FAST') });
      await deliverFiles([{name:`${name}.pdf`, blob:pdf.output('blob')}]);
    } else {
      const files = [];
      for(let i=0;i<canvases.length;i++){
        const blob = await new Promise(res=>canvases[i].toBlob(res, 'image/png'));
        if(!blob) throw new Error('empty');
        files.push({name:`${canvases.length>1 ? `${name}_${i+1}` : name}.png`, blob});
      }
      await deliverFiles(files);
    }
  }catch(e){ console.error(e); toast('Export failed. Try again.', true) }
  finally{ built.forEach(b=>b.host.remove()); EXPORT_CTX.zPerPage = false }
}
/* Height a Facebook page would have, measured off-screen. */
const FB_Z = {min:0.72, max:1.6};
function fbSetZ(sheet, z, measuring){ const p = sheet.querySelector('.fbp'); if(!p) return; p.style.setProperty('--z', z.toFixed(3)); p.style.minHeight = measuring ? '0' : '' }
function fbFits(sheet, z){ fbSetZ(sheet, z, true); return sheet.scrollHeight <= FB.h && [...sheet.querySelectorAll('.fb-card')].every(c=>c.scrollWidth <= c.clientWidth + 1) }
/* Largest text size (within limits) at which this page's content fits 1080 × 1350. */
function fbBestZ(sheet){
  if(!sheet.querySelector('.fbp')) return 1;
  if(fbFits(sheet, FB_Z.max)) return FB_Z.max;
  if(!fbFits(sheet, FB_Z.min)) return FB_Z.min;
  let lo = FB_Z.min, hi = FB_Z.max;
  for(let k=0;k<9;k++){ const mid = (lo+hi)/2; if(fbFits(sheet, mid)) lo = mid; else hi = mid }
  return lo;
}
/* Height of a page at a given text size, measured off-screen. */
function fbMeasure(html, z=1){ const b = buildSheet(html, FB.w); b.sheet.classList.add('fb'); fbSetZ(b.sheet, z, true); const h = b.sheet.scrollHeight; b.host.remove(); return h }
/* Splits items into as few pages as fit at a comfortable text size, then evens them out. */
function fbPack(items, makePage, opts={}){
  const z = opts.z || 0.95;
  const groups = []; let cur = [];
  items.forEach(it=>{
    const trial = [...cur, it];
    if(cur.length && fbMeasure(makePage(trial, 0, 9), z) > FB.h){ groups.push(cur); cur = [it] } else cur = trial;
  });
  if(cur.length) groups.push(cur);
  let out = groups;
  if(opts.even && groups.length>1){ const per = Math.ceil(items.length/groups.length); out = chunk(items, per) }
  return out.map((set, i)=>makePage(set, i, out.length));
}
function fbSheet(t, title, sub, body, i, n){ return `<div class="fbp">${sheetHeader(t, title, sub)}<div class="fb-body">${body}</div>${sheetFoot(i, n)}</div>` }
const fbPageLabel = (i, n) => n>1 ? ` · ${i+1}/${n}` : '';
const fbDone = f => hasScore(f.score1) && hasScore(f.score2);
const fbPos = (n, q) => `<span class="fb-pos ${q?'q':''}">${n}</span>`;

function fbStandings(t){
  const isLeague = t.format==='league', q = isLeague ? 1 : t.qualifyPerGroup;
  const cur = isLeague ? '*' : (currentGroup(t) || '*');
  const groups = (t.groupData || []).filter(g=>cur==='*' || g.name===cur);
  if(!groups.length){ toast('No standings to export yet', true); return }
  // The group stage is final once its deadline has passed, every match is played, or the knockouts are drawn.
  const groupFx = (t.fixtures||[]).filter(f=>isLeague || f.group);
  const final = !!(t.status==='completed' || t.deadlineProcessed || t.knockoutDrawn
    || (t.groupDeadline && new Date(t.groupDeadline) <= new Date())
    || (groupFx.length && groupFx.every(f=>hasScore(f.score1) && hasScore(f.score2))));
  const dl = t.groupDeadline && !final ? `<div class="fb-note">${ICON.calendar}<span>${isLeague?'League':'Group stage'} deadline <b>${fmtDateTime(t.groupDeadline)}</b> · unplayed matches count as 0-0</span></div>` : '';
  const hasNR = (t.fixtures||[]).some(f=>f.autoDraw);
  const what = g => final ? (isLeague ? 'Final league table' : `Final group standings · Group ${esc(g.name)}`) : (isLeague ? 'League table' : `Group ${esc(g.name)} standings`);
  const page = (g, rows, i, n) => fbSheet(t, t.name, `${what(g)} · ${updatedAtOf(t) ? `updated ${fmtDateTime(updatedAtOf(t))}` : fmtDate(new Date())}${fbPageLabel(i, n)}`, `${dl}<div class="fb-card"><div class="fb-card-title">${isLeague ? 'League table' : `Group ${esc(g.name)}`}</div>
      <table class="fbt"><thead><tr><th>#</th><th class="l">Player</th><th>P</th><th>W</th><th>D</th><th>L</th>${hasNR?'<th>NR</th>':''}<th>GF</th><th>GA</th><th>GD</th><th class="pts">Pts</th></tr></thead><tbody>
      ${rows.map(r=>{ const gd = r.gf-r.ga, qq = r.pos<=q; return `<tr class="${qq?'q':''}"><td>${fbPos(r.pos, qq)}</td><td class="l nm">${esc(playerName(r.playerId))}${qq && final?' <span class="fb-q">Q</span>':''}</td><td>${r.played}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td>${hasNR?`<td class="muted">${r.nr||'<span class="dim">0</span>'}</td>`:''}<td>${r.gf}</td><td>${r.ga}</td><td class="muted">${gd>0?'+':''}${gd}</td><td class="pts"><b>${r.points}</b></td></tr>` }).join('')}
      </tbody></table></div>
      <div class="fb-legend inline">${final ? `<span class="fb-q">Q</span> ${isLeague ? 'League champion' : `Qualified · top ${q} went through to the knockouts`}` : (isLeague ? 'Highlighted: top of the table so far' : `Highlighted: top ${q} in qualifying places so far`)} · <span style="white-space:nowrap">GA = goals conceded</span>${hasNR ? ' · <span style="white-space:nowrap">NR = no result (not played, 0 pts)</span>' : ''}</div>`, 1, 1);
  // One page per group (a long league table continues on a second page).
  const pages = [];
  groups.forEach(g=>{
    const rows = computeStandings(t, g).map((r,i)=>({...r, pos:i+1}));
    const sets = fbPack(rows, (set, i, n)=>page(g, set, i, n), {even:true});
    pages.push(...sets);
  });
  return renderSheets(fbRenumber(pages), FB.w, `${slug(t.name)}_standings`);
}

function fbFixtureRow(f){
  const done = fbDone(f), w1 = done && f.score1>f.score2, w2 = done && f.score2>f.score1;
  const np = done && f.autoDraw && EXPORT_CTX.scope !== 'pending';
  return `<div class="fbf"><span class="a ${w1?'w':''}">${esc(playerName(f.team1))}</span><span class="sc ${!done || EXPORT_CTX.scope==='pending' ? 'pending' : ''} ${np?'np':''}">${np ? 'NP' : done && EXPORT_CTX.scope!=='pending' ? `${f.score1} – ${f.score2}` : 'vs'}</span><span class="b ${w2?'w':''}">${esc(playerName(f.team2))}</span></div>`;
}
function fbFixtures(t){
  // "Not played" export: only matches without a real result (still to play, or recorded 0-0 at the deadline).
  const pendingOnly = EXPORT_CTX.scope === 'pending';
  const fx = (t.fixtures || []).filter(f=>!pendingOnly || !realResult(f)), isLeague = t.format==='league';
  const cur = isLeague ? '*' : (currentGroup(t) || '*');
  const blocks = (isLeague ? [{name:null, rows:fx}] : (t.groupData||[]).filter(g=>cur==='*' || g.name===cur).map(g=>({name:g.name, rows:fx.filter(f=>f.group===g.name)}))).filter(b=>b.rows.length);
  if(!blocks.length){ toast(pendingOnly ? 'Every match has been played' : 'No fixtures to export yet', true); return }
  const pages = [];
  blocks.forEach(b=>{
    // Pending export: one identical row per match (matchday inside the centre badge), so every row lines up.
    const items = pendingOnly
      ? [...b.rows].sort((x,y)=>(x.matchday||0)-(y.matchday||0)).map(f=>({md:f.matchday, rows:[f]}))
      : [...new Set(b.rows.map(f=>f.matchday))].sort((x,y)=>x-y).map(md=>({md, rows:b.rows.filter(f=>f.matchday===md)}));
    const page = (set, i, n) => {
      const mds = set.map(x=>x.md), label = mds.length>1 ? `Matchdays ${mds[0]}–${mds.at(-1)}` : `Matchday ${mds[0]}`;
      return fbSheet(t, t.name, `${b.name ? `Group ${esc(b.name)} · ` : ''}${pendingOnly ? `Pending matches` : label}${t.groupDeadline?` · Deadline ${fmtShort(t.groupDeadline)}`:''}`,
        `${pendingOnly ? `<div class="fb-pend">
            <span class="fb-pend-tag">${ICON.alarm} Pending matches</span>
            <div class="fb-pend-group">${b.name ? `Group ${esc(b.name)}` : 'League'}</div>
            <div class="fb-pend-sub"><b>${b.rows.length}</b> match${b.rows.length>1?'es':''} still to play${t.groupDeadline ? ` · Deadline <b>${fmtShort(t.groupDeadline)}</b>` : ''}</div>
          </div>` : ''}<div class="fb-card ${pendingOnly?'fb-pend-list':''}">${pendingOnly
            ? set.map(x=>x.rows.map(f=>`<div class="fbf fbp-row"><span class="a">${esc(playerName(f.team1))}</span><span class="fbp-mid"><small>MD ${x.md}</small><b>VS</b></span><span class="b">${esc(playerName(f.team2))}</span></div>`).join('')).join('')
            : set.map(x=>`<div class="fb-md">Matchday ${x.md}</div>${x.rows.map(fbFixtureRow).join('')}`).join('')}</div>${!pendingOnly && set.some(x=>x.rows.some(f=>f.autoDraw)) ? '<div class="fb-legend small">NP = not played by the deadline · recorded 0–0, no points for either player</div>' : ''}`, i+1, n);
    };
    pages.push(...fbPack(items, page, {even:true}));
  });
  return renderSheets(fbRenumber(pages), FB.w, `${slug(t.name)}_${pendingOnly ? 'not_played' : 'fixtures'}`);
}
/* Page numbers across an export made of several packed groups. */
function fbRenumber(pages){ const n = pages.length; return pages.map((h, i)=>h.replace(/(<span class="xs-fbar-date">Exported [^<]*?)( · Page \d+ of \d+)?(<\/span>)/, (m, a, b, c)=>a + (n>1 ? ` · Page ${i+1} of ${n}` : '') + c)) }

function fbTie(t, m){
  const r = koResult(t, m), fmt = t.knockoutFormat, labels = koLegLabels(fmt), legs = koLegs(t, m);
  const name = id => id ? esc(playerName(id)) : (m.isBye ? 'Bye' : 'TBD');
  const row = side => { const id = side ? m.team2 : m.team1; return `<div class="fbk-row ${m.winner && m.winner===id?'w':''} ${!id?'tbd':''}"><span class="nm">${name(id)}</span><span class="tot">${m.isBye ? '' : r.total ? r.total[side] : '–'}</span></div>` };
  const bits = [];
  if(labels.length && !r.legacy) legs.forEach((l,i)=>{ if(hasScore(l[0]) && hasScore(l[1])) bits.push(`${labels[i]} ${l[0]}–${l[1]}`) });
  if(m.tb && hasScore(m.tb.a) && hasScore(m.tb.b)) bits.push(`Tie-breaker ${m.tb.a}–${m.tb.b}`);
  if(m.pens && hasScore(m.pens.a) && hasScore(m.pens.b)) bits.push(`Pens ${m.pens.a}–${m.pens.b}`);
  return `<div class="fbk ${m.isBye?'bye':''}">${row(0)}${row(1)}${bits.length?`<div class="fbk-note">${bits.join(' · ')}</div>`:''}</div>`;
}
function fbBracketPages(t, rounds){
  const final = t.knockoutBracket.at(-1)?.[0];
  // Each round is a block (split into 8-tie parts when large); blocks share pages when they fit.
  const blocks = [];
  rounds.forEach(ri=>{
    const round = t.knockoutBracket[ri], title = round[0]?.round || `Round ${ri+1}`, dl = (t.rules?.roundDeadlines||{})[round[0]?.round];
    const ties = round.filter(m=>!m.isBye || m.team1 || m.team2);
    chunk(ties, 8).forEach((set, k, all)=>blocks.push({title, dl, set, part: all.length>1 ? ` (${k+1}/${all.length})` : '', isFinal: ri===t.knockoutBracket.length-1}));
  });
  const blockHTML = x => `<div class="fb-round"><div class="fb-round-h"><b>${esc(x.title)}${x.part}</b>${x.dl?`<span>Deadline ${fmtShort(x.dl)}</span>`:''}</div>
    <div class="fb-ties ${x.set.length===1?'one':''}">${x.set.map(m=>fbTie(t, m)).join('')}</div>
    ${x.isFinal && final?.winner ? `<div class="fb-champ">${ICON.cup}<div><small>Champion</small><b>${esc(playerName(final.winner))}</b></div></div>` : ''}</div>`;
  const page = (set, i, n) => fbSheet(t, t.name, `${set.map(x=>esc(x.title)).filter((v,k,a)=>a.indexOf(v)===k).join(' · ')} · ${koLabel(t.knockoutFormat)}`, set.map(blockHTML).join(''), i+1, n);
  return fbPack(blocks, page);
}
function fbBracket(t){
  if(!t.knockoutBracket?.length){ toast('No bracket to export yet', true); return }
  return renderSheets(fbBracketPages(t, t.knockoutBracket.map((_,i)=>i)), FB.w, `${slug(t.name)}_bracket`);
}
function fbRound(tid, ri){
  const t = STORE.tournaments.find(x=>x.id===tid);
  if(!t?.knockoutBracket?.[ri]){ toast('Round not found', true); return }
  return renderSheets(fbBracketPages(t, [ri]), FB.w, `${slug(t.name)}_${slug(t.knockoutBracket[ri][0]?.round)}`);
}

function fbParticipants(tid){
  const t = STORE.tournaments.find(x=>x.id===tid), regs = t.registrations || [];
  if(!regs.length){ toast('No players registered yet', true); return }
  const groupOf = {}; (t.groupData||[]).forEach(g=>g.players.forEach(p=>{ groupOf[p.playerId] = g.name }));
  const list = regs.map((r,i)=>({n:i+1, p: STORE.players.find(x=>x.id===r.playerId) || {name:'Unknown player'}, g: groupOf[r.playerId]}));
  const page = (part, i, n) => fbSheet(t, t.name, `Participants · ${regs.length} players`,
    `<div class="fb-people">${part.map(x=>`<div class="fb-person"><span class="n">${x.n}</span>${renderAvatar(x.p, 50)}<b>${esc(x.p.name)}</b>${x.g && t.format==='group_knockout' ? `<i>Group ${esc(x.g)}</i>` : ''}</div>`).join('')}</div>`, i+1, n);
  return renderSheets(fbPack(list, page, {even:true}), FB.w, `${slug(t.name)}_players`);
}

function fbLeaderboard(){
  const ranked = rankPlayers(calculateAllStats());
  const moves = rankMoves(ranked); ranked.forEach(x=>{ x.move = moves[x.p.id] || 0 });
  const top10 = EXPORT_CTX.scope === 'top10';
  // Top 10 keeps everyone tied on 10th place.
  const all = top10 ? ranked.filter(x=>x.rank<=10) : ranked;
  const page = (part, i, n) => fbSheet(null, top10 ? 'Top 10 Rankings' : 'Community Leaderboard', `${top10 ? 'Community leaderboard' : 'All-time ranking'} by total points${moves.__newest ? ` · updated ${fmtDateTime(moves.__newest)}` : ` · ${fmtDate(new Date())}`}`,
    `<div class="fb-card"><table class="fbt"><thead><tr><th>#</th><th class="l">Player</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Titles</th><th class="pts">PTS</th></tr></thead><tbody>
      ${part.map(x=>{ const gd = x.s.gf-x.s.ga; return `<tr class="${x.rank<=3 && x.s.pts>0?'top':''}"><td>${rankMark(x)}</td><td class="l nm">${esc(x.p.name)} ${moveBadge(x.move)}</td><td>${x.s.matches}</td><td>${x.s.wins}</td><td>${x.s.draws}</td><td>${x.s.losses}</td><td>${x.s.gf}</td><td>${x.s.ga}</td><td class="muted">${gd>0?'+':''}${gd}</td><td>${x.s.tourneyWins||'<span class="dim">–</span>'}</td><td class="pts"><span class="fb-pts">${x.s.pts}</span></td></tr>` }).join('')}
    </tbody></table></div>
    <div class="fb-legend small"><b>${ptsLegendHTML()}</b><br>${esc(PTS_RANKING)}${Object.keys(moves).length>2 ? ' Arrows show places gained or lost since the latest results.' : ''}</div>`, i+1, n);
  return renderSheets(fbPack(all, page, {even:true}), FB.w, top10 ? 'milandhoo_top10' : 'milandhoo_leaderboard');
}

function fbHof(){
  const list = hofFiltered();
  if(!list.length){ toast('Nothing to export yet', true); return }
  const page = (part, i, n) => fbSheet(null, 'Hall of Fame', `${list.length} achievements · ${fmtDate(new Date())}`,
    `<div class="fb-card fb-list">${part.map(h=>{ const ty = HOF_TYPES[h.type] || HOF_TYPES.award; return `<div class="fb-hof">${medalHTML(ty.cls, ty.medal, 48)}<div class="mid"><b>${esc(hofPlayer(h).name)}</b><span>${esc(hofTitle(h))} · ${esc(h.tournament||'')}</span></div><div class="end"><i>${esc(hofOrg(h))}</i><span>${esc(hofDate(h))||''}</span></div></div>` }).join('')}</div>`, i+1, n);
  return renderSheets(fbPack(list, page, {even:true}), FB.w, 'hall_of_fame');
}

function fbDecorated(){
  const ranked = hofRanked(hofTally([...STORE.hof]));
  if(!ranked.length){ toast('Nothing to export yet', true); return }
  const cell = n => n ? `<b>${n}</b>` : '<span class="dim">–</span>';
  const page = (part, i, n) => fbSheet(null, 'Most Decorated Players', `Hall of Fame · ${ranked.length} players`,
    `<div class="fb-card"><table class="fbt"><thead><tr><th>#</th><th class="l">Player</th><th>${medalHTML('gold','1',30)}</th><th>${medalHTML('silver','2',30)}</th><th>${medalHTML('bronze','3',30)}</th><th class="pts">Total</th></tr></thead><tbody>
      ${part.map(x=>`<tr class="${x.rank<=3?'top':''}"><td>${rankBadge(x.rank, MEDAL_BY_RANK[x.rank], x.tied)}</td><td class="l nm">${esc(hofPlayer(x.h).name)}</td><td>${cell(x.champion)}</td><td>${cell(x.runner_up)}</td><td>${cell(x.third)}</td><td class="pts"><span class="fb-pts">${x.total}</span></td></tr>`).join('')}
    </tbody></table></div>
    <div class="fb-legend small">Ranked by titles, then runner-up and third places. Equal records share the position.</div>`, i+1, n);
  return renderSheets(fbPack(ranked, page, {even:true}), FB.w, 'most_decorated');
}

function fbRules(tid, key){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const secs = ruleSections(t).filter(s=>!key || s.key===key).filter(s=>key || stageHasContent(t, s.key));
  if(!secs.length){ toast('Nothing to export yet', true); return }
  // A stage stays on one page whenever it fits at a readable size; otherwise rules first, then settings.
  const wrap = (sec, body) => `<div class="fb-card fb-rulecard"><span class="fb-chip">${esc(sec.title)}</span>${body}</div>`;
  const sheet = (sec, body, i=1, n=1) => fbSheet(t, t.name, `${esc(sec.title)} · Rules &amp; match settings`, wrap(sec, body), i, n);
  const fits = (sec, body) => fbMeasure(sheet(sec, body), 0.85) <= FB.h;
  const parts = [];
  secs.forEach(sec=>{
    const lines = ruleLines(stageData(t, sec.key).rules), set = settingsList(t, sec.key);
    const dl = t.rules?.roundDeadlines || {}, rounds = sec.key==='ko' ? koDeadlineRounds(t).filter(x=>dl[x]) : [];
    const rulesHTML = (list, start=1) => list.length ? `<div class="fb-sec"><h3>Rules</h3><ol class="fb-rules" style="counter-reset:fbr ${start-1}">${list.map(l=>`<li>${esc(l)}</li>`).join('')}</ol></div>` : '';
    const setHTML = set.length ? `<div class="fb-sec"><h3>Match settings</h3><div class="fb-set">${set.map(x=>`<div><span>${esc(x.label)}</span><b>${esc(x.value)}</b></div>`).join('')}</div></div>` : '';
    const dlHTML = rounds.length ? `<div class="fb-sec"><h3>Round deadlines</h3><div class="fb-set dl">${rounds.map(x=>`<div><span>${esc(x)}</span><b>${fmtShort(dl[x])}</b></div>`).join('')}</div></div>` : '';
    const groupDl = sec.key==='group' && t.groupDeadline ? `<div class="fb-note">${ICON.calendar}<span>Deadline <b>${fmtDateTime(t.groupDeadline)}</b></span></div>` : '';
    const all = groupDl + rulesHTML(lines) + setHTML + dlHTML;
    if(fits(sec, all)){ parts.push({sec, body: all}); return }
    let cur = [], start = 1;
    lines.forEach((l, i)=>{
      if(cur.length && !fits(sec, groupDl + rulesHTML([...cur, l], start))){ parts.push({sec, body: groupDl + rulesHTML(cur, start)}); start = i+1; cur = [] }
      cur.push(l);
    });
    if(cur.length) parts.push({sec, body: groupDl + rulesHTML(cur, start)});
    if(set.length || rounds.length){
      if(fits(sec, setHTML + dlHTML)) parts.push({sec, body: setHTML + dlHTML});
      else { if(set.length) parts.push({sec, body: setHTML}); if(rounds.length) parts.push({sec, body: dlHTML}) }
    }
  });
  EXPORT_CTX.zPerPage = true;
  return renderSheets(parts.map((pt, i)=>sheet(pt.sec, pt.body, i+1, parts.length)), FB.w, `${slug(t.name)}_rules`);
}

/* Stats export: two pages. 1) tournament numbers and the six leader boards, 2) match records and unbeaten players.
   One text scale throughout: titles 22, names 20, values 22 (bold), labels 14. */
function fbStatCard(d, rows){
  const fmt = d.fmt || (v=>v);
  const groups = statGroups(rows, d, 3);
  const names = (g, max) => { const n = g.rows.map(r=>esc(statPlayer(r.id).name)); return n.length>max ? n.slice(0,max).join(', ') + ` +${n.length-max} more` : n.join(', ') };
  return `<div class="fsc">
    <div class="fsc-h">${statIco(d.icon, d.c)}<div><b>${d.title}</b>${d.hint?`<small>${d.hint}</small>`:''}</div></div>
    ${groups.length ? groups.map(g=>`<div class="fsc-row ${g.rk===1?'top':''}"><span class="fsc-rk">${g.rk}</span><span class="fsc-nm">${names(g, g.rk===1?3:2)}</span><b>${fmt(g.v)}</b></div>`).join('') : '<div class="fsc-empty">No results yet</div>'}
  </div>`;
}
function fbStats(tid){
  const t = STORE.tournaments.find(x=>x.id===tid); if(!t) return;
  const S = statsSummary(t); if(!S){ toast('No stats to export yet', true); return }
  const {matches, rows, goals, draws, biggestAll, highestAll, maxMargin, maxGoals, defs, unbeaten} = S;
  const recBlock = (list, label, unit) => `<div class="fsr"><div class="fsr-h"><b>${label}</b><span>${unit}${list.length>1?` · ${list.length} matches`:''}</span></div>${list.slice(0,4).map(m=>`<div class="fbf"><span class="a ${m.ga>m.gb?'w':''}">${esc(statPlayer(m.a).name)}</span><span class="sc">${m.ga} – ${m.gb}</span><span class="b ${m.gb>m.ga?'w':''}">${esc(statPlayer(m.b).name)}</span></div>`).join('')}${list.length>4?`<div class="fsr-more">+${list.length-4} more with the same record</div>`:''}</div>`;
  const nums = `<div class="fsn">
      <div><span>Matches</span><b>${matches.length}</b></div>
      <div><span>Goals</span><b>${goals}</b></div>
      <div><span>Per match</span><b>${(Math.round(goals/matches.length*10)/10).toFixed(1)}</b></div>
      <div><span>Draws</span><b>${draws}</b></div>
    </div>`;
  const unb = `<div class="fsr"><div class="fsr-h"><b>Still unbeaten</b><span>${defs.minNote ? defs.minNote.toLowerCase() : 'no defeats'}</span></div><div class="fb-unb">${unbeaten.length ? unbeaten.slice(0,10).map(r=>`<span>${esc(statPlayer(r.id).name)} <i>${r.w}W ${r.d}D</i></span>`).join('') + (unbeaten.length>10?`<span>+${unbeaten.length-10} more</span>`:'') : '<span>Nobody yet</span>'}</div></div>`;
  const p1 = fbSheet(t, t.name, `Tournament stats · ${matches.length} matches played`, nums + `<div class="fsg">${defs.list.map(d=>fbStatCard(d, rows)).join('')}</div>`, 1, 2);
  const p2 = fbSheet(t, t.name, `Tournament stats · Match records`, recBlock(biggestAll, 'Biggest win', `${maxMargin} goal margin`) + recBlock(highestAll, 'Highest-scoring match', `${maxGoals} goals`) + unb, 2, 2);
  EXPORT_CTX.zPerPage = true;
  return renderSheets([p1, p2], FB.w, `${slug(t.name)}_stats`);
}

/* Standard player-fixtures export (a copy of the Player View card), kept as its own function so it has a Facebook layout too. */
function exportPlayerFixturesSheet(t, pid, filename){
  const el = document.getElementById('playerFixturesExport');
  if(!el){ toast('Nothing to export', true); return }
  return exportGenericSheet(el, t, playerName(pid), `${esc(t?.name||'')} · Fixtures &amp; results`, filename || `${slug(playerName(pid))}_fixtures`);
}
function fbPlayerFixtures(t, pid){
  if(!t || !pid){ toast('Nothing to export', true); return }
  const list = getPlayerFixtures(t, pid).map((f,i)=>({...f, _i:i})).sort((a,b)=> (!!b.result - !!a.result) || (a.result ? String(b.at||'').localeCompare(String(a.at||'')) : 0) || a._i-b._i);
  if(!list.length){ toast('No fixtures yet', true); return }
  const done = list.filter(f=>f.result), wins = done.filter(f=>f.result==='win').length;
  let gf=0, ga=0; done.forEach(f=>{ if(f.goals){ gf+=f.goals[0]; ga+=f.goals[1] } });
  const res = r => r ? `<span class="fb-res ${r}">${r==='win'?'W':r==='loss'?'L':'D'}</span>` : '<span class="fb-res p">–</span>';
  // Every fixture on one page: two columns of compact cards; text size adapts to the number of matches.
  const page = fbSheet(t, playerName(pid), `${esc(t.name)} · Fixtures &amp; results`,
    `<div class="fb-nums small">
      ${statNum('matches','blue','Played', done.length, `${list.length-done.length} to play`)}
      ${statNum('wins','purple','Wins', wins)}
      ${statNum('goals','green','Goals', gf, `${ga} conceded`)}
      ${statNum('avg','gold','Win rate', done.length ? Math.round(wins/done.length*100)+'%' : '–')}
    </div>
    <div class="fb-pfgrid ${list.length<=12?'one':''}">${list.map(f=>`<div class="fb-pfc">${res(f.result)}<div class="mid"><b>vs ${esc(f.opponent ? playerName(f.opponent) : 'TBD')}</b><span>${esc(f.stage||'')}${f.detail?` · ${esc(f.detail)}`:''}</span></div><span class="sc ${f.score?'':'pending'}">${f.score ? esc(f.score.replace(' - ','–')) : 'Pending'}</span></div>`).join('')}</div>`, 1, 1);
  return renderSheets([page], FB.w, `${slug(playerName(pid))}_fixtures`);
}

/* Each export remembers how to rebuild itself, and uses its Facebook layout when that size is chosen. */
setTimeout(()=>{
  const map = {exportStandingsSheet:fbStandings, exportFixturesSheet:fbFixtures, exportBracketSheet:fbBracket, exportRoundAsJPEG:fbRound,
    exportParticipantsSheet:fbParticipants, exportLeaderboardSheet:fbLeaderboard, exportHofSheet:fbHof, exportDecoratedSheet:fbDecorated,
    exportRulesSheet:fbRules, exportStatsSheet:fbStats, exportPlayerFixturesSheet:fbPlayerFixtures};
  Object.entries(map).forEach(([n, fbFn])=>{
    const orig = window[n]; if(typeof orig!=='function' || orig.__wrapped) return;
    const w = function(...a){ if(EXPORT_CTX.fb) return fbFn(...a); EXPORT_CTX.rerun = ()=>window[n](...a); return orig.apply(this, a) };
    w.__wrapped = true; window[n] = w;
  });
}, 0);

/* =========================
   AUTO-CALCULATE STATS
   Everything is recalculated from the saved results each time, so edits and deletions
   are reflected straight away and nothing can be counted twice.
   ========================= */
const PTS = {win:3, draw:1, loss:0, koBonus:2, place:{champion:20, runner_up:12, third:7, fourth:4}};
function ptsLegendHTML(){ const [h, rest] = PTS_LEGEND.split(': '); return `${esc(h)}: ` + rest.split(' | ').map(x=>`<span style="white-space:nowrap">${esc(x)}</span>`).join(' | ') }
const PTS_LEGEND = 'Ranking Points: Win +3 | Draw +1 | Loss 0 | Knockout Win +2 bonus | Champion +20 | Runner-up +12 | 3rd +7 | 4th +4';
const PTS_RANKING = 'Ranking: Highest total points first.';
/* With a cutoff (ISO time), results entered at or after it are left out: the table as it stood before. */
function calculateAllStats(cutoff){
  const players = STORE.players, tournaments = STORE.tournaments;
  const after = x => !!(cutoff && x && String(x) >= cutoff);
  const stats = {};
  players.forEach(p=>{ stats[p.id] = {matches:0, wins:0, draws:0, losses:0, gf:0, ga:0, koWins:0, tourneyWins:0, tourneyRunnerUp:0, tourneyThird:0, tourneyFourth:0, pts:0, ptsMatch:0, ptsKo:0, ptsPlace:0, achievements:[], titles:[], lastAt:'', addedAt:String(p.createdAt||'')} });
  // One placing per player per tournament; the best one counts (bonuses never stack).
  const place = {};
  const addPlace = (key, pid, kind) => { if(!stats[pid]) return; const k = key+'|'+pid; if(!place[k] || PTS.place[kind] > PTS.place[place[k].kind]) place[k] = {pid, kind} };
  tournaments.forEach(t=>{
    const tWhen = String(t.completedAt || t.startedAt || t.createdAt || '');
    const touch = pid => { const s = stats[pid]; if(s && tWhen > s.lastAt) s.lastAt = tWhen };
    (t.fixtures||[]).forEach(f=>{
      if(!realResult(f)) return;
      if(after(f.scoredAt)) return;
      const a = stats[f.team1], b = stats[f.team2];
      touch(f.team1); touch(f.team2);
      if(a){ a.matches++; a.gf+=f.score1; a.ga+=f.score2; if(f.score1>f.score2){ a.wins++; a.ptsMatch+=PTS.win } else if(f.score1<f.score2) a.losses++; else { a.draws++; a.ptsMatch+=PTS.draw } }
      if(b){ b.matches++; b.gf+=f.score2; b.ga+=f.score1; if(f.score2>f.score1){ b.wins++; b.ptsMatch+=PTS.win } else if(f.score2<f.score1) b.losses++; else { b.draws++; b.ptsMatch+=PTS.draw } }
    });
    (t.knockoutBracket||[]).forEach(round=>round.forEach(m=>{
      if(m.isBye || !m.team1 || !m.team2 || !m.winner) return;
      if(after(m.scoredAt)) return;
      touch(m.team1); touch(m.team2);
      const r = koResult(t, m);
      [[m.team1,0],[m.team2,1]].forEach(([pid,side])=>{
        const s = stats[pid]; if(!s) return;
        s.matches++;
        if(r.goals){ s.gf += r.goals[side]; s.ga += r.goals[1-side] }
        if(m.winner===pid){ s.wins++; s.koWins++; s.ptsMatch+=PTS.win; s.ptsKo+=PTS.koBonus } else s.losses++;
      });
    }));
    // Placing bonuses only once the tournament is completed (results finalised).
    if(t.status==='completed' && !after(t.completedAt)){
      const key = 't:'+t.id;
      if(t.champion) addPlace(key, t.champion, 'champion');
      if(t.runnerUp) addPlace(key, t.runnerUp, 'runner_up');
      if(t.thirdPlace) addPlace(key, t.thirdPlace, 'third');
      if(t.fourthPlace) addPlace(key, t.fourthPlace, 'fourth');
    }
  });
  // Historical placings from the Hall of Fame. Entries for a tournament already in the app are skipped,
  // so the same tournament never pays out twice.
  const appIds = new Set(tournaments.map(t=>t.id)), appNames = new Set(tournaments.map(t=>String(t.name||'').trim().toLowerCase()));
  (STORE.hof||[]).forEach(h=>{
    if(!h.playerId || !PTS.place[h.type]) return;
    const nm = String(h.tournament||'').trim().toLowerCase();
    if((h.sourceId && appIds.has(h.sourceId)) || appNames.has(nm)) return;
    addPlace('h:'+(nm || h.id), h.playerId, h.type);
  });
  const PLACE_FIELD = {champion:'tourneyWins', runner_up:'tourneyRunnerUp', third:'tourneyThird', fourth:'tourneyFourth'};
  const PLACE_LABEL = {champion:'Champion', runner_up:'Runner-up', third:'Third Place', fourth:'Fourth Place'};
  Object.entries(place).forEach(([k, x])=>{
    const s = stats[x.pid]; s[PLACE_FIELD[x.kind]]++; s.ptsPlace += PTS.place[x.kind];
    const key = k.slice(0, k.lastIndexOf('|'));
    const tn = key.startsWith('t:') ? (tournaments.find(t=>'t:'+t.id===key)?.name || '') : ((STORE.hof||[]).find(h=>h.playerId===x.pid && 'h:'+String(h.tournament||'').trim().toLowerCase()===key)?.tournament || '');
    s.achievements.push(`${PLACE_LABEL[x.kind]} · ${tn}`);
    if(x.kind==='champion' && tn) s.titles.push(tn);
  });
  Object.values(stats).forEach(s=>{ s.winPct = s.matches ? ((s.wins/s.matches)*100).toFixed(1) : '0.0'; s.pts = s.ptsMatch + s.ptsKo + s.ptsPlace });
  return stats;
}

function visibleTournaments(){ return isAdmin() ? STORE.tournaments : STORE.tournaments.filter(t=>t.status!=='draft') }

/* =========================
   NAVIGATION
   ========================= */
let currentView = 'dashboard';
let currentTournamentId = null;
let currentTab = 'tab-overview';
let countdownInterval = null;
let selectedPlayerFilter = null;
let playerQuery = '';
let tourneyFilter = 'all';

function featuredTournament(){
  const vis = visibleTournaments();
  return vis.find(t=>t.status==='active') || vis.find(t=>t.status==='open') || null;
}

/* Page history for the Back button (and the browser/phone back gesture). */
const NAV_STACK = [];
let navHistoryOK = false;
function navState(){ return {view: currentView, tid: currentTournamentId, tab: currentTab} }
function sameState(a, b){ return a.view===b.view && (a.view!=='tournament-detail' || a.tid===b.tid) }
function goBack(fromPop){
  if(document.getElementById('modal').classList.contains('show')){ closeModal(); return }
  const prev = NAV_STACK.pop();
  if(!prev){ if(currentView!=='dashboard') navigate('dashboard', null, {replace:true}); return }
  if(!fromPop && navHistoryOK){ try{ history.back(); NAV_STACK.push(prev); return }catch{} }
  currentTab = prev.tab;
  navigate(prev.view, prev.tid, {fromBack:true, tab:prev.tab});
}
window.addEventListener('popstate', ()=>{ if(NAV_STACK.length || document.getElementById('modal').classList.contains('show')) goBack(true) });

function navigate(view, param, opts={}){
  const before = navState();
  if(view==='standings' || view==='fixtures' || view==='bracket'){
    const f = featuredTournament();
    if(!f){ toast('No live or open tournament right now'); view = 'tournaments' }
    else {
      const tabs = availableTabs(f).map(x=>x[0]);
      const want = view==='standings' ? 'tab-standings' : view==='fixtures' ? 'tab-fixtures' : 'tab-knockout';
      if(f.id!==currentTournamentId){ selectedPlayerFilter = null; selectedGroup = null }
      currentTournamentId = f.id;
      currentTab = tabs.includes(want) ? want : (view==='bracket' ? 'tab-overview' : tabs.includes('tab-knockout') ? 'tab-knockout' : 'tab-overview');
      view = 'tournament-detail';
      param = f.id;
    }
  } else if(view==='tournament-detail'){
    if(opts.tab) currentTab = opts.tab;
    else if(param!==currentTournamentId){ currentTab='tab-overview'; selectedPlayerFilter=null; selectedGroup=null }
    currentTournamentId = param;
  }
  const after = {view, tid: view==='tournament-detail' ? param : null};
  if(!opts.fromBack && !opts.replace && STORE.mode!=='pending' && !sameState(before, after)){
    NAV_STACK.push(before);
    if(NAV_STACK.length>40) NAV_STACK.shift();
    try{ history.pushState({n:NAV_STACK.length}, ''); navHistoryOK = true }catch{ navHistoryOK = false }
  }
  currentView = view;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobileOverlay').classList.remove('show');
  window.scrollTo(0,0);
  rerender();
  playEnter();
}

function setHeader(crumb, title, back){
  document.getElementById('crumb').textContent = crumb;
  document.getElementById('pageTitle').textContent = title;
  const canBack = NAV_STACK.length>0 || (back && currentView!=='dashboard');
  document.getElementById('backSlot').innerHTML = canBack ? `<button type="button" class="btn btn-secondary btn-icon back-btn" onclick="${NAV_STACK.length ? 'goBack()' : back}" aria-label="Go back" title="Go back"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>` : '';
}

function renderChrome(){
  renderSiteFoot();
  document.querySelectorAll('[data-mark]').forEach(el=>setHTML(el, communityMark(+el.dataset.mark)));
  const f = featuredTournament();
  const view = currentView;
  const active = view==='tournament-detail' ? 'tournaments' : view;
  document.body.dataset.view = view;
  document.querySelectorAll('.nav-item, .bn-item').forEach(n=>{
    const on = n.dataset.view===active;
    n.classList.toggle('active', on);
    if(on) n.setAttribute('aria-current','page'); else n.removeAttribute('aria-current');
  });
  const card = document.getElementById('sideCard');
  if(card){
    const img = STORE.sidecard?.image;
    card.classList.toggle('has-img', !!img);
    const sideUrl = img ? cssUrl(img) : '';
    if(sideUrl){ if(card.style.getPropertyValue('--side-img')!==sideUrl) card.style.setProperty('--side-img', sideUrl) } else card.style.removeProperty('--side-img');
    const ed = document.getElementById('sideCardEdit'); if(ed) ed.hidden = !isAdmin();
  }
  document.querySelectorAll('[data-cname]').forEach(el=>{ const n = commName(); el.textContent = n; const longest = Math.max(...n.split(/\s+/).map(w=>w.length)); el.classList.toggle('long', longest>8 || n.length>14); el.classList.toggle('xlong', longest>11) });
  document.querySelectorAll('[data-ctag]').forEach(el=>{ el.textContent = commTag(); el.hidden = !commTag() });
  document.title = 'MG Efootball';
  // Tab icon and iPhone home-screen icon follow the community logo straight away.
  const ai = STORE.settings && STORE.settings.appIcons;
  for(const [id, k] of [['appFavicon','32'], ['appTouchIcon','180']]){
    const el = document.getElementById(id), url = ai && isMediaUrl(ai[k]) ? ai[k] : null;
    if(el && url && el.getAttribute('href')!==url) el.setAttribute('href', url);
  }
  updateModeNote();
  const admin = isAdmin();
  const label = admin ? (STORE.owner ? 'Owner' : 'Organiser') : 'Community';
  const sub = admin ? 'Signed in' : 'Organiser sign in';
  document.querySelectorAll('#userChip, [data-userchip]').forEach(chip=>{
    setHTML(chip, `<span class="user-ini">${admin?'AD':'MC'}</span><span class="user-meta"><b>${label}</b><span>${sub}</span></span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4A5878" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`);
    chip.setAttribute('aria-label', `${label}, ${sub}. Open admin panel`);
  });
  renderBell();
}

/* Top-bar search: on the Players page it filters the cards; elsewhere it shows matching players and tournaments. */
function onGlobalSearch(v){
  if(currentView==='players'){ playerQuery = v; closeSearchDrop(); renderPlayers(); return }
  const q = String(v||'').trim().toLowerCase();
  if(!q){ closeSearchDrop(); return }
  const ts = visibleTournaments().filter(t=>String(t.name||'').toLowerCase().includes(q)).slice(0,5);
  const ps = STORE.players.filter(p=>String(p.name||'').toLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,6);
  let d = document.getElementById('searchDrop');
  if(!d){ d = document.createElement('div'); d.id = 'searchDrop'; d.className = 'search-drop'; d.setAttribute('role','listbox'); document.querySelector('.search-box')?.appendChild(d) }
  d.innerHTML = (ts.length ? `<div class="sd-h">Tournaments</div>${ts.map(t=>`<button type="button" class="sd-item" onmousedown="event.preventDefault()" onclick="pickSearch('t','${t.id}')">${t.logo ? tournamentLogo(t, 30) : `<span class="sd-code" style="background:${tColor(t)}">${esc(tCode(t))}</span>`}<span class="sd-txt"><b>${esc(t.name)}</b><small>${esc(STATUS_LABEL[t.status]||t.status)} · ${formatLabel(t.format)}</small></span></button>`).join('')}` : '')
    + (ps.length ? `<div class="sd-h">Players</div>${ps.map(p=>`<button type="button" class="sd-item" onmousedown="event.preventDefault()" onclick="pickSearch('p','${p.id}')">${renderAvatar(p, 30)}<span class="sd-txt"><b>${esc(p.name)}</b></span></button>`).join('')}` : '')
    + (!ts.length && !ps.length ? `<div class="sd-empty">No players or tournaments match “${esc(v)}”</div>` : `<button type="button" class="sd-all" onmousedown="event.preventDefault()" onclick="pickSearch('all')">See all players matching “${esc(v)}”</button>`);
  d.classList.add('show');
}
function closeSearchDrop(){ document.getElementById('searchDrop')?.classList.remove('show') }
function pickSearch(kind, id){
  const inp = document.getElementById('globalSearch');
  closeSearchDrop();
  if(kind==='t'){ if(inp) inp.value = ''; navigate('tournament-detail', id) }
  else if(kind==='p'){ playerQuery = STORE.players.find(p=>p.id===id)?.name || ''; if(inp) inp.value = playerQuery; navigate('players') }
  else { playerQuery = inp?.value || ''; navigate('players') }
}
function searchKey(e){
  if(e.key==='Escape'){ closeSearchDrop(); e.target.blur() }
  if(e.key==='Enter'){ const first = document.querySelector('#searchDrop.show .sd-item'); if(first){ e.preventDefault(); first.click() } }
}
document.addEventListener('click', e=>{ if(!e.target.closest('.search-box')) closeSearchDrop() });

function rerender(){
  if(STORE.mode==='pending') return;
  const view = currentView;
  if(view==='dashboard') renderDashboard();
  else if(view==='halloffame') renderHallOfFame();
  else if(view==='players') renderPlayers();
  else if(view==='tournaments') renderTournaments();
  else if(view==='tournament-detail') renderTournamentDetail(currentTournamentId);
  else if(view==='leaderboard') renderLeaderboard();
  else if(view==='admin') renderAdmin();
  else if(view==='h2h') renderH2H();
  renderChrome();
}

/* =========================
   TOAST, MODAL, CONFIRM
   ========================= */
function toast(msg, err=false){
  document.querySelectorAll('.toast').forEach(x=>x.remove());
  const t = document.createElement('div');
  t.className = 'toast' + (err?' error':'');
  t.setAttribute('role','status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), err ? 4500 : 3000);
}
function openModal(html, size='md'){
  const m = document.getElementById('modal');
  const sizeClass = size==='lg'?'modal-lg':size==='xl'?'modal-xl':'';
  m.innerHTML = `<div class="modal ${sizeClass}" role="dialog" aria-modal="true">${html}</div>`;
  m.classList.add('show');
  m.onclick = e=>{ if(e.target===m) closeModal() };
}
let _confirmResolve = null;
function closeModal(){
  document.getElementById('modal').classList.remove('show');
  if(_confirmResolve){ const r=_confirmResolve; _confirmResolve=null; r(false) }
}
function resolveConfirm(v){ const r=_confirmResolve; _confirmResolve=null; closeModal(); if(r) r(v) }
function confirmDialog(title, message, okLabel='Confirm'){
  return new Promise(res=>{
    if(_confirmResolve){ const r=_confirmResolve; _confirmResolve=null; r(false) }
    openModal(`
      <div class="modal-head"><div class="modal-title">${esc(title)}</div><button class="btn btn-ghost btn-icon" onclick="resolveConfirm(false)" aria-label="Close">✕</button></div>
      <div class="modal-body"><p class="confirm-text">${esc(message)}</p></div>
      <div class="modal-foot"><button class="btn btn-secondary" onclick="resolveConfirm(false)">Cancel</button><button class="btn btn-danger-solid" onclick="resolveConfirm(true)">${esc(okLabel)}</button></div>
    `);
    _confirmResolve = res;
  });
}
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && document.getElementById('modal').classList.contains('show')) closeModal() });

/* =========================
   COUNTDOWN TIMER
   ========================= */
function startCountdown(targetDateTime, elementId){
  if(countdownInterval) clearInterval(countdownInterval);
  const target = new Date(targetDateTime).getTime();
  if(isNaN(target)) return;
  function update(){
    const el = document.getElementById(elementId);
    if(!el){ clearInterval(countdownInterval); return }
    const diff = target - Date.now();
    if(diff > 0){
      const days=Math.floor(diff/864e5), hours=Math.floor(diff%864e5/36e5), mins=Math.floor(diff%36e5/6e4), secs=Math.floor(diff%6e4/1e3);
      el.innerHTML = `
        <div class="countdown-timer">
          <div class="countdown-unit"><div class="countdown-num">${days}</div><div class="countdown-txt">Days</div></div>
          <div class="countdown-unit"><div class="countdown-num">${String(hours).padStart(2,'0')}</div><div class="countdown-txt">Hours</div></div>
          <div class="countdown-unit"><div class="countdown-num">${String(mins).padStart(2,'0')}</div><div class="countdown-txt">Minutes</div></div>
          <div class="countdown-unit"><div class="countdown-num">${String(secs).padStart(2,'0')}</div><div class="countdown-txt">Seconds</div></div>
        </div>
        <div class="countdown-status upcoming">Until kick-off</div>`;
    } else {
      const el2 = -diff, hours=Math.floor(el2/36e5), mins=Math.floor(el2%36e5/6e4);
      el.innerHTML = `
        <div class="countdown-timer">
                    <div class="countdown-unit"><div class="countdown-num">${hours}</div><div class="countdown-txt">Hours in</div></div>
          <div class="countdown-unit"><div class="countdown-num">${String(mins).padStart(2,'0')}</div><div class="countdown-txt">Minutes</div></div>
        </div>
        <div class="countdown-status live">● Live now</div>`;
    }
  }
  update();
  countdownInterval = setInterval(update, 1000);
}

/* =========================
   FILE SAVING & PNG / PDF EXPORT
   ========================= */
async function saveFile(filename, data){
  const blob0 = data instanceof Blob ? data : new Blob([data], {type: /\.json$/.test(filename) ? 'application/json' : 'application/octet-stream'});
  if(isStandalone() && navigator.canShare){
    try{
      const file = new File([blob0], filename, {type: blob0.type || 'application/octet-stream'});
      if(navigator.canShare({files:[file]})){ await navigator.share({files:[file], title:filename}); return }
    }catch(e){ if(e && e.name==='AbortError') return }
  }
  const blob = data instanceof Blob ? data : new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
  toast('Downloaded ' + filename);
}

/* Exports render a dedicated off-screen "sheet" at its natural size, so the whole
   bracket / every fixture / every group fits in the image, with both logos in the header. */
function sheetHeader(t, title, subtitle){
  return `<div class="xs-head">
    ${t && t.logo && isImgSrc(t.logo) ? `<span class="xs-tlogo"><img src="${esc(t.logo)}"${imgAttrs(t.logo)} alt=""></span>` : ''}
    <div class="xs-titles">
      <div class="xs-kicker">${esc(commFull().toUpperCase().replace(/EFOOTBALL/g,'eFOOTBALL'))}</div>
      <div class="xs-title">${esc(title)}</div>
      ${subtitle ? `<div class="xs-sub">${subtitle}</div>` : ''}
    </div>
    <span class="xs-clogo">${communityMark(64)}</span>
  </div>`;
}
const SOCIALS = [
  {network:'Facebook', handle:'EFootball Mobile Milandhoo', url:'https://www.facebook.com/search/top?q=EFootball%20Mobile%20Milandhoo', icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M14.5 8H13a2 2 0 0 0-2 2v11M8.5 13h6"/></svg>'},
  {network:'Instagram', handle:'@efootball.milandhoo', url:'https://www.instagram.com/efootball.milandhoo/', icon:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.6" fill="currentColor"/></svg>'}
];
/* Slim one-line footer for every export: socials on the left, export date on the right. */
function sheetFoot(page, pages){
  return `<div class="xs-fbar">
    <span class="xs-fbar-follow">Follow us</span>
    ${SOCIALS.map(x=>`<span class="xs-fbar-social">${x.icon}<b>${esc(x.handle)}</b></span>`).join('')}
    <span class="xs-fbar-date">Exported ${fmtDateTime(new Date())}${pages>1 ? ` · Page ${page} of ${pages}` : ''}</span>
  </div>`;
}
function chunk(arr, n){ const out = []; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out.length ? out : [[]] }
/* Saves several pages one after another; each page is its own JPEG. */
/* Set markup only when it changed, so pictures and focus aren't reset on every live update. */
function setHTML(el, html){ if(el && el._html!==html){ el.innerHTML = html; el._html = html } }
function renderSiteFoot(){
  const el = document.getElementById('siteFoot');
  if(!el) return;
  setHTML(el, `
    <div class="sf-brand">
      ${communityMark(44)}
      <div class="sf-name">${esc(commName())}</div>
      ${commTag() ? `<div class="sf-tag">${esc(commTag())}</div>` : ''}
    </div>
    <div class="sf-rule"><span>Follow us</span></div>
    <div class="sf-links">
      ${SOCIALS.map(x=>`<a class="sf-link" href="${x.url}" target="_blank" rel="noopener noreferrer" aria-label="${x.network}: ${esc(x.handle)}">${x.icon}<span class="sf-net">${x.network}</span><span class="sf-handle">${esc(x.handle)}</span></a>`).join('')}
    </div>
    <div class="sf-motto">Play · Compete · Belong</div>`);
}

function buildSheet(html, width){
  const sheet = document.createElement('div');
  sheet.className = 'xs';
  sheet.style.width = width ? width+'px' : 'max-content';
  sheet.innerHTML = String(html).replace(/\sloading="lazy"/g, '');
  sheet.querySelectorAll('.no-export').forEach(x=>x.remove());
  const host = document.createElement('div');
  host.className = 'xs-host';
  host.appendChild(sheet);
  document.body.appendChild(host);
  return {host, sheet};
}
async function sheetReady(sheet){
  await Promise.all([...sheet.querySelectorAll('img')].map(img=>img.decode ? img.decode().catch(()=>{}) : null));
  if(document.fonts && document.fonts.ready) await document.fonts.ready;
}
const EXPORT_SCALE = 2;
/* Exports follow the app's theme: dark exports in dark mode, light exports in light mode. */
const exportBg = ()=> document.documentElement.dataset.theme==='dark' ? '#0A1120' : '#EEF2F8';
function sheetCanvas(sheet, W, H, scale){
  return html2canvas(sheet, { backgroundColor:exportBg(), scale, useCORS:true, logging:false, width:W, height:H, windowWidth:Math.max(W+40, 1280), windowHeight:H+40 });
}
async function captureSheet(sheet, filename, W, H, scale){
  const canvas = await sheetCanvas(sheet, W, H, scale);
  const blob = await new Promise(r=>canvas.toBlob(r, 'image/png'));
  if(!blob) throw new Error('empty');
  await saveFile(`${filename}.png`, blob);
}
/* Hands finished export files to the person.
   Phones: a "ready" card whose button opens the share sheet (Save Image / Save to Files / WhatsApp…) with every page at once.
   Computers: each file downloads in turn. */
const isPhoneLike = ()=>{ try{ return window.matchMedia('(pointer:coarse)').matches }catch{ return false } };
function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 60000);
}
async function downloadAll(files){
  for(let i=0;i<files.length;i++){ downloadBlob(files[i].blob, files[i].name); if(i<files.length-1) await new Promise(r=>setTimeout(r, 700)) }
  toast(files.length>1 ? `Downloaded ${files.length} files` : `Downloaded ${files[0].name}`);
}
let READY_FILES = [];
async function deliverFiles(files){
  if(!files.length) return;
  const asFiles = files.map(f=>new File([f.blob], f.name, {type: f.blob.type || 'application/octet-stream'}));
  let canShare = false;
  try{ canShare = !!(navigator.canShare && navigator.canShare({files:asFiles})) }catch{ canShare = false }
  if(!(isPhoneLike() && canShare)){ await downloadAll(files); return }
  READY_FILES = files;
  const imgs = files.filter(f=>/^image\//.test(f.blob.type));
  const thumbs = imgs.slice(0, 6).map(f=>`<img src="${URL.createObjectURL(f.blob)}" alt="">`).join('');
  const isPdf = /pdf/.test(files[0].blob.type);
  openModal(`
    <div class="modal-head"><div class="modal-title">${isPdf ? 'PDF ready' : files.length>1 ? `${files.length} images ready` : 'Image ready'}</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
      ${thumbs ? `<div class="ready-thumbs">${thumbs}</div>` : `<div class="ready-file">${esc(files[0].name)}</div>`}
      <div class="text-sm text-muted">${isPdf ? 'Tap Save or share, then choose <b>Save to Files</b>, or send it straight to WhatsApp, Viber or Telegram.' : 'Tap Save or share, then choose <b>Save Image</b> (iPhone) or <b>Save</b> to keep them in your photos, or send them straight to WhatsApp, Viber or Telegram.'}</div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" onclick="downloadAll(READY_FILES)">Download instead</button>
      <button type="button" class="btn btn-primary" onclick="shareReadyFiles()">Save or share</button>
    </div>`);
}
async function shareReadyFiles(){
  const asFiles = READY_FILES.map(f=>new File([f.blob], f.name, {type: f.blob.type || 'application/octet-stream'}));
  try{ await navigator.share({files:asFiles}); closeModal() }
  catch(e){ if(e && e.name==='AbortError') return; await downloadAll(READY_FILES); closeModal() }
}

/* Asks whether to save the export as images or as one PDF. */
/* Exports are Facebook post size (1080 × 1350); the only choice is PNG images or one PDF. */
function chooseExportFormat(pages){
  return new Promise(resolve=>{
    let done = false;
    const finish = v=>{ if(done) return; done = true; window.__exportPick = null; closeModal(); resolve(v) };
    const scopes = EXPORT_CTX.scopes; EXPORT_CTX.scopes = null;
    let scope = scopes ? scopes[0].id : null;
    window.__exportScope = (id, el)=>{ scope = id; el.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('on', b===el)) };
    window.__exportPick = v => finish(v ? {...v, scope} : v);
    openModal(`
      <div class="modal-head"><div class="modal-title">Export</div><button type="button" class="btn btn-ghost btn-icon" onclick="__exportPick&&__exportPick(null)" aria-label="Close">✕</button></div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
        ${scopes ? `<div class="export-scope" role="group" aria-label="What to export">${scopes.map((o,i)=>`<button type="button" class="${i?'':'on'}" onclick="__exportScope('${o.id}', this)">${esc(o.label)}</button>`).join('')}</div>` : ''}
        <div class="text-sm text-muted">Facebook post size, 1080 × 1350, with large text that's easy to read in the feed.</div>
        <div class="export-choice">
          <button type="button" class="export-option" onclick="__exportPick&&__exportPick({format:'png'})">${ICON.image}<b>Images (PNG)</b><span>One image per page. Post several together as a swipeable album.</span></button>
          <button type="button" class="export-option" onclick="__exportPick&&__exportPick({format:'pdf'})"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg><b>PDF document</b><span>All pages in one file, for printing or sending as a file.</span></button>
        </div>
      </div>`);
    const ov = document.getElementById('modal');
    const prev = ov.onclick; ov.onclick = e=>{ if(e.target===ov) finish(null); else if(prev) prev(e) };
  });
}
async function renderSheet(html, width, filename){ return renderSheets([html], width, filename) }
/* Every page of one export gets the same width, height and resolution; the footer sits at the bottom. */
async function renderSheets(pages, width, base){
  const ready = ensureHtml2canvas();
  let format, fb = false;
  const myRerun = EXPORT_CTX.rerun; EXPORT_CTX.rerun = null;
  if(EXPORT_CTX.preset){ ({format, fb} = EXPORT_CTX.preset) }
  else {
    const pick = await chooseExportFormat(pages.length);
    if(!pick) return;
    format = pick.format; fb = true; EXPORT_CTX.scope = pick.scope || null;
    // Facebook size: rebuild this export with its Facebook layout.
    if(fb && myRerun){
      const rerun = myRerun;
      EXPORT_CTX.fb = true; EXPORT_CTX.preset = {format, fb:true};
      try{ return await rerun() } finally { EXPORT_CTX.fb = false; EXPORT_CTX.preset = null; EXPORT_CTX.scope = null }
    }
  }
  if(fb) return renderFbSheets(pages, width, base, format, ready);
  const pdfReady = format==='pdf' ? ensureJsPDF() : null;
  if(typeof html2canvas !== 'function'){ toast('Preparing export…'); await ready }
  if(typeof html2canvas !== 'function'){ toast('Export is unavailable right now. Check your connection and try again.', true); return }
  if(pdfReady && !(await pdfReady)){ toast('PDF export is unavailable right now. Check your connection and try again.', true); return }
  toast(pages.length>1 ? `Generating ${pages.length} pages…` : (format==='pdf' ? 'Generating PDF…' : 'Generating image…'));
  const built = pages.map(html=>buildSheet(html, width));
  try{
    for(const b of built) await sheetReady(b.sheet);
    const W = Math.ceil(Math.max(...built.map(b=>b.sheet.scrollWidth)));
    built.forEach(b=>{ b.sheet.style.width = W+'px' });
    const H = Math.ceil(Math.max(...built.map(b=>b.sheet.scrollHeight)));
    built.forEach(b=>{ b.sheet.style.height = H+'px' });
    const scale = Math.max(1, Math.min(EXPORT_SCALE, 15000 / Math.max(W, H)));
    if(format==='pdf'){
      const pdf = new window.jspdf.jsPDF({orientation: W>H ? 'landscape' : 'portrait', unit:'px', format:[W, H], hotfixes:['px_scaling'], compress:true});
      for(let i=0;i<built.length;i++){
        if(built.length>1) toast(`Generating page ${i+1} of ${built.length}…`);
        const canvas = await sheetCanvas(built[i].sheet, W, H, scale);
        if(i>0) pdf.addPage([W, H], W>H ? 'landscape' : 'portrait');
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W, H, undefined, 'FAST');
      }
      await deliverFiles([{name:`${base}.pdf`, blob:pdf.output('blob')}]);
    } else {
      const files = [];
      for(let i=0;i<built.length;i++){
        if(built.length>1) toast(`Generating page ${i+1} of ${built.length}…`);
        const canvas = await sheetCanvas(built[i].sheet, W, H, scale);
        const blob = await new Promise(res=>canvas.toBlob(res, 'image/png'));
        if(!blob) throw new Error('empty');
        files.push({name:`${built.length>1 ? `${base}_page${i+1}` : base}.png`, blob});
      }
      await deliverFiles(files);
    }
  }catch(e){ console.error(e); toast('Export failed. Try again.', true) }
  finally{ built.forEach(b=>b.host.remove()) }
}

function exportStandingsSheet(t){
  const isLeague = t.format==='league';
  const q = isLeague ? 1 : t.qualifyPerGroup;
  // League: one table. Groups: the selected group, or every group on its own page when "All" is selected.
  const cur = isLeague ? '*' : (currentGroup(t) || '*');
  const groups = (t.groupData || []).filter(g=>cur==='*' || g.name===cur);
  if(!groups.length){ toast('No standings to export yet', true); return }
  const dl = t.groupDeadline ? `<div class="xs-deadline ${new Date(t.groupDeadline)<new Date()?'passed':''}"><span class="xs-deadline-icon">${ICON.calendar}</span><div><div class="xs-deadline-label">${isLeague?'League deadline':'Group stage deadline'}</div><div class="xs-deadline-date">${fmtDateTime(t.groupDeadline)}</div></div><div class="xs-deadline-note">${new Date(t.groupDeadline)<new Date()?'Deadline passed · unplayed matches counted as 0-0 draws':'Unplayed matches after this count as 0-0 draws'}</div></div>` : '';
  const legend = `<div class="xs-legend"><span class="q-chip">Q</span> ${isLeague?'League leader':`Qualifies for the knockout stage (top ${q} per group)`}</div>`;
  const pages = groups.map((g, i)=>{
    const body = `<div class="xs-grid" style="grid-template-columns:repeat(1, 640px)"><div class="xs-card">${isLeague?'':`<div class="xs-card-title">Group ${esc(g.name)}</div>`}${standingsTable(t, g, q)}</div></div>`;
    const sub = `${isLeague?'League table':`Group ${esc(g.name)} standings`} · as of ${fmtDate(new Date())}${t.groupDeadline?` · Deadline ${fmtDateTime(t.groupDeadline)}`:''}`;
    return sheetHeader(t, t.name, sub) + dl + body + legend + sheetFoot(i+1, groups.length);
  });
  return renderSheets(pages, null, `${slug(t.name)}_standings${isLeague || cur==='*' ? '' : '_group_'+slug(cur)}`);
}

function fixtureLine(t, f){
  const done = hasScore(f.score1) && hasScore(f.score2);
  const w1 = done && f.score1>f.score2, w2 = done && f.score2>f.score1;
  return `<div class="xf">
    <span class="xf-md">MD${f.matchday||'–'}</span>
    <span class="xf-a ${w1?'w':''}">${esc(playerName(f.team1))}</span>
    <span class="xf-score ${done?'':'pending'}">${done?`${f.score1} – ${f.score2}`:'vs'}</span>
    <span class="xf-b ${w2?'w':''}">${esc(playerName(f.team2))}</span>
  </div>`;
}
const MATCHDAYS_PER_PAGE = 3;
/* Fixtures export: every group on its own pages (or just the selected group), 3 matchdays per page. */
function exportFixturesSheet(t){
  EXPORT_CTX.scopes = [{id:'all', label:'All fixtures'}, {id:'pending', label:'Not played'}];
  const fx = t.fixtures || [];
  const done = f=>hasScore(f.score1)&&hasScore(f.score2);
  const dl = t.groupDeadline ? ` · Deadline ${fmtDateTime(t.groupDeadline)}` : '';
  const isLeague = t.format==='league';
  const cur = isLeague ? '*' : (currentGroup(t) || '*');
  const blocks = isLeague ? [{name:null, rows:fx}] : (t.groupData||[]).filter(g=>cur==='*' || g.name===cur).map(g=>({name:g.name, rows:fx.filter(f=>f.group===g.name)}));
  const parts = [];
  blocks.forEach(b=>{
    const mds = [...new Set(b.rows.map(f=>f.matchday))].sort((x,y)=>x-y);
    chunk(mds, MATCHDAYS_PER_PAGE).forEach(set=>{ if(set.length) parts.push({...b, mds:set}) });
  });
  if(!parts.length){ toast('No fixtures to export yet', true); return }
  const pages = parts.map((pt, i)=>{
    const mdLabel = pt.mds.length>1 ? `Matchdays ${pt.mds[0]}–${pt.mds.at(-1)}` : `Matchday ${pt.mds[0]}`;
    const body = `<div class="xs-grid" style="grid-template-columns:repeat(1, 600px)"><div class="xs-card">
      <div class="xs-card-title">${pt.name ? `Group ${esc(pt.name)} · ` : ''}${mdLabel}</div>
      ${pt.mds.map(md=>`<div class="xs-md">Matchday ${md}</div>${pt.rows.filter(f=>f.matchday===md).map(f=>fixtureLine(t,f)).join('')}`).join('')}
    </div></div>`;
    const sub = `${pt.name ? `Group ${esc(pt.name)} · ` : ''}${mdLabel} · Fixtures &amp; results · ${pt.rows.filter(done).length} of ${pt.rows.length} played${dl}`;
    return sheetHeader(t, t.name, sub) + body + sheetFoot(i+1, parts.length);
  });
  return renderSheets(pages, null, `${slug(t.name)}_fixtures${cur==='*' ? '' : '_group_'+slug(cur)}`);
}

function bracketHTML(t, admin){
  const rounds = t.knockoutBracket || [];
  const final = rounds.at(-1)?.[0];
  const multi = koLegCount(t.knockoutFormat)>1;
  return `<div class="bracket ${Object.values(t.rules?.roundDeadlines||{}).some(Boolean)?'has-dl':''}">
    ${rounds.map((round,ri)=>`
      <div class="bracket-round ${multi?'multi':''}">
        <div class="bracket-round-title">${esc(round[0]?.round||'Round '+(ri+1))}${(t.rules?.roundDeadlines||{})[round[0]?.round] ? `<span class="round-dl">Deadline ${fmtShort(t.rules.roundDeadlines[round[0].round])}</span>` : ''}</div>
        ${round.map(m=>`
          <div class="bracket-match ${m.isBye?'bye':''} ${!m.team1||!m.team2?'pending':''} ${ri===rounds.length-1?'final':''}">
            ${m.label && !/^(Final|Winners advance|Match)$/.test(m.label) ? `<div class="bracket-match-title">${esc(m.label)}</div>`:''}
            ${koMatchBody(t, m, playerName)}
            ${admin && t.status==='active' && !m.isBye && m.team1 && m.team2 ? `<button type="button" class="btn btn-sm" onclick="openKnockoutMatchModal('${t.id}',${ri},'${m.id}')">${m.winner?'Edit result':'Enter result'}</button>`:''}
          </div>`).join('')}
      </div>`).join('')}
    <div class="bracket-champion">
      <div class="trophy-disc">${ICON.cup.replace('width="36" height="36"','width="56" height="56"')}</div>
      <b>CHAMPION</b>
      <span>${final?.winner ? esc(playerName(final.winner)) : 'TBD'}</span>
    </div>
  </div>`;
}
function exportBracketSheet(t){
  const body = `<div class="xs-card xs-bracket">${bracketHTML(t, false)}</div>`;
  return renderSheet(sheetHeader(t, t.name, `Knockout bracket · ${koLabel(t.knockoutFormat)}`) + body + sheetFoot(), null, `${slug(t.name)}_bracket`);
}

function exportRoundAsJPEG(tid, roundIndex){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const round = t?.knockoutBracket?.[roundIndex];
  if(!round){ toast('Round not found', true); return }
  const cols = round.length>1 ? 2 : 1;
  const body = `<div class="xs-grid" style="grid-template-columns:repeat(${cols}, 400px)">
    ${round.map(m=>`<div class="xs-card bracket-match ${m.isBye?'bye':''} ${!m.team1||!m.team2?'pending':''}" style="padding:0">
      <div class="bracket-match-title">${esc(m.label && !/^(Final|Winners advance|Match)$/.test(m.label) ? m.label : m.round)}</div>
      ${koMatchBody(t, m, playerName)}
    </div>`).join('')}
  </div>`;
  const rdl = (t.rules?.roundDeadlines||{})[round[0]?.round];
  return renderSheet(sheetHeader(t, t.name, `${esc(round[0]?.round || 'Round '+(roundIndex+1))} · ${koLabel(t.knockoutFormat)}${rdl?` · Deadline ${fmtDateTime(rdl)}`:''}`) + body + sheetFoot(), null, `${slug(t.name)}_${slug(round[0]?.round)}`);
}

function exportGenericSheet(el, t, title, subtitle, filename){
  const c = el.cloneNode(true);
  c.querySelectorAll('.no-export,.export-header').forEach(x=>x.remove());
  c.removeAttribute('id');
  c.querySelectorAll('[id]').forEach(x=>x.removeAttribute('id'));
  const width = Math.max(760, Math.ceil(el.scrollWidth) + 80);
  return renderSheet(sheetHeader(t, title, subtitle) + `<div class="xs-card">${c.innerHTML}</div>` + sheetFoot(), width, filename);
}

function exportAsJPEG(elementId, filename){
  const t = currentView==='tournament-detail' ? STORE.tournaments.find(x=>x.id===currentTournamentId) : null;
  if(t && elementId==='standingsExport') return exportStandingsSheet(t);
  if(t && elementId==='fixturesExport') return exportFixturesSheet(t);
  if(t && elementId==='bracketExport') return exportBracketSheet(t);
  const el = document.getElementById(elementId);
  if(!el){ toast('Nothing to export', true); return }
  if(elementId==='playerFixturesExport') return exportPlayerFixturesSheet(t, document.getElementById('pv_select')?.value, filename);
  if(elementId==='leaderboardExport') return exportLeaderboardSheet();
  return exportLeaderboardSheet();
}

/* =========================
   IMAGE CROPPER (drag to reposition, slider/wheel to zoom)
   Used for player photos (circle), tournament + community logos (rounded square).
   ========================= */
const CROP = {};
const CROP_STAGE = 240;

function readImageFile(file, maxSide){
  return new Promise((resolve, reject)=>{
    if(!file || !file.type.startsWith('image/')){ reject(new Error('type')); return }
    const reader = new FileReader();
    reader.onload = e=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width*scale)), h = Math.max(1, Math.round(img.height*scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const keepAlpha = /png|gif|webp|svg/.test(file.type);
        resolve({src: c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.86), w: img.naturalWidth || img.width, h: img.naturalHeight || img.height});
      };
      img.onerror = ()=>reject(new Error('read'));
      img.src = e.target.result;
    };
    reader.onerror = ()=>reject(new Error('read'));
    reader.readAsDataURL(file);
  });
}

/* key: element id prefix; opts: {shape:'circle'|'square', fit:'cover'|'contain', out:px} */
const stageW = st => CROP_STAGE;
const stageH = st => CROP_STAGE / (st.opts.aspect || 1);
function mountCropper(key, src, opts, saved){
  const host = document.getElementById(key + 'Crop');
  if(!host) return;
  const aspect = opts.aspect || 1;
  host.innerHTML = `
    <div class="crop-stage ${opts.shape}" id="${key}Stage" title="Drag to reposition" style="${aspect!==1?`aspect-ratio:${aspect};`:''}">
      <canvas width="${CROP_STAGE*2}" height="${Math.round(CROP_STAGE*2/aspect)}" id="${key}Canvas" aria-label="Image preview. Drag to reposition."></canvas>
    </div>
    <div class="crop-controls">
      <label class="form-label" for="${key}Zoom" style="margin:0">Zoom</label>
      <input type="range" id="${key}Zoom" min="${opts.fit==='contain'?0.5:1}" max="4" step="0.01" value="${saved?.zoom ?? 1}" aria-label="Zoom">
      <button type="button" class="btn btn-ghost btn-sm" onclick="resetCropper('${key}')">Reset</button>
    </div>
    <div class="text-xs text-muted">Drag the picture to adjust what shows. Use the slider or scroll to zoom.</div>`;
  const img = new Image();
  const st = CROP[key] = {src, img, opts, zoom: saved?.zoom ?? 1, x: saved?.x ?? 0, y: saved?.y ?? 0, ready:false};
  img.onload = ()=>{ st.ready = true; clampCrop(st); drawCrop(key) };
  if(/^https?:/.test(src)) img.crossOrigin = 'anonymous';
  img.src = src;
  const stage = document.getElementById(key+'Stage');
  let drag = null;
  stage.addEventListener('pointerdown', e=>{ drag = {x:e.clientX, y:e.clientY, ox:st.x, oy:st.y}; stage.setPointerCapture(e.pointerId); stage.classList.add('dragging') });
  stage.addEventListener('pointermove', e=>{
    if(!drag) return;
    const k = stageW(st) / stage.getBoundingClientRect().width;
    st.x = drag.ox + (e.clientX-drag.x)*k; st.y = drag.oy + (e.clientY-drag.y)*k;
    clampCrop(st); drawCrop(key);
  });
  const end = ()=>{ drag = null; stage.classList.remove('dragging') };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e=>{ e.preventDefault(); setCropZoom(key, st.zoom * (e.deltaY<0 ? 1.06 : 1/1.06)) }, {passive:false});
  document.getElementById(key+'Zoom').addEventListener('input', e=>setCropZoom(key, parseFloat(e.target.value)));
}
function baseScale(st){
  const w = st.img.naturalWidth, h = st.img.naturalHeight, W = stageW(st), H = stageH(st);
  return st.opts.fit==='contain' ? Math.min(W/w, H/h) : Math.max(W/w, H/h);
}
function clampCrop(st){
  if(!st.ready) return;
  const s = baseScale(st)*st.zoom, w = st.img.naturalWidth*s, h = st.img.naturalHeight*s;
  const mx = Math.abs(w-stageW(st))/2, my = Math.abs(h-stageH(st))/2;
  st.x = Math.max(-mx, Math.min(mx, st.x));
  st.y = Math.max(-my, Math.min(my, st.y));
}
function setCropZoom(key, z){
  const st = CROP[key]; if(!st) return;
  const min = st.opts.fit==='contain' ? 0.5 : 1;
  st.zoom = Math.max(min, Math.min(4, z));
  const r = document.getElementById(key+'Zoom'); if(r) r.value = st.zoom;
  clampCrop(st); drawCrop(key);
}
function resetCropper(key){ const st = CROP[key]; if(!st) return; st.zoom = 1; st.x = 0; st.y = 0; const r = document.getElementById(key+'Zoom'); if(r) r.value = 1; clampCrop(st); drawCrop(key) }
function paintCrop(st, ctx, W, H, bg){
  const k = W / stageW(st);
  ctx.clearRect(0,0,W,H);
  if(bg){ ctx.fillStyle = bg; ctx.fillRect(0,0,W,H) }
  const s = baseScale(st)*st.zoom*k, w = st.img.naturalWidth*s, h = st.img.naturalHeight*s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(st.img, (W-w)/2 + st.x*k, (H-h)/2 + st.y*k, w, h);
}
function drawCrop(key){
  const st = CROP[key], c = document.getElementById(key+'Canvas');
  if(!st || !st.ready || !c) return;
  paintCrop(st, c.getContext('2d'), c.width, c.height, st.opts.fit==='contain' ? null : '#FFFFFF');
}
function cropOutput(key){
  const st = CROP[key];
  if(!st || !st.ready) return null;
  const png = st.opts.fit==='contain';
  let W = st.opts.out, H = Math.round(st.opts.out / (st.opts.aspect||1));
  const c = document.createElement('canvas');
  const render = ()=>{ c.width = W; c.height = H; paintCrop(st, c.getContext('2d'), W, H, png ? null : '#FFFFFF') };
  render();
  let image = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
  if(st.opts.maxChars && !png){
    // keep big images (covers) small enough for one shared database document
    let q = 0.82;
    while(image.length > st.opts.maxChars && q > 0.45){ image = c.toDataURL('image/jpeg', q); q -= 0.08 }
    while(image.length > st.opts.maxChars && W > 600){ W = Math.round(W*0.8); H = Math.round(H*0.8); render(); image = c.toDataURL('image/jpeg', 0.7) }
  }
  return { image, src: st.opts.keepSrc===false ? null : st.src, crop: {zoom: +st.zoom.toFixed(3), x: Math.round(st.x), y: Math.round(st.y)} };
}

/* An image field = cropper + upload/remove buttons. Value read back with imageFieldValue(key). */
const IMG_FIELD = {};
function imageFieldHTML(key, label, hint, wide){
  return `
    <div class="image-field ${wide?'wide':''}">
      <div class="crop-wrap ${wide?'wide':''}" id="${key}Crop"></div>
      <div class="image-field-side">
        <div class="form-label" style="margin:0">${label}</div>
        <div class="text-xs text-muted">${hint}</div>
        <div class="size-guide" id="${key}Size"></div>
        <div class="size-check" id="${key}Check" role="status"></div>
        <div class="flex gap-8" style="flex-wrap:wrap">
          <label class="photo-upload-btn" for="${key}File">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>
            <span id="${key}UploadLabel">Upload image</span>
          </label>
          <input type="file" accept="image/*" id="${key}File" class="sr-only" onchange="onImageFieldFile('${key}', this)">
          <button type="button" class="btn btn-ghost btn-sm" id="${key}Remove" onclick="clearImageField('${key}')" style="color:var(--danger-ink)">Remove</button>
        </div>
      </div>
    </div>`;
}
function sizeGuideHTML(rec){
  if(!rec) return '';
  return `<span class="size-chip">${ICON.image}<b>${rec.w} × ${rec.h} px</b></span><span class="size-meta">Shape ${rec.ratio} · at least ${rec.minW} × ${rec.minH} px · ${rec.fmt}</span>`;
}
function ratioName(w, h){
  const g = (a,b)=> b ? g(b, a%b) : a; const d = g(w, h);
  const rw = w/d, rh = h/d;
  return rw<=20 && rh<=20 ? `${rw}:${rh}` : (w/h).toFixed(2)+':1';
}
function initImageField(key, opts, existing){
  IMG_FIELD[key] = {opts, removed:false, touched:false};
  const sg = document.getElementById(key+'Size'); if(sg) sg.innerHTML = sizeGuideHTML(opts.rec);
  const src = existing?.src || existing?.image || null;
  if(src) mountCropper(key, src, opts, existing?.src ? existing.crop : null);
  else showImagePlaceholder(key);
  updateImageFieldButtons(key);
}
function showImagePlaceholder(key){
  const f = IMG_FIELD[key];
  delete CROP[key];
  const host = document.getElementById(key+'Crop');
  if(host) host.innerHTML = `<label class="crop-empty ${f.opts.shape}" for="${key}File" style="${f.opts.aspect&&f.opts.aspect!==1?`aspect-ratio:${f.opts.aspect};height:auto;width:100%`:''}"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 17l-5-5-8 8"/></svg><span>Choose image</span></label>`;
}
function updateImageFieldButtons(key){
  const has = !!CROP[key];
  const lbl = document.getElementById(key+'UploadLabel'); if(lbl) lbl.textContent = has ? 'Replace image' : 'Upload image';
  const rm = document.getElementById(key+'Remove'); if(rm) rm.classList.toggle('hidden', !has);
}
async function onImageFieldFile(key, input){
  const file = input.files[0]; input.value = '';
  if(!file) return;
  const f = IMG_FIELD[key];
  try{
    const res = await readImageFile(file, f.opts.srcMax || (f.opts.fit==='contain' ? 512 : 720));
    f.touched = true; f.removed = false;
    mountCropper(key, res.src, f.opts, null);
    updateImageFieldButtons(key);
    const chk = document.getElementById(key+'Check'), rec = f.opts.rec;
    if(chk && rec){
      const small = res.w < rec.minW || res.h < rec.minH;
      const want = rec.w/rec.h, got = res.w/res.h;
      const off = Math.abs(got-want)/want > 0.12;
      chk.className = 'size-check ' + (small ? 'warn' : 'ok');
      chk.innerHTML = `Your image: <b>${res.w} × ${res.h} px</b> (${ratioName(res.w,res.h)}). ` +
        (small ? `That's smaller than ${rec.minW} × ${rec.minH} px, so it may look blurry. Use a bigger image if you can.` : 'Good size.') +
        (off ? (f.opts.fit==='contain' ? ` It isn't ${rec.ratio}, so it will sit inside the square with space around it.` : ` It isn't ${rec.ratio}, so part of it is cropped. Drag to choose what shows.`) : '');
    }
  }catch{ toast('That file could not be read. Choose a JPG, PNG or WebP image.', true) }
}
function clearImageField(key){ const chk = document.getElementById(key+'Check'); if(chk){ chk.className='size-check'; chk.innerHTML='' } const f = IMG_FIELD[key]; f.removed = true; f.touched = true; showImagePlaceholder(key); updateImageFieldButtons(key) }
/* returns undefined (unchanged), null (removed) or {image, src, crop} */
function imageFieldValue(key){
  const f = IMG_FIELD[key]; if(!f) return undefined;
  if(f.removed && !CROP[key]) return null;
  if(!CROP[key]) return undefined;
  return cropOutput(key);
}

function playerName(id){ if(!id) return 'TBD'; return STORE.players.find(p=>p.id===id)?.name || 'Unknown player' }
const AV_PALETTE = ['#1463FF','#0B1B3F','#7C3AED','#B45309','#0F7A4A','#BE185D','#0E7490','#4338CA'];
function avColor(name){ let h=0; for(const c of String(name||'?')) h=(h*31+c.charCodeAt(0))%997; return AV_PALETTE[h%AV_PALETTE.length] }
function initials(name){ const s = String(name||'?').replace(/[^A-Za-z0-9]/g,''); return (s || '?').slice(0,2).toUpperCase() }
function renderAvatar(player, size=54){
  const style = `width:${size}px;height:${size}px;font-size:${Math.max(10, Math.round(size*0.36))}px;background:${avColor(player?.name)}`;
  if(player && player.photo && isImgSrc(player.photo)) return `<span class="player-avatar" style="${style}"><img src="${esc(player.photo)}"${imgAttrs(player.photo)} loading="lazy" alt=""></span>`;
  return `<span class="player-avatar" style="${style}" aria-hidden="true">${esc(initials(player?.name))}</span>`;
}
function rankClass(i){ return i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'' }
const STATUS_LABEL = {active:'Live', live:'Live', open:'Open', completed:'Completed', draft:'Draft'};
function statusBadge(s){ return `<span class="badge badge-${esc(s)}">${esc(STATUS_LABEL[s]||s)}</span>` }
const CODE_COLORS = ['#1463FF','#B45309','#0B1B3F','#7C3AED','#0F7A4A','#BE185D','#0E7490'];
function tCode(t){ const words = String(t.name||'').split(/\s+/).filter(Boolean); const season = String(t.name||'').match(/season\s*(\d+)/i); if(season) return 'S'+season[1]; const c = words.filter(w=>/^[A-Za-z0-9]/.test(w)).slice(0,2).map(w=>w[0]).join('').toUpperCase(); return c || 'MT' }
function tColor(t){ return CODE_COLORS[[...String(t.id)].reduce((h,c)=>(h*31+c.charCodeAt(0))%997,0) % CODE_COLORS.length] }
const ICON = {
  users:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.2a5 5 0 0 1 3 5.3"/></svg>',
  trophy:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4.5h9v4.5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6.5H5a2.5 2.5 0 0 0 2.6 3.5M16.5 6.5H19a2.5 2.5 0 0 1-2.6 3.5M12 13.5v3.5M8.5 20h7M9.5 17h5"/></svg>',
  check:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/></svg>',
  clock:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  ball:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m12 7.5 3.6 2.6-1.4 4.2H9.8l-1.4-4.2z"/><path d="M12 3.5v4M20.3 9.3l-4.7.8M3.7 9.3l4.7.8M7.2 19l2.6-4.7M16.8 19l-2.6-4.7"/></svg>',
  goal:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 19.5V6.5l2.5-2h13l2.5 2v13"/><path d="M3 9h18M7.5 4.5v15M16.5 4.5v15M3 14h18"/></svg>',
  calendar:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  alarm:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5M4.5 4 2.5 6M19.5 4l2 2"/></svg>',
  arrow:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  plus:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  phone:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  image:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14.5" rx="2.5"/><circle cx="9" cy="10.5" r="1.8"/><path d="m20.5 16-4.5-4.5-8.5 8"/></svg>',
  hofEmblem:'<svg width="48" height="48" viewBox="8 6 48 50" aria-hidden="true"><g fill="none" stroke="#FFF7DC" stroke-width="1.8" stroke-linecap="round"><path d="M25.5 52.0A21 21 0 0 1 23.5 12.8"/><path d="M38.5 52.0A21 21 0 0 0 40.5 12.8"/></g><g fill="#FFF7DC"><ellipse cx="42.7" cy="52.0" rx="5.6" ry="2.5" transform="rotate(-180 42.7 52.0)"/><ellipse cx="45.8" cy="41.5" rx="5.3" ry="2.3" transform="rotate(-96 45.8 41.5)"/><ellipse cx="55.1" cy="35.6" rx="4.9" ry="2.2" transform="rotate(-132 55.1 35.6)"/><ellipse cx="50.0" cy="26.9" rx="4.6" ry="2.1" transform="rotate(-48 50.0 26.9)"/><ellipse cx="52.2" cy="16.8" rx="4.3" ry="1.9" transform="rotate(-84 52.2 16.8)"/><ellipse cx="42.3" cy="15.6" rx="3.9" ry="1.8" transform="rotate(0 42.3 15.6)"/><ellipse cx="39.2" cy="9.7" rx="2.2" ry="4.2" transform="rotate(20 39.2 9.7)"/><ellipse cx="21.3" cy="52.0" rx="5.6" ry="2.5" transform="rotate(0 21.3 52.0)"/><ellipse cx="18.2" cy="41.5" rx="5.3" ry="2.3" transform="rotate(-84 18.2 41.5)"/><ellipse cx="8.9" cy="35.6" rx="4.9" ry="2.2" transform="rotate(-48 8.9 35.6)"/><ellipse cx="14.0" cy="26.9" rx="4.6" ry="2.1" transform="rotate(-132 14.0 26.9)"/><ellipse cx="11.8" cy="16.8" rx="4.3" ry="1.9" transform="rotate(-96 11.8 16.8)"/><ellipse cx="21.7" cy="15.6" rx="3.9" ry="1.8" transform="rotate(-180 21.7 15.6)"/><ellipse cx="24.8" cy="9.7" rx="2.2" ry="4.2" transform="rotate(-20 24.8 9.7)"/></g><path d="M32.0 19.5L34.7 26.8L42.5 27.1L36.4 31.9L38.5 39.4L32.0 35.1L25.5 39.4L27.6 31.9L21.5 27.1L29.3 26.8z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/><path d="M27 53.5l5-2.6 5 2.6" fill="none" stroke="#FFF7DC" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cup:'<svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true"><path d="M17 12H9.5a1.5 1.5 0 0 0-1.5 1.5V18c0 7.2 5.4 12.6 12.4 13" fill="none" stroke="#E0A100" stroke-width="4" stroke-linecap="round"/><path d="M47 12h7.5a1.5 1.5 0 0 1 1.5 1.5V18c0 7.2-5.4 12.6-12.4 13" fill="none" stroke="#E0A100" stroke-width="4" stroke-linecap="round"/><path d="M16 7h32v15.5C48 32.2 40.8 40 32 40s-16-7.8-16-17.5V7z" fill="#F5B400"/><path d="M16 7h32v4H16z" fill="#FFCB2E"/><path d="M21.5 13v9c0 5.2 2.6 9.4 6.5 11.4" fill="none" stroke="#FFE68A" stroke-width="2.6" stroke-linecap="round"/><path d="M32 15.5l2.3 4.6 5.1.7-3.7 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.7-3.6 5.1-.7z" fill="#FFF6D6"/><path d="M28.5 40h7l1.5 7h-10z" fill="#D18F00"/><rect x="21" y="47" width="22" height="6" rx="1.5" fill="#B07C00"/><rect x="17" y="53" width="30" height="5" rx="2" fill="#0B1B3F"/></svg>'
};
async function copyText(text){
  try{ await navigator.clipboard.writeText(text); toast('Copied ' + text) }
  catch{ toast('Copy is blocked here. Select the number and copy it by hand.', true) }
}

const TINT_TO_SI = {'tint-blue':'blue','tint-purple':'purple','tint-green':'green','tint-gold':'gold','tint-orange':'orange'};
function statTile(icon, tint, label, value, delta){
  return `<div class="stat"><div class="stat-icon si si-${TINT_TO_SI[tint]||'blue'}">${ICON[icon]}</div><div class="stat-body"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${delta?`<span class="stat-delta">${delta}</span>`:''}</div></div>`;
}

/* =========================
   DASHBOARD
   ========================= */
function renderDashboard(){
  const tourneys = visibleTournaments();
  const stats = calculateAllStats();
  const totalMatches = STORE.tournaments.reduce((s,t)=> s + (t.fixtures||[]).filter(realResult).length + (t.knockoutBracket||[]).flat().filter(m=>!m.isBye && m.team1 && m.team2 && (matchTotals(t,m) || m.winner)).length, 0);
  const live = tourneys.filter(t=>t.status==='active');
  const completed = tourneys.filter(t=>t.status==='completed');
  const f = featuredTournament();
  const admin = isAdmin();
  setHeader(admin ? 'Welcome back, organiser' : 'Welcome to the community', 'Dashboard');

  const heroPill = f ? `<span class="live-pill"><i></i><span class="pill-text">${f.status==='active'?'Live now':'Registration open'} · ${esc(f.name)}</span></span>` : `<span class="live-pill"><i></i><span class="pill-text">Play · Compete · Belong</span></span>`;

  let ongoing;
  if(!f){
    ongoing = `<div class="empty" style="padding:28px 10px"><div class="empty-title">No tournament running</div><div class="text-sm">${admin?'Create the next one from Tournaments.':'The next tournament will show up here.'}</div>${admin?`<button class="btn btn-primary mt-16" onclick="openCreateTournament()">${ICON.plus} New Tournament</button>`:''}</div>`;
  } else {
    const fx = f.fixtures||[];
    const played = fx.filter(x=>hasScore(x.score1)&&hasScore(x.score2)).length;
    const stage = f.status==='open' ? 'Registration open' : f.format==='single_elimination' ? 'Knockout in progress' : (f.knockoutDrawn ? 'Knockout stage' : (f.format==='league' ? 'League in progress' : 'Group stage in progress'));
    const facts = [`${(f.registrations||[]).length} players`];
    if(f.format==='group_knockout') facts.push(`${f.groups} groups`, `Top ${f.qualifyPerGroup} qualify`);
    else facts.push(formatLabel(f.format));
    if(fx.length) facts.push(`${played}/${fx.length} played`);
    if(f.groupDeadline && f.format!=='single_elimination') facts.push(`Ends ${fmtDate(f.groupDeadline)}`);
    else facts.push(`${tDateInfo(f).label} ${fmtDate(tDateInfo(f).when)}`);
    ongoing = `
      <div class="ongoing">
        <div class="ongoing-art">
          ${f.logo ? `<span class="ongoing-logo">${tournamentLogo(f, 96, 'on-color')}</span>` : `<span class="ongoing-trophy">${ICON.cup.replace('width="36" height="36"','width="58" height="58"')}</span>`}
          <b>${esc(f.name)}</b><span>${esc(f.game||'eFootball')}</span>
        </div>
        <div class="ongoing-body">
          <h3 class="ongoing-name">${esc(f.name)}</h3>
          <span class="badge ${f.status==='active'?'badge-open':'badge-draft'}" style="align-self:flex-start">${stage}</span>
          <div class="facts">${facts.slice(0,4).map(x=>`<span>${esc(x)}</span>`).join('')}</div>
          <button type="button" class="btn btn-primary" style="margin-top:auto" onclick="navigate('tournament-detail','${f.id}')">View tournament</button>
        </div>
      </div>`;
  }

  const recent = [...completed].sort((a,b)=>String(b.completedAt||b.createdAt||'').localeCompare(String(a.completedAt||a.createdAt||''))).slice(0,4);
  const recentHtml = recent.length===0
    ? `<div class="empty" style="padding:28px 10px"><div class="empty-title">No results yet</div><div class="text-sm">Completed tournaments and their champions appear here.</div></div>`
    : recent.map(t=>`
      <div class="recent-row" role="button" tabindex="0" onclick="navigate('tournament-detail','${t.id}')" onkeydown="if(event.key==='Enter')navigate('tournament-detail','${t.id}')">
        ${t.logo ? tournamentLogo(t, 48) : `<div class="code-tile" style="background:${tColor(t)}">${esc(tCode(t))}</div>`}
        <div class="recent-main"><b>${esc(t.name)}</b><span><span style="color:var(--success);font-weight:600">Completed</span> · ${(t.registrations||[]).length} players</span></div>
        <div class="champ-mini">${t.champion?`<span>Champion</span><b>${esc(playerName(t.champion))}</b>`:''}</div>
      </div>`).join('');

  // Top 5 positions; everyone sharing the 5th place (or any place) is included.
  const ranked = rankPlayers(stats), cutRank = ranked[4]?.rank ?? Infinity;
  const topRows = ranked.filter(x=>x.rank<=cutRank).map(x=>`
      <div class="row-grid top-row">${rankMark(x)}${renderAvatar(x.p,30)}<span class="row-name">${esc(x.p.name)}</span><span class="row-num muted">${x.s.tourneyWins ? `<span class="lbx-title">${x.s.tourneyWins}</span>` : '–'}</span><span class="row-num"><b>${x.s.pts}</b></span></div>`).join('') || `<div class="text-sm text-muted">No players yet.</div>`;
  const hofLatest = [...STORE.hof].sort(hofSort).slice(0,4);
  const hofHtml = hofLatest.length ? hofLatest.map(h=>hofRow(h)).join('') : `<div class="empty" style="padding:24px 10px"><div class="empty-title" style="font-size:20px">No achievements yet</div><div class="text-sm">${admin?'Add titles and awards from the Hall of Fame page.':'Titles and awards will be listed here.'}</div></div>`;

  document.getElementById('main').innerHTML = `
    <section class="hero ${STORE.cover?.image?'has-cover':''}" aria-label="Community banner" ${cssUrl(STORE.cover?.image) ? `style="--cover:${cssUrl(STORE.cover.image)}"` : ''}>
      ${admin ? `<button type="button" class="hero-edit" onclick="openCoverModal()">${ICON.image}<span>${STORE.cover?.image?'Change cover':'Add cover picture'}</span></button>` : ''}
      ${STORE.cover?.image ? '' : `<svg class="hero-art" viewBox="0 0 600 260" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
        <polygon points="260,0 340,0 200,260 120,260" fill="#1463FF"/>
        <polygon points="360,0 400,0 260,260 220,260" fill="#3D8BFF" opacity="0.55"/>
        <polygon points="430,0 600,0 600,260 290,260" fill="#122A5C"/>
        <circle cx="500" cy="130" r="78" fill="none" stroke="#3D8BFF" stroke-width="2" opacity="0.6"/>
        <line x1="500" y1="0" x2="500" y2="260" stroke="#3D8BFF" stroke-width="2" opacity="0.6"/>
        <rect x="430" y="70" width="140" height="120" fill="none" stroke="#3D8BFF" stroke-width="2" opacity="0.35"/>
        <circle cx="500" cy="130" r="5" fill="#3D8BFF"/>
      </svg>`}
      ${heroPill}
      <div class="hero-title">${esc(commName())}</div>
      ${commTag() ? `<div class="hero-sub">${esc(commTag())}</div>` : ''}
      <div class="hero-actions">
        ${f ? `<button type="button" class="btn btn-white" onclick="navigate('tournament-detail','${f.id}')">${f.name.length>26 ? 'View tournament' : `View ${esc(f.name)}`} ${ICON.arrow}</button>` : `<button type="button" class="btn btn-white" onclick="navigate('tournaments')">Browse tournaments ${ICON.arrow}</button>`}
        <button type="button" class="btn btn-outline-navy" onclick="navigate('leaderboard')">Leaderboard</button>
      </div>
    </section>
    ${installBannerHTML()}

    <div class="grid grid-4">
      ${statTile('users','tint-blue','Total players', STORE.players.length)}
      ${statTile('trophy','tint-gold','Tournaments', tourneys.length)}
      ${statTile('check','tint-green','Completed', completed.length)}
      ${statTile('clock','tint-orange','Ongoing', live.length)}
      ${statTile('ball','tint-purple','Matches played', totalMatches)}
    </div>

    <div class="grid grid-2">
      <section class="card" aria-labelledby="ongoing-h" style="display:flex;flex-direction:column;gap:16px">
        <h2 id="ongoing-h" class="card-title">${f && f.status==='open' ? 'Upcoming Tournament' : 'Ongoing Tournament'}</h2>
        ${ongoing}
      </section>
      <section class="card" aria-labelledby="recent-h" style="display:flex;flex-direction:column;gap:10px">
        <div class="card-head" style="margin-bottom:4px"><h2 id="recent-h" class="card-title">Recent Tournaments</h2><button type="button" class="btn-link" onclick="navigate('tournaments')">View all →</button></div>
        ${recentHtml}
      </section>
    </div>

    <div class="grid grid-2">
      <section class="card" style="display:flex;flex-direction:column;gap:6px">
        <div class="card-head" style="margin-bottom:4px"><h2 class="card-title">Top Players</h2><button type="button" class="btn-link" onclick="navigate('leaderboard')">Leaderboard →</button></div>
        <div class="row-grid top-row row-head"><span>#</span><span></span><span>Player</span><span class="row-num">Titles</span><span class="row-num">PTS</span></div>
        ${topRows}
      </section>
      <section class="card" style="display:flex;flex-direction:column;gap:6px">
        <div class="card-head" style="margin-bottom:4px"><h2 class="card-title">Hall of Fame</h2><button type="button" class="btn-link" onclick="navigate('halloffame')">View all →</button></div>
        ${hofHtml}
      </section>
    </div>`;
}

/* Times shown to viewers. */
function lastResultOf(t){
  let best = null;
  (t.fixtures||[]).forEach(f=>{ if(f.scoredAt && realResult(f) && (!best || f.scoredAt > best.at)) best = {at:f.scoredAt, a:f.team1, b:f.team2, s:`${f.score1}–${f.score2}`} });
  (t.knockoutBracket||[]).flat().forEach(m=>{ if(m && m.scoredAt && m.winner && (!best || m.scoredAt > best.at)){ const r = koResult(t, m); best = {at:m.scoredAt, a:m.team1, b:m.team2, s: r.total ? `${r.total[0]}–${r.total[1]}` : ''} } });
  return best;
}
function updatedAtOf(t){ const lr = lastResultOf(t); return [t.resultsAt, lr?.at].filter(Boolean).sort().pop() || '' }
function whenText(iso){
  if(!iso) return '';
  const d = new Date(iso), now = new Date(), mins = Math.round((now-d)/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins} min ago`;
  const sameDay = d.toDateString()===now.toDateString();
  const y = new Date(now); y.setDate(now.getDate()-1);
  const hm = d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  if(sameDay) return `today at ${hm}`;
  if(d.toDateString()===y.toDateString()) return `yesterday at ${hm}`;
  return fmtDateTime(iso);
}
const ICON_CLOCK_SM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
function updatedLine(parts){ const p = parts.filter(Boolean); return p.length ? `<div class="upd-line"><span class="upd-a">${ICON_CLOCK_SM}${p[0]}</span>${p.slice(1).map(x=>`<span class="upd-b">${x}</span>`).join('')}</div>` : '' }
/* Leaderboard movement: compares with the table before the latest batch of results
   (everything entered within 3 hours of the newest result counts as one batch). */
function latestBatchCutoff(){
  let newest = '';
  STORE.tournaments.forEach(t=>{ const u = updatedAtOf(t); if(u > newest) newest = u; if(t.status==='completed' && t.completedAt > newest) newest = t.completedAt });
  if(!newest) return null;
  const all = [];
  STORE.tournaments.forEach(t=>{
    (t.fixtures||[]).forEach(f=>{ if(f.scoredAt) all.push(f.scoredAt) });
    (t.knockoutBracket||[]).flat().forEach(m=>{ if(m && m.scoredAt) all.push(m.scoredAt) });
    if(t.status==='completed' && t.completedAt) all.push(t.completedAt);
  });
  all.sort();
  // walk back from the newest result while gaps stay under 3 hours
  let start = all.at(-1);
  for(let i=all.length-2;i>=0;i--){ if(new Date(start) - new Date(all[i]) <= 3*3600e3) start = all[i]; else break }
  return {cutoff:start, newest};
}
function rankMoves(ranked){
  const b = latestBatchCutoff(); if(!b) return {};
  const before = rankPlayers(calculateAllStats(b.cutoff));
  const prev = {}; before.forEach(x=>{ prev[x.p.id] = x.rank });
  const out = {}; ranked.forEach(x=>{ const p = prev[x.p.id]; if(p && p!==x.rank) out[x.p.id] = p - x.rank });
  out.__since = b.cutoff; out.__newest = b.newest;
  return out;
}
function moveBadge(d){
  if(!d) return '';
  return d>0 ? `<span class="mv up" title="Up ${d} place${d>1?'s':''}"><i class="tri" aria-hidden="true"></i>${d}</span>`
             : `<span class="mv down" title="Down ${-d} place${d<-1?'s':''}"><i class="tri" aria-hidden="true"></i>${-d}</span>`;
}
function rankPlayers(stats){
  // Order: total points, then win percentage, then total wins.
  // Position: players on equal points share it (1, 2, 2, 4 …).
  const list = STORE.players.map(p=>({p, s:stats[p.id]})).sort((a,b)=> (b.s.pts-a.s.pts) || (parseFloat(b.s.winPct)-parseFloat(a.s.winPct)) || (b.s.wins-a.s.wins) || (b.s.matches-a.s.matches) || b.s.lastAt.localeCompare(a.s.lastAt) || b.s.addedAt.localeCompare(a.s.addedAt) || String(a.p.name).localeCompare(String(b.p.name)));
  list.forEach((x,i)=>{ x.rank = i && x.s.pts===list[i-1].s.pts ? list[i-1].rank : i+1; x.tied = false });
  list.forEach((x,i)=>{ if((list[i-1] && list[i-1].rank===x.rank) || (list[i+1] && list[i+1].rank===x.rank)) x.tied = true });
  return list;
}
const MEDAL_BY_RANK = {1:'gold', 2:'silver', 3:'bronze'};
/* Position badge: metallic disc for 1st–3rd, a plain tile otherwise. "=" marks a shared position. */
function rankBadge(rank, metal, tied){
  return `<span class="rk ${metal ? 'rk-'+metal : ''}" aria-label="Position ${rank}${tied?', shared':''}">${rank}${tied?'<small>=</small>':''}</span>`;
}
function rankMark(x){ return rankBadge(x.rank, x.s.pts>0 && MEDAL_BY_RANK[x.rank], x.tied) }

/* =========================
   PLAYERS
   ========================= */
function renderPlayers(){
  setHeader('Community', 'Players');
  const gs = document.getElementById('globalSearch');
  if(gs && gs.value!==playerQuery) gs.value = playerQuery;
  document.getElementById('main').innerHTML = `
    <div class="toolbar">
      <span class="page-sub" id="playersCount"></span>
      <div class="toolbar-actions">
        ${playerQuery ? `<button type="button" class="btn btn-secondary" onclick="onGlobalSearch('');document.getElementById('globalSearch').value=''">Clear search</button>` : ''}
        ${isAdmin() ? `<button type="button" class="btn btn-primary" onclick="openPlayerModal()">${ICON.plus} Add Player</button>` : ''}
      </div>
    </div>
    <div class="grid grid-3" id="playersGrid"></div>`;
  filterPlayers();
}

/* A phone number that opens a Telegram chat with that number (7-digit numbers are Maldives, +960). */
function telegramNumber(phone){
  let d = String(phone||'').replace(/[^\d+]/g, '');
  if(d.startsWith('+')) d = d.slice(1); else if(d.startsWith('00')) d = d.slice(2);
  d = d.replace(/\D/g, '');
  if(d.length===7) d = '960' + d;
  return d.length>=8 && d.length<=15 ? d : '';
}
function telegramLink(phone){
  const n = telegramNumber(phone);
  if(!n) return `<span>${esc(phone)}</span>`;
  return `<a class="tg-link" href="https://t.me/+${n}" target="_blank" rel="noopener noreferrer" title="Open Telegram chat" aria-label="Open Telegram chat with ${esc(phone)}">${esc(phone)}<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.5 4.1 2.9 11.3c-1.3.5-1.2 2.3.1 2.6l4.6 1.4 1.8 5.6c.3 1 1.6 1.3 2.3.5l2.6-2.6 4.6 3.4c.9.6 2.1.1 2.3-.9l3.1-15.1c.3-1.4-1.1-2.6-2.8-2.1zM17 8.3l-7.6 6.9-.3 3.2-1.4-4.4L17 8.3z"/></svg></a>`;
}

/* Every player card has the same titles box: each title won, or "No titles yet". */
function playerTitlesBox(s){
  const other = [s.tourneyRunnerUp ? `${s.tourneyRunnerUp}× Runner-up` : '', s.tourneyThird ? `${s.tourneyThird}× Third` : ''].filter(Boolean).join(' · ');
  if(!s.tourneyWins) return `<div class="pc-titles none">${ICON.cup.replace('width="36" height="36"','width="20" height="20"')}<div><b>No titles yet</b>${other ? `<span class="pc-other">${other}</span>` : ''}</div></div>`;
  return `<div class="pc-titles">${ICON.cup.replace('width="36" height="36"','width="22" height="22"')}<div style="min-width:0;flex:1">
      <b>${s.tourneyWins} title${s.tourneyWins===1?'':'s'}</b>
      <ul>${s.titles.map(tn=>`<li>${esc(tn)}</li>`).join('')}</ul>
      ${other ? `<span class="pc-other">${other}</span>` : ''}
    </div></div>`;
}
function renderPlayerCards(players, stats){
  if(players.length===0) return `<div class="empty" style="grid-column:1/-1"><div class="empty-title">${playerQuery?'No matching players':'No players yet'}</div><div class="text-sm">${playerQuery?'Try a different name.':isAdmin()?'Add your first player to get started.':'Players will appear here once registered.'}</div></div>`;
  return players.map(p=>{
    const s = stats[p.id];
    return `
    <div class="player-card">
      <div class="flex-between" style="align-items:flex-start">
        <div class="flex gap-12" style="align-items:center;min-width:0;flex:1">
          ${renderAvatar(p, 52)}
          <div style="min-width:0">
            <div class="player-name">${esc(p.name)}</div>
            ${isAdmin() ? (STORE.phones[p.id] ? `<div class="phone-line">${ICON.phone}${telegramLink(STORE.phones[p.id])}<button type="button" class="btn-link" onclick="copyText('${esc(STORE.phones[p.id])}')" aria-label="Copy phone number">Copy</button></div>` : `<div class="phone-line muted">${ICON.phone}<span>No phone number</span></div>`) : ''}
          </div>
        </div>
        ${isAdmin()?`<div class="flex gap-8">
          <button type="button" class="btn btn-ghost btn-icon" onclick="openPlayerModal('${p.id}')" aria-label="Edit ${esc(p.name)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button type="button" class="btn btn-ghost btn-icon" onclick="deletePlayer('${p.id}')" style="color:var(--danger-ink)" aria-label="Delete ${esc(p.name)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>`:''}
      </div>
      ${playerTitlesBox(s)}
      <div class="player-stats">
        <div><div class="player-stat-val">${s.matches}</div><div class="player-stat-lbl">Played</div></div>
        <div><div class="player-stat-val">${s.wins}</div><div class="player-stat-lbl">Wins</div></div>
        <div><div class="player-stat-val">${s.gf}</div><div class="player-stat-lbl">Goals</div></div>
        <div><div class="player-stat-val" style="color:var(--primary)">${s.winPct}%</div><div class="player-stat-lbl">Win rate</div></div>
      </div>
    </div>`}).join('');
}

function filterPlayers(){
  const q = playerQuery.trim().toLowerCase();
  // A–Z by name, ignoring the shared "MG " prefix and letter case.
  const sortKey = n => String(n||'').replace(/^mg\s+/i,'').toLowerCase();
  const players = STORE.players.filter(p=>p.name.toLowerCase().includes(q)).sort((a,b)=>sortKey(a.name).localeCompare(sortKey(b.name)));
  const grid = document.getElementById('playersGrid');
  if(!grid) return;
  grid.innerHTML = renderPlayerCards(players, calculateAllStats());
  const c = document.getElementById('playersCount');
  if(c) c.textContent = q ? `${players.length} of ${STORE.players.length} players match "${playerQuery.trim()}"` : `${STORE.players.length} players · stats update from tournament results`;
}

const IMG_SIZES = {
  photo: {w:512, h:512, minW:256, minH:256, ratio:'1:1 (square)', fmt:'JPG or PNG', label:'Player photo'},
  logo: {w:512, h:512, minW:256, minH:256, ratio:'1:1 (square)', fmt:'PNG with a transparent background is best', label:'Community & tournament logo'},
  cover: {w:1500, h:500, minW:1200, minH:400, ratio:'3:1 (wide)', fmt:'JPG', label:'Dashboard cover'},
  side: {w:720, h:600, minW:480, minH:400, ratio:'6:5', fmt:'JPG', label:'Sidebar picture'},
  hofcover: {w:1400, h:400, minW:1050, minH:300, ratio:'7:2 (wide)', fmt:'JPG', label:'Hall of Fame picture'}
};
const PHOTO_OPTS = {shape:'circle', fit:'cover', out:256, rec:IMG_SIZES.photo};
const LOGO_OPTS = {shape:'square', fit:'contain', out:512, rec:IMG_SIZES.logo};

function openPlayerModal(id){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const p = id ? STORE.players.find(x=>x.id===id) : {name:'', photo:null, achievements:''};
  if(!p) return;
  openModal(`
    <div class="modal-head">
      <div class="modal-title">${id?'Edit':'Add'} Player</div>
      <button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button>
    </div>
    <div class="modal-body">
      ${imageFieldHTML('photo', 'Profile picture', 'Upload a photo, then drag and zoom until the face sits nicely in the circle.')}
      <div class="form-group">
        <label class="form-label" for="p_name">Player Name</label>
        <input class="form-input" id="p_name" value="${esc(p.name)}" placeholder="e.g. MG L30" maxlength="40">
      </div>
      <div class="form-group">
        <label class="form-label" for="p_phone">Phone number</label>
        <input class="form-input" id="p_phone" type="tel" inputmode="tel" autocomplete="off" value="${esc(id ? (STORE.phones[id]||'') : '')}" placeholder="e.g. +960 777 1234" maxlength="24">
        <div class="text-xs text-muted" style="margin-top:6px">Only organisers can see phone numbers. Leave empty if you don't have one.</div>
      </div>
      <div class="text-sm text-muted">Matches, wins, win% and titles are calculated from tournament results.</div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="savePlayer('${id||''}')">${id?'Save Changes':'Add Player'}</button>
    </div>`);
  initImageField('photo', PHOTO_OPTS, p.photo ? {image:p.photo, src:p.photoSrc, crop:p.photoCrop} : null);
  setTimeout(()=>document.getElementById('p_name')?.focus(), 50);
}

function applyImage(obj, field, val){
  if(val===undefined) return;
  if(val===null){ obj[field] = null; obj[field+'Src'] = null; obj[field+'Crop'] = null; return }
  obj[field] = val.image; obj[field+'Src'] = val.src; obj[field+'Crop'] = val.crop;
}

function savePlayer(id){
  const name = document.getElementById('p_name').value.trim();
  if(!name){ toast('Enter a player name', true); return }
  const players = DB.get('players');
  if(players.some(p=>p.id!==id && p.name.toLowerCase()===name.toLowerCase())){ toast('A player with that name already exists', true); return }
  const phone = document.getElementById('p_phone').value.trim().replace(/\s+/g,' ');
  if(phone && !/^\+?[0-9][0-9 ()\-]{4,22}$/.test(phone)){ toast('Enter the phone number with digits only (spaces, +, - and brackets are fine)', true); return }
  const img = imageFieldValue('photo');
  let pid = id;
  if(id){
    const idx = players.findIndex(p=>p.id===id);
    if(idx>=0){ players[idx] = {...players[idx], name}; applyImage(players[idx], 'photo', img) }
  } else {
    const p = {id:uid(), name, photo:null, createdAt:new Date().toISOString()};
    applyImage(p, 'photo', img);
    players.push(p);
    pid = p.id;
  }
  DB.set('players', players);
  if((STORE.phones[pid]||'') !== phone) setPhone(pid, phone);
  closeModal();
  rerender();
  toast(id ? 'Player updated' : 'Player added');
}

async function deletePlayer(id){
  const p = STORE.players.find(x=>x.id===id);
  if(!p) return;
  const inUse = STORE.tournaments.filter(t=>(t.registrations||[]).some(r=>r.playerId===id)).length;
  const ok = await confirmDialog('Delete player', `Delete ${p.name}?${inUse?` They appear in ${inUse} tournament${inUse>1?'s':''}; those results will show "Unknown player".`:''} This cannot be undone.`, 'Delete');
  if(!ok) return;
  DB.set('players', DB.get('players').filter(x=>x.id!==id));
  if(STORE.phones[id]) setPhone(id, '');
  rerender();
  toast('Player deleted');
}

/* =========================
   TOURNAMENTS LIST
   ========================= */
function renderTournaments(){
  setHeader('Compete', 'Tournaments');
  const opts = [['all','All'],['active','Live'],['open','Open'],['completed','Completed']].concat(isAdmin()?[['draft','Drafts']]:[]);
  document.getElementById('main').innerHTML = `
    <div class="tabs-wrap">
      <div class="segmented" role="group" aria-label="Filter tournaments">
        ${opts.map(([v,l])=>`<button type="button" class="seg ${tourneyFilter===v?'active':''}" aria-pressed="${tourneyFilter===v}" data-filter="${v}" onclick="filterTournaments('${v}')">${l}</button>`).join('')}
      </div>
      ${isAdmin() ? `<button type="button" class="btn btn-primary" onclick="openCreateTournament()">${ICON.plus} New Tournament</button>` : ''}
    </div>
    <div class="grid grid-3" id="tourneyGrid"></div>`;
  filterTournaments(tourneyFilter);
}

/* Date label by status: "Starting on" before it starts, "Started on" while live, "Ended on" once completed. */
function tDateInfo(t){
  if(t.status==='completed') return {label:'Ended on', when: t.completedAt || t.startDateTime || t.date};
  if(t.status==='active') return {label:'Started on', when: t.startDateTime || t.startedAt || t.date};
  return {label:'Starting on', when: t.startDateTime || t.date};
}
function renderTournamentCards(list){
  if(list.length===0) return `<div class="card empty" style="grid-column:1/-1"><div class="empty-title">No tournaments here yet</div><div class="text-sm">${isAdmin()?'Create one with New Tournament.':'New tournaments will appear here.'}</div></div>`;
  return list.map(t=>{
    const n = (t.registrations||[]).length;
    const champ = t.champion ? `<div class="champ-box">${ICON.cup.replace('width="36" height="36"','width="26" height="26"')}<div style="min-width:0"><small>CHAMPION</small><b>${esc(playerName(t.champion))}</b>${t.completedAt?`<span class="champ-ended">Ended on ${fmtDate(t.completedAt)}</span>`:''}</div></div>`
      : `<div class="champ-box" style="background:var(--surface-2)"><span class="stat-icon tint-blue" style="width:36px;height:36px;border-radius:10px">${ICON.calendar}</span><div style="min-width:0"><small style="color:var(--muted)">${tDateInfo(t).label.toUpperCase()}</small><b style="font-size:18px">${fmtDateTime(tDateInfo(t).when)}</b></div></div>`;
    return `
    <button type="button" class="t-card" onclick="navigate('tournament-detail','${t.id}')">
      ${tCardHead(t)}
      <div class="t-card-body">
        <div><div class="t-card-name">${esc(t.name)}</div><div class="t-card-meta">${formatLabel(t.format)}${t.prize?.champion?` · Prize ${esc(t.prize.champion)}`:''}</div></div>
        ${champ}
        <div class="t-card-foot"><span>${n} player${n===1?'':'s'}</span><b>View ${t.status==='completed'?'results':'tournament'} →</b></div>
      </div>
    </button>`}).join('');
}

/* Card header: navy with a soft glow in the status colour and faint pitch lines; live tournaments show progress. */
function tCardHead(t){
  const fx = t.fixtures||[], ko = (t.knockoutBracket||[]).flat().filter(m=>m && !m.isBye && m.team1 && m.team2);
  const total = fx.length + ko.length, played = fx.filter(f=>hasScore(f.score1)&&hasScore(f.score2)).length + ko.filter(m=>m.winner).length;
  const stage = t.status==='active' ? (t.format==='single_elimination' || t.knockoutDrawn ? 'Knockout stage' : t.format==='league' ? 'League' : 'Group stage') : t.status==='open' ? 'Registration open' : t.status==='completed' ? 'Finished' : 'Draft';
  return `<div class="t-card-head st-${esc(t.status)}">
    <svg class="t-card-pitch" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g fill="none" stroke="#FFFFFF" stroke-opacity=".07" stroke-width="2"><rect x="200" y="-20" width="260" height="180" rx="4"/><circle cx="200" cy="70" r="46"/><path d="M200 -20v180"/><rect x="380" y="25" width="60" height="90"/></g></svg>
    ${t.logo ? tournamentLogo(t, 76, 'on-color') : `<span class="t-card-code">${esc(tCode(t))}</span>`}
    <div class="t-card-side">
      ${t.status==='active' ? `<span class="t-live"><i></i>Live</span>` : statusBadge(t.status)}
      <span class="t-card-stage">${stage}</span>
    </div>
    ${t.status==='active' && total ? `<div class="t-card-prog" title="${played} of ${total} matches played"><i style="width:${Math.round(played/total*100)}%"></i></div>` : ''}
  </div>`;
}

function filterTournaments(status){
  tourneyFilter = status;
  document.querySelectorAll('[data-filter]').forEach(b=>{ const on = b.dataset.filter===status; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on) });
  const all = visibleTournaments();
  document.getElementById('tourneyGrid').innerHTML = renderTournamentCards(status==='all' ? all : all.filter(t=>t.status===status));
}

/* =========================
   CREATE TOURNAMENT
   ========================= */
function openCreateTournament(){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const players = STORE.players, stats = calculateAllStats();
  openModal(`
    <div class="modal-head">
      <div class="modal-title">Create Tournament</div>
      <button class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label" for="t_name">Tournament Name</label>
        <input class="form-input" id="t_name" placeholder="e.g. Milandhoo Champions League Season 5" maxlength="80">
      </div>
      ${imageFieldHTML('tlogo', 'Tournament logo (optional)', 'Shown on the tournament page, cards and exported images. Drag and zoom to fit it in the square.')}
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="t_datetime_d">Start date &amp; time</label>${dtField('t_datetime', localDT(new Date(Date.now()+864e5)), '20:00')}</div>
        <div class="form-group"><label class="form-label" for="t_deadline_d">Group stage deadline (optional)</label>${dtField('t_deadline', localDT(new Date(Date.now()+7*864e5)).slice(0,10)+'T23:59')}</div>
      </div>
      <div class="form-group">
        <label class="form-label" for="t_format">Format</label>
        <select class="form-select" id="t_format" onchange="toggleFormatFields()">
          <option value="group_knockout">Group Stage + Knockout</option>
          <option value="league">League (Round-Robin)</option>
          <option value="single_elimination">Single Elimination</option>
        </select>
      </div>

      <div id="format-group_knockout">
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="t_groups">Number of Groups</label><input class="form-input" type="number" id="t_groups" value="2" min="1" max="16" oninput="updateConfigHelper()"></div>
          <div class="form-group"><label class="form-label" for="t_qualify">Qualify per Group</label><input class="form-input" type="number" id="t_qualify" value="2" min="1" max="8" oninput="updateConfigHelper()"></div>
        </div>
        <div class="config-helper" id="configHelper"></div>
      </div>

      <div id="format-league" class="hidden">
        <div class="form-group">
          <label class="form-label" for="t_league_rounds">Rounds</label>
          <select class="form-select" id="t_league_rounds">
            <option value="1">Single Round-Robin</option>
            <option value="2">Double Round-Robin (Home &amp; Away)</option>
          </select>
        </div>
      </div>

      <div id="format-knockout-opts">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="t_ko">Knockout Match Format</label>
            <select class="form-select" id="t_ko">
              <option value="single">Single Match</option>
              <option value="bo3">Best of 3</option>
              <option value="2leg">2-Leg (Home &amp; Away)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="t_seeding">Knockout Seeding</label>
            <select class="form-select" id="t_seeding">
              <option value="dynamic">Seeded by group finish (winners meet runners-up)</option>
              <option value="random">Random bracket</option>
            </select>
          </div>
        </div>
      </div>

      <div class="card mt-16" style="background:var(--surface-2);padding:16px">
        <div class="card-title" style="margin-bottom:12px">Prize Pool</div>
        <div class="form-row-3">
          <div class="form-group"><label class="form-label" for="t_prize_1">Champion</label><input class="form-input" id="t_prize_1" placeholder="e.g. 5000 MVR"></div>
          <div class="form-group"><label class="form-label" for="t_prize_2">Runner-up</label><input class="form-input" id="t_prize_2" placeholder="e.g. 2500 MVR"></div>
          <div class="form-group"><label class="form-label" for="t_prize_3">Third Place</label><input class="form-input" id="t_prize_3" placeholder="e.g. 1000 MVR"></div>
        </div>
      </div>

      <div class="form-row mt-16">
        <div class="form-group">
          <label class="form-label" for="t_status">Visibility</label>
          <select class="form-select" id="t_status">
            <option value="open">Open (visible to everyone)</option>
            <option value="draft">Draft (admins only)</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label" for="t_game">Game</label><input class="form-input" id="t_game" value="eFootball 2026"></div>
      </div>

      <div class="form-group">
        <label class="form-label" for="t_desc">Description (optional)</label>
        <textarea class="form-textarea" id="t_desc" placeholder="Tournament rules, format details..."></textarea>
      </div>

      <div class="card mt-16" style="background:var(--surface-2);padding:16px">
        <div class="flex-between" style="margin-bottom:12px">
          <div class="card-title">Select Participants</div>
          <div class="flex gap-8">
            <button class="btn btn-ghost btn-sm" onclick="toggleAllChecks('createPlayerList', true)">Select All</button>
            <button class="btn btn-ghost btn-sm" onclick="toggleAllChecks('createPlayerList', false)">Clear</button>
          </div>
        </div>
        <div class="player-check-list" id="createPlayerList" style="max-height:280px">
          ${players.map(p=>`
            <label class="player-check-item">
              <input type="checkbox" value="${p.id}" onchange="toggleCheckItem(this,'createPlayerList')">
              ${renderAvatar(p, 34)}
              <div class="info"><div class="name">${esc(p.name)}</div><div class="meta">${stats[p.id].matches} matches · ${stats[p.id].winPct}% win</div></div>
            </label>`).join('')}
          ${players.length===0?'<div class="empty"><div class="empty-title">No players yet</div><div class="text-sm">Add players from the Players page first.</div></div>':''}
        </div>
        <div class="config-helper mt-16" id="createPlayerList-summary"><strong>Selected:</strong> 0 players</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveTournament()">Create Tournament</button>
    </div>`, 'xl');
  toggleFormatFields();
  initImageField('tlogo', LOGO_OPTS, null);
}

function toggleCheckItem(cb, listId){
  cb.closest('.player-check-item').classList.toggle('selected', cb.checked);
  updateSelectionSummary(listId);
}
function toggleAllChecks(listId, state){
  document.querySelectorAll(`#${listId} input[type="checkbox"]`).forEach(cb=>{ cb.checked = state; cb.closest('.player-check-item').classList.toggle('selected', state) });
  updateSelectionSummary(listId);
}
function updateSelectionSummary(listId){
  const n = document.querySelectorAll(`#${listId} input[type="checkbox"]:checked`).length;
  const el = document.getElementById(listId+'-summary');
  if(el) el.innerHTML = `<strong>Selected:</strong> ${n} player${n!==1?'s':''}`;
  if(listId==='createPlayerList') updateConfigHelper();
}

function updateConfigHelper(){
  const el = document.getElementById('configHelper');
  if(!el || document.getElementById('t_format')?.value!=='group_knockout') return;
  const numGroups = Math.max(1, parseInt(document.getElementById('t_groups').value)||1);
  const qualify = Math.max(1, parseInt(document.getElementById('t_qualify').value)||1);
  const count = document.querySelectorAll('#createPlayerList input[type="checkbox"]:checked').length;
  if(count===0){ el.innerHTML = `<strong>Select participants</strong> below to preview the group split.`; return }
  const dist = distributePlayersToGroups(count, numGroups);
  const totalQ = dist.reduce((s,size)=>s+Math.min(size, qualify), 0);
  const bracket = nextPow2(totalQ);
  const warn = dist.some(s=>s<qualify) ? `<br>⚠️ Some groups have fewer players than qualifiers.` : '';
  el.innerHTML = `
    <strong>Configuration Preview</strong><br>
    • Participants: <strong>${count} players</strong><br>
    • Group sizes: <strong>${dist.join(', ')}</strong>${dist.some(x=>x!==dist[0])?' (uneven)':''}<br>
    • Group matches: <strong>${dist.reduce((s,n)=>s+n*(n-1)/2,0)}</strong><br>
    • Qualifiers: <strong>${totalQ}</strong> → knockout bracket of <strong>${bracket}</strong>${bracket>totalQ?` (${bracket-totalQ} bye${bracket-totalQ>1?'s':''} for top seeds)`:''}${warn}`;
}

function toggleFormatFields(){
  const f = document.getElementById('t_format').value;
  ['group_knockout','league'].forEach(x=>document.getElementById('format-'+x).classList.toggle('hidden', x!==f));
  document.getElementById('format-knockout-opts').classList.toggle('hidden', f==='league');
  const seedSel = document.getElementById('t_seeding');
  if(seedSel) seedSel.closest('.form-group').classList.toggle('hidden', f!=='group_knockout');
  updateConfigHelper();
}

function saveTournament(){
  const name = document.getElementById('t_name').value.trim();
  if(!name){ toast('Enter a tournament name', true); return }
  const format = document.getElementById('t_format').value;
  const dt = readDT('t_datetime');
  const checked = Array.from(document.querySelectorAll('#createPlayerList input[type="checkbox"]:checked')).map(cb=>cb.value);
  const t = {
    id: uid(), name, date: dt.slice(0,10), startDateTime: dt,
    groupDeadline: format==='single_elimination' ? '' : readDT('t_deadline'),
    format,
    game: document.getElementById('t_game').value.trim(),
    prize: { champion: document.getElementById('t_prize_1').value.trim(), runnerUp: document.getElementById('t_prize_2').value.trim(), thirdPlace: document.getElementById('t_prize_3').value.trim() },
    status: document.getElementById('t_status').value,
    description: document.getElementById('t_desc').value.trim(),
    registrations: checked.map(pid=>({playerId:pid, date:new Date().toISOString()})),
    createdAt: new Date().toISOString()
  };
  applyImage(t, 'logo', imageFieldValue('tlogo'));
  if(format==='group_knockout'){
    t.groups = Math.max(1, parseInt(document.getElementById('t_groups').value)||1);
    t.qualifyPerGroup = Math.max(1, parseInt(document.getElementById('t_qualify').value)||1);
    t.seeding = document.getElementById('t_seeding').value;
  }
  if(format!=='league') t.knockoutFormat = document.getElementById('t_ko').value;
  if(format==='league') t.leagueRounds = parseInt(document.getElementById('t_league_rounds').value);
  const tourneys = DB.get('tournaments');
  tourneys.unshift(t);
  DB.set('tournaments', tourneys);
  closeModal();
  navigate('tournament-detail', t.id);
  toast(`Tournament created with ${checked.length} participant${checked.length!==1?'s':''}`);
}

/* =========================
   TOURNAMENT DETAIL
   ========================= */
function getT(tid){ const all = DB.get('tournaments'); return {all, t: all.find(x=>x.id===tid)} }

function availableTabs(t){
  const hasStandings = t.format==='group_knockout' || t.format==='league';
  const hasKO = t.format==='group_knockout' || t.format==='single_elimination';
  const tabs = [['tab-overview','Overview'],['tab-rules','Rules'],['tab-registration',`Players (${(t.registrations||[]).length})`]];
  if(hasStandings) tabs.push(['tab-standings', t.format==='league'?'Table':'Standings'], ['tab-fixtures','Fixtures']);
  if(hasKO) tabs.push(['tab-knockout','Knockout']);
  if((t.fixtures||[]).length || t.knockoutDrawn) tabs.push(['tab-stats','Stats']);
  tabs.push(['tab-player','Player View']);
  return tabs;
}

function renderTournamentDetail(id){
  processDeadline(id);
  const t = STORE.tournaments.find(x=>x.id===id);
  const admin = isAdmin();
  if(!t || (t.status==='draft' && !admin)){ currentView='tournaments'; rerender(); return }
  const tabs = availableTabs(t);
  if(!tabs.some(x=>x[0]===currentTab)) currentTab = 'tab-overview';
  setHeader('Tournaments', t.name, "navigate('tournaments')");

  document.getElementById('main').innerHTML = `
    <div class="toolbar t-toolbar">
      <div class="t-meta">
        ${tournamentLogo(t, 52)}
        ${statusBadge(t.status)}
        <span class="badge badge-format">${formatLabel(t.format)}</span>
        <span class="page-sub">${tDateInfo(t).label} ${fmtDateTime(tDateInfo(t).when)} · ${esc(t.game||'eFootball')}</span>
      </div>
      ${admin ? `<div class="toolbar-actions t-actions">
        ${t.status==='active' ? `<button type="button" class="btn btn-primary" onclick="openCompleteTournamentModal('${t.id}')">Complete tournament</button>`:''}
        ${(t.groupsDrawn || t.knockoutDrawn) && t.status!=='completed' ? `<button type="button" class="btn btn-secondary" onclick="openMessagePlayersModal('${t.id}')">${TG_SVG} Message players</button>` : ''}
        <button type="button" class="btn btn-secondary" onclick="editTournament('${t.id}')">Edit settings</button>
        <button type="button" class="btn btn-danger" onclick="deleteTournament('${t.id}')">Delete</button>
      </div>` : ''}
    </div>

    ${admin && (t.status==='open' || t.status==='draft') ? `
      <div class="start-banner">
        <div class="start-banner-info"><div class="start-banner-title">Ready to start?</div><div class="start-banner-desc">${nextStepText(t)}</div></div>
        <button type="button" class="btn btn-success" onclick="startTournament('${t.id}')">Start tournament</button>
      </div>`:''}

    ${t.status==='completed' && t.champion ? `
      <div class="start-banner done">
        <div class="trophy-disc">${ICON.cup}</div>
        <div class="start-banner-info"><div class="countdown-label" style="color:var(--gold-ink)">Champion</div><div class="start-banner-title" style="font-size:32px">${esc(playerName(t.champion))}</div><div class="start-banner-desc">Completed ${fmtDate(t.completedAt)}${t.runnerUp?` · Runner-up ${esc(playerName(t.runnerUp))}`:''}${t.thirdPlace?` · Third ${esc(playerName(t.thirdPlace))}`:''}</div></div>
      </div>`:''}

    <div class="tabs-wrap tabs-sticky">
      <div class="tabs" id="detailTabs" role="tablist" aria-label="Tournament sections">
        ${tabs.map(([tid,label])=>`<button type="button" class="tab ${tid===currentTab?'active':''}" role="tab" aria-selected="${tid===currentTab}" data-tab="${tid}" onclick="switchTab('${tid}')">${label}</button>`).join('')}
      </div>
    </div>

    ${tabs.map(([tid])=> tid===currentTab
      ? `<div id="${tid}" class="tab-panel">${renderTabPanel(t, tid)}</div>`
      : `<div id="${tid}" class="tab-panel hidden" data-lazy="1"></div>`).join('')}`;
  requestAnimationFrame(()=>revealActiveTab(false));
}

/* Keep the selected tab visible in the scrolling tab bar, without moving the page. */
function revealActiveTab(smooth){
  const box = document.getElementById('detailTabs'), act = box && box.querySelector('.tab.active');
  if(!act) return;
  const b = box.getBoundingClientRect(), a = act.getBoundingClientRect();
  let d = 0;
  if(a.left < b.left + 8) d = a.left - b.left - 8;
  else if(a.right > b.right - 28) d = a.right - b.right + 28;
  if(d) box.scrollBy({left:d, behavior: smooth ? 'smooth' : 'auto'});
}

/* Only the open tab is built; the others are built when first opened. */
function renderTabPanel(t, tabId){
  const admin = isAdmin(), canEditScores = t.status==='active' || t.status==='completed';
  if(tabId==='tab-overview') return tournamentIntro(t) + renderTournamentOverview(t);
  if(tabId==='tab-rules') return renderRulesTab(t, admin);
  if(tabId==='tab-registration') return renderRegistrationTab(t, admin);
  if(tabId==='tab-standings') return renderStandingsTab(t, admin, canEditScores);
  if(tabId==='tab-fixtures') return renderAllFixturesTab(t, admin, canEditScores);
  if(tabId==='tab-knockout') return renderKnockoutTab(t, admin, canEditScores);
  if(tabId==='tab-player') return renderPlayerViewTab(t);
  if(tabId==='tab-stats') return renderStatsTab(t);
  return '';
}

/* Description, group-stage deadline and prizes, shown at the top of the Overview tab. */
/* Group-stage deadline rules (the same wording the Telegram bot sends). */
function reportCutoffText(t){
  const d = String(t.groupDeadline||''); if(!d) return '';
  const day = d.slice(0,10), hm = d.slice(11,16);
  return hm && hm > '21:00' ? `before 21:00 on ${fmtDate(day)}` : 'before the deadline';
}
function deadlineRulesHTML(t){
  return `<li>Any match not played by the deadline is counted as <b>0–0 with no points</b> for either player.</li>
    <li>If your opponent doesn't play your match, inform an admin <b>${esc(reportCutoffText(t))}</b>. Reports after that won't be accepted.</li>
    <li>A player who doesn't play gets a <b>1–0 loss</b>: the win goes to their opponent.</li>`;
}
function tournamentIntro(t){
  const hasStandings = t.format==='group_knockout' || t.format==='league';
  const isDeadlinePassed = t.groupDeadline && new Date(t.groupDeadline) < new Date();
  const showDeadline = t.groupDeadline && hasStandings && t.status!=='completed';
  const prize = (cls, n, label, value, winner) => `
    <div class="prize-card ${cls}">${prizeIconHTML(cls, n)}<div style="min-width:0"><div class="prize-label">${label}</div><div class="prize-value">${esc(value||'—')}</div>${winner?`<div class="prize-winner">${esc(playerName(winner))}</div>`:''}</div></div>`;
  return `
    ${t.description?`<div class="card"><div class="text-sm" style="white-space:pre-wrap;color:var(--text-2)">${esc(t.description)}</div></div>`:''}
    ${showDeadline ? `
      <div class="deadline-notice ${isDeadlinePassed?'passed':''}">
        <div class="deadline-notice-icon">${isDeadlinePassed?ICON.alarm:ICON.calendar}</div>
        <div class="deadline-notice-content">
          <div class="deadline-notice-title">${isDeadlinePassed?'Group stage deadline passed':'Group stage deadline'}</div>
          <div class="deadline-notice-text">${fmtDateTime(t.groupDeadline)}${isDeadlinePassed?' · Unplayed matches are recorded as 0-0 draws':''}</div>
          ${isDeadlinePassed ? '' : `<ul class="deadline-rules">${deadlineRulesHTML(t)}</ul>`}
        </div>
      </div>`:''}
    ${(t.prize?.champion || t.prize?.runnerUp || t.prize?.thirdPlace)?`
      <div class="grid grid-3 prize-grid">
        ${prize('gold','1','Champion',t.prize.champion,t.champion)}
        ${prize('silver','2','Runner-up',t.prize.runnerUp,t.runnerUp)}
        ${prize('bronze','3','Third place',t.prize.thirdPlace,t.thirdPlace)}
      </div>
      ${isAdmin() && isUnlocked() ? `<div class="prize-edit-row"><button type="button" class="btn btn-ghost btn-sm" onclick="openPrizeIconsModal()">${ICON.image} Change prize icons</button></div>` : ''}`:''}`;
}

/* =========================
   PRIZE ICONS (community-wide): a number, an emoji or a small picture for champion, runner-up and third place.
   ========================= */
const PRIZE_SLOTS = [['gold','1','Champion'],['silver','2','Runner-up'],['bronze','3','Third place']];
const PRIZE_PRESETS = {gold:['1','🏆','🥇','👑','💰','⭐'], silver:['2','🥈','🏅','💰','⭐','🎁'], bronze:['3','🥉','🏅','💰','⭐','🎁']};
function prizeIcon(cls){ const v = STORE.settings?.prizeIcons?.[cls]; return typeof v==='string' && v.trim() ? v : '' }
function prizeIconHTML(cls, n){
  const v = prizeIcon(cls);
  if(v && isImgSrc(v)) return `<div class="prize-medal has-img"><img src="${esc(v)}"${imgAttrs(v)} alt=""></div>`;
  return `<div class="prize-medal${v && v!==n && !/^\d$/.test(v) ? ' is-emoji' : ''}">${esc(v || n)}</div>`;
}
let PRIZE_DRAFT = {};
function openPrizeIconsModal(){
  if(!isAdmin()){ toast('Admin access required', true); return }
  PRIZE_DRAFT = {};
  PRIZE_SLOTS.forEach(([cls, n])=>{ PRIZE_DRAFT[cls] = prizeIcon(cls) || n });
  openModal(`
    <div class="modal-head"><div class="modal-title">Prize icons</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:18px">
      <div class="page-sub">Shown on the prize cards of every tournament. Pick a number or emoji, type your own, or upload a small picture (a square PNG with a clear background works best).</div>
      <div id="prizeIconRows">${prizeIconRows()}</div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" onclick="resetPrizeIcons()">Use numbers</button>
      <button type="button" class="btn btn-primary" onclick="savePrizeIcons()">Save icons</button>
    </div>`);
}
function prizeIconRows(){
  return PRIZE_SLOTS.map(([cls, n, label])=>{
    const v = PRIZE_DRAFT[cls], img = isImgSrc(v);
    return `<fieldset class="prize-icon-edit ${cls}">
      <legend>${label}</legend>
      <div class="pie-main">
        <span class="prize-card ${cls}" style="padding:0;border:0;box-shadow:none;background:none">${img ? `<div class="prize-medal has-img"><img src="${esc(v)}" alt=""></div>` : `<div class="prize-medal${/^\d$/.test(v)?'':' is-emoji'}">${esc(v)}</div>`}</span>
        <div class="pie-presets" role="group" aria-label="${label} icon">
          ${PRIZE_PRESETS[cls].map(x=>`<button type="button" class="pie-chip ${x===v?'active':''}" aria-pressed="${x===v}" onclick="setPrizeIcon('${cls}','${x}')">${x}</button>`).join('')}
        </div>
      </div>
      <div class="pie-own">
        <input class="form-input" maxlength="4" placeholder="Own text or emoji" aria-label="${label} icon text" value="${img || PRIZE_PRESETS[cls].includes(v) ? '' : esc(v)}" oninput="if(this.value.trim()) setPrizeIcon('${cls}', this.value.trim(), true)">
        <label class="btn btn-secondary btn-sm pie-upload">${ICON.image} ${img ? 'Replace picture' : 'Upload picture'}<input type="file" accept="image/*" hidden onchange="onPrizeIconFile('${cls}', this)"></label>
      </div>
    </fieldset>`;
  }).join('');
}
function setPrizeIcon(cls, v, typing){
  PRIZE_DRAFT[cls] = v;
  if(typing){
    document.querySelectorAll(`.prize-icon-edit.${cls} .pie-chip`).forEach(b=>{ b.classList.toggle('active', b.textContent===v); b.setAttribute('aria-pressed', b.textContent===v) });
    const m = document.querySelector(`.prize-icon-edit.${cls} .prize-medal`); if(m){ m.className = 'prize-medal' + (/^\d$/.test(v)?'':' is-emoji'); m.textContent = v }
    return;
  }
  document.getElementById('prizeIconRows').innerHTML = prizeIconRows();
}
async function onPrizeIconFile(cls, input){
  const file = input.files[0]; input.value = '';
  if(!file) return;
  try{
    const res = await readImageFile(file, 192);
    PRIZE_DRAFT[cls] = res.src;
    document.getElementById('prizeIconRows').innerHTML = prizeIconRows();
  }catch(e){ toast('That file is not a picture we can read. Try a PNG or JPG.', true) }
}
function resetPrizeIcons(){ PRIZE_SLOTS.forEach(([cls, n])=>{ PRIZE_DRAFT[cls] = n }); document.getElementById('prizeIconRows').innerHTML = prizeIconRows() }
async function savePrizeIcons(){
  const out = {};
  PRIZE_SLOTS.forEach(([cls, n])=>{ const v = String(PRIZE_DRAFT[cls]||'').trim(); if(v && v!==n) out[cls] = v });
  const btn = document.querySelector('.modal-foot .btn-primary'); if(btn){ btn.disabled = true; btn.textContent = 'Saving…' }
  for(const cls of Object.keys(out)){
    if(isDataImg(out[cls]) && AUTH.sb && navigator.onLine!==false){
      try{ out[cls] = await uploadDataUrl(out[cls], 'brand') }catch(e){ console.warn('prize icon upload later', e) }
    }
  }
  saveSettings({prizeIcons: out});
  if(Object.values(out).some(isDataImg)) scheduleOffload(1500);
  closeModal(); rerender();
  toast('Prize icons updated');
}

function nextStepText(t){
  const n = (t.registrations||[]).length;
  if(n<2) return 'Add at least 2 players on the Players tab first.';
  if(t.format==='group_knockout') return `${n} players registered. Starting draws the groups and creates every fixture.`;
  if(t.format==='league') return `${n} players registered. Starting creates the full league schedule.`;
  return `${n} players registered. Starting draws the knockout bracket.`;
}

function switchTab(tabId){
  // Standings and Fixtures always open on "All"; a group picked inside the tab stays until you leave it.
  if(tabId!==currentTab && (tabId==='tab-standings' || tabId==='tab-fixtures') && selectedGroup && selectedGroup!=='*'){
    selectedGroup = '*';
    ['tab-standings','tab-fixtures'].forEach(id=>{ const el = document.getElementById(id); if(el){ el.innerHTML = ''; el.dataset.lazy = '1' } });
  }
  currentTab = tabId;
  document.querySelectorAll('#detailTabs .tab').forEach(x=>{ const on = x.dataset.tab===tabId; x.classList.toggle('active', on); x.setAttribute('aria-selected', on) });
  const lazy = document.getElementById(tabId);
  if(lazy && lazy.dataset.lazy){ const t = STORE.tournaments.find(x=>x.id===currentTournamentId); if(t) lazy.innerHTML = renderTabPanel(t, tabId); delete lazy.dataset.lazy }
  document.querySelectorAll('#main > .tab-panel').forEach(d=>d.classList.toggle('hidden', d.id!==tabId));
  revealActiveTab(true);
  const bar = document.querySelector('.tabs-sticky'), panelEl = document.getElementById(tabId);
  if(bar && panelEl){
    const stick = parseFloat(getComputedStyle(bar).top) || 0;
    const target = panelEl.getBoundingClientRect().top + window.scrollY - stick - bar.offsetHeight - 10;
    if(window.scrollY > target) window.scrollTo({top:Math.max(0, target)});
  }
  renderChrome();
  const panel = document.getElementById(tabId);
  if(panel && !reduceMotion()){ panel.classList.remove('tab-enter'); void panel.offsetWidth; panel.classList.add('tab-enter'); setTimeout(()=>panel.classList.remove('tab-enter'), 900) }
}

function drawTournament(t){
  const regs = t.registrations || [];
  if(t.format==='group_knockout'){
    const dist = distributePlayersToGroups(regs.length, t.groups||1);
    const shuffled = shuffle(regs);
    let idx = 0;
    t.groupData = dist.map((size,i)=>{ const g = {name:String.fromCharCode(65+i), players: shuffled.slice(idx, idx+size).map(r=>({playerId:r.playerId}))}; idx += size; return g });
    t.fixtures = buildFixtures(t);
    t.groupsDrawn = true;
    t.knockoutBracket = null; t.knockoutDrawn = false;
  } else if(t.format==='league'){
    t.groupData = [{name:'League', players: shuffle(regs).map(r=>({playerId:r.playerId}))}];
    t.fixtures = buildFixtures(t);
    t.groupsDrawn = true;
  } else {
    t.knockoutBracket = buildBracket(shuffle(regs).map(r=>({playerId:r.playerId, tag:''})));
    t.knockoutDrawn = true;
  }
  t.deadlineProcessed = false;
  t.champion = t.runnerUp = t.thirdPlace = t.fourthPlace = null;
}

function startTournament(tid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const {all, t} = getT(tid);
  if((t.registrations||[]).length < 2){ toast('Add at least 2 players before starting', true); currentTab='tab-registration'; rerender(); return }
  const alreadyDrawn = t.format==='single_elimination' ? t.knockoutDrawn : t.groupsDrawn;
  if(!alreadyDrawn) drawTournament(t);
  t.status = 'active';
  t.startedAt = new Date().toISOString();
  DB.set('tournaments', all);
  currentTab = t.format==='single_elimination' ? 'tab-knockout' : 'tab-standings';
  rerender();
  toast('Tournament started · Fixtures are ready');
}

async function redraw(tid){
  if(!isAdmin()) return;
  const t0 = STORE.tournaments.find(x=>x.id===tid);
  if((t0.registrations||[]).length < 2){ toast('Add at least 2 players first', true); return }
  const what = t0.format==='group_knockout' ? 'groups' : t0.format==='league' ? 'league schedule' : 'bracket';
  const ok = await confirmDialog(`Redraw ${what}`, `Redraw the ${what} with the current ${t0.registrations.length} players? Every score entered so far in this tournament will be cleared.`, 'Redraw');
  if(!ok) return;
  const {all, t} = getT(tid);
  drawTournament(t);
  if(t.status==='open' || t.status==='draft'){ t.status='active'; t.startedAt=new Date().toISOString() }
  DB.set('tournaments', all);
  rerender();
  toast('Draw complete');
}

async function deleteTournament(tid){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const ok = await confirmDialog('Delete tournament', `Delete "${t.name}" and all of its results? Player stats from it will be removed. This cannot be undone.`, 'Delete');
  if(!ok) return;
  DB.set('tournaments', DB.get('tournaments').filter(x=>x.id!==tid));
  navigate('tournaments');
  toast('Tournament deleted');
}

function renderTournamentOverview(t){
  const fx = t.fixtures||[];
  const played = fx.filter(f=>hasScore(f.score1)&&hasScore(f.score2)).length;
  const ko = (t.knockoutBracket||[]).flat().filter(m=>!m.isBye);
  const koDone = ko.filter(m=>m.winner).length;
  const tiles = [
    statTile('users','tint-blue','Participants', (t.registrations||[]).length, t.format==='group_knockout'?`${t.groups} groups · top ${t.qualifyPerGroup} qualify`:'players'),
    statTile('trophy','tint-gold','Format', `<span style="font-size:22px">${formatLabel(t.format)}</span>`, t.format==='league'?(t.leagueRounds===2?'Double round-robin':'Single round-robin'):koLabel(t.knockoutFormat))
  ];
  if(t.format!=='single_elimination') tiles.push(statTile('check','tint-green', t.format==='league'?'League matches':'Group matches', `${played}/${fx.length}`, 'played'));
  if(t.format!=='league') tiles.push(statTile('clock','tint-orange','Knockout', t.knockoutDrawn?`${koDone}/${ko.length}`:'—', t.knockoutDrawn?'ties decided':'not drawn yet'));
  return `<div class="grid grid-4">${tiles.join('')}</div>`;
}

function renderRegistrationTab(t, admin){
  const regs = t.registrations||[];
  const drawn = t.format==='single_elimination' ? t.knockoutDrawn : t.groupsDrawn;
  const drawnIds = new Set(t.format==='single_elimination' ? (t.knockoutBracket?.[0]||[]).flatMap(m=>[m.team1,m.team2]) : (t.groupData||[]).flatMap(g=>g.players.map(p=>p.playerId)));
  const outOfSync = drawn && (regs.some(r=>!drawnIds.has(r.playerId)) || [...drawnIds].filter(Boolean).some(id=>!regs.some(r=>r.playerId===id)));
  return `
    <section class="card" style="display:flex;flex-direction:column;gap:14px">
      <div class="flex-between">
        <div><h2 class="card-title">Registered Players</h2><div class="page-sub">${admin?'Choose who plays. Groups are split as evenly as possible.':'Players taking part in this tournament.'}</div></div>
        <div class="toolbar-actions">
          ${(t.registrations||[]).length ? `<button type="button" class="btn-icon-square" onclick="exportParticipantsSheet('${t.id}')" aria-label="Export players (image or PDF)" title="Export players (image or PDF)">${ICON_DL}</button>` : ''}
          ${admin && t.status!=='completed' ? `${drawn ? `<button type="button" class="btn btn-secondary" onclick="redraw('${t.id}')">Redraw</button>`:''}
          <button type="button" class="btn btn-primary" onclick="openCheckboxRegisterModal('${t.id}')">Manage players</button>` : ''}
        </div>
      </div>
      ${admin && outOfSync ? `<div class="locked-notice">The player list changed after the draw. Use Redraw to include the changes (this clears scores).</div>`:''}
      <div class="table-wrap">
        <table class="reg-table">
          <thead><tr><th style="width:40px">#</th><th>Player</th>${admin?'<th>Phone</th>':''}<th>Achievements</th><th>Registered</th>${admin && t.status!=='completed'?'<th></th>':''}</tr></thead>
          <tbody>
            ${regs.length===0 ? `<tr><td colspan="5" class="t-center text-muted" style="padding:40px">No players registered yet</td></tr>` :
              regs.map((r,i)=>{
                const p = STORE.players.find(x=>x.id===r.playerId) || {name:'Unknown player'};
                return `<tr>
                  <td class="rg-n" style="font-weight:700">${i+1}</td>
                  <td class="rg-p"><span class="who">${renderAvatar(p, 32)}<span class="rg-name">${esc(p.name)}</span></span></td>
                  ${admin?`<td class="rg-ph text-sm${STORE.phones[r.playerId]?'':' rg-empty'}" style="white-space:nowrap">${STORE.phones[r.playerId] ? telegramLink(STORE.phones[r.playerId]) : '<span class="text-muted">—</span>'}</td>`:''}
                  <td class="rg-a text-muted text-sm">${esc(p.achievements||'—')}</td>
                  <td class="rg-d text-muted text-sm${r.date?'':' rg-empty'}">${fmtDate(r.date)}</td>
                  ${admin && t.status!=='completed'?`<td class="rg-x t-right"><button type="button" class="btn btn-ghost btn-sm" onclick="unregisterPlayer('${t.id}','${r.playerId}')" style="color:var(--danger-ink)">Remove</button></td>`:''}
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

const PLAYERS_PER_PAGE = 15;
function exportParticipantsSheet(tid){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const regs = t.registrations || [];
  if(!regs.length){ toast('No players registered yet', true); return }
  const groupOf = {}; (t.groupData||[]).forEach(g=>g.players.forEach(p=>{ groupOf[p.playerId] = g.name }));
  const showGroups = t.format==='group_knockout' && Object.keys(groupOf).length;
  const list = regs.map((r,i)=>({n:i+1, p: STORE.players.find(x=>x.id===r.playerId) || {name:'Unknown player'}, g: groupOf[r.playerId]}));
  const parts = chunk(list, PLAYERS_PER_PAGE);
  const pages = parts.map((part, i)=>{
    const body = `<div class="xs-players" style="grid-template-columns:repeat(${Math.max(1,Math.min(5,part.length))}, 170px)">${part.map(x=>`
      <div class="xs-player">
        <span class="xs-player-n">${x.n}</span>
        ${renderAvatar(x.p, 56)}
        <b>${esc(x.p.name)}</b>
        ${showGroups && x.g ? `<span class="xs-player-g">Group ${esc(x.g)}</span>` : ''}
      </div>`).join('')}</div>`;
    return sheetHeader(t, t.name, `Participants · ${regs.length} player${regs.length===1?'':'s'}${parts.length>1?` · Page ${i+1} of ${parts.length}`:''}`) + body + sheetFoot(i+1, parts.length);
  });
  return renderSheets(pages, 5*170 + 4*14 + 56 + 40, `${slug(t.name)}_players`);
}

function openCheckboxRegisterModal(tid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
  const stats = calculateAllStats();
  const registered = new Set((t.registrations||[]).map(r=>r.playerId));
  openModal(`
    <div class="modal-head"><div class="modal-title">Manage Participants</div><button class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="flex-between mb-16">
        <div class="text-sm text-muted">Tick the players who will take part.</div>
        <div class="flex gap-8">
          <button class="btn btn-ghost btn-sm" onclick="toggleAllChecks('playerCheckList', true)">Select All</button>
          <button class="btn btn-ghost btn-sm" onclick="toggleAllChecks('playerCheckList', false)">Clear</button>
        </div>
      </div>
      <div class="player-check-list" id="playerCheckList">
        ${STORE.players.map(p=>{ const c = registered.has(p.id); return `
          <label class="player-check-item ${c?'selected':''}">
            <input type="checkbox" value="${p.id}" ${c?'checked':''} onchange="toggleCheckItem(this,'playerCheckList')">
            ${renderAvatar(p, 34)}
            <div class="info"><div class="name">${esc(p.name)}</div><div class="meta">${stats[p.id].matches} matches · ${stats[p.id].winPct}% win</div></div>
          </label>`}).join('')}
        ${STORE.players.length===0?'<div class="empty"><div class="empty-title">No players yet</div><div class="text-sm">Add players from the Players page first.</div></div>':''}
      </div>
      <div class="config-helper mt-16" id="playerCheckList-summary"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveCheckboxRegistration('${tid}')">Save Selection</button>
    </div>`);
  updateSelectionSummary('playerCheckList');
}

function saveCheckboxRegistration(tid){
  const checked = Array.from(document.querySelectorAll('#playerCheckList input[type="checkbox"]:checked')).map(cb=>cb.value);
  const {all, t} = getT(tid);
  const prev = {}; (t.registrations||[]).forEach(r=>{ prev[r.playerId] = r.date });
  t.registrations = checked.map(pid=>({playerId:pid, date: prev[pid] || new Date().toISOString()}));
  DB.set('tournaments', all);
  closeModal();
  rerender();
  toast(`Saved ${checked.length} player${checked.length!==1?'s':''}`);
}

async function unregisterPlayer(tid, playerId){
  const ok = await confirmDialog('Remove player', `Remove ${playerName(playerId)} from this tournament?`, 'Remove');
  if(!ok) return;
  const {all, t} = getT(tid);
  t.registrations = (t.registrations||[]).filter(r=>r.playerId!==playerId);
  DB.set('tournaments', all);
  rerender();
  toast('Player removed');
}

/* =========================
   STANDINGS
   ========================= */
let selectedGroup = null;
let fixtureQuery = '';

function groupSwitcher(t, onPick){
  if(!t.groupData || t.groupData.length<2) return '';
  const cur = currentGroup(t);
  return `<div class="segmented" role="group" aria-label="Choose group">
    <button type="button" class="seg ${cur==='*'?'active':''}" aria-pressed="${cur==='*'}" onclick="${onPick}('${t.id}','*')">All</button>
    ${t.groupData.map(g=>`<button type="button" class="seg ${g.name===cur?'active':''}" aria-pressed="${g.name===cur}" onclick="${onPick}('${t.id}','${esc(g.name)}')">Group ${esc(g.name)}</button>`).join('')}
  </div>`;
}
function currentGroup(t){
  if(!t.groupData?.length) return null;
  if(selectedGroup==='*' || t.groupData.some(g=>g.name===selectedGroup)) return selectedGroup;
  return '*';
}
function pickGroup(tid, name){
  selectedGroup = name;
  const t = STORE.tournaments.find(x=>x.id===tid);
  const admin = isAdmin(), can = t.status==='active'||t.status==='completed';
  for(const [id, html] of [['tab-standings', ()=>renderStandingsTab(t, admin, can)], ['tab-fixtures', ()=>renderAllFixturesTab(t, admin, can)]]){
    const el = document.getElementById(id); if(!el) continue;
    if(el.classList.contains('hidden')){ el.innerHTML = ''; el.dataset.lazy = '1' } else { el.innerHTML = html(); delete el.dataset.lazy }
  }
}

function standingsTable(t, g, highlightN){
  const rows = computeStandings(t, g);
  const hasNR = false; // NR is shown in exports only, not in the app
  const groupFx = (t.fixtures||[]).filter(f=>f.group===g.name);
  const finished = groupFx.length>0 && groupFx.every(f=>hasScore(f.score1)&&hasScore(f.score2));
  const isLeague = t.format==='league';
  const chip = isLeague ? (finished ? 'Champion' : 'Leader') : (finished ? 'Qualified' : 'Q');
  return `
    <div class="table-wrap">
      <table class="group-table" style="--s:${hasNR?8:7}">
        <thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">P</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th>${hasNR?'<th scope="col" class="nr" title="No result: not played by the deadline (0-0, no points)">NR</th>':''}<th scope="col" class="c-gf">GF</th><th scope="col" class="c-ga">GA</th><th scope="col">GD</th><th scope="col">Pts</th></tr></thead>
        <tbody>
          ${rows.map((row,i)=>{
            const p = STORE.players.find(x=>x.id===row.playerId) || {name:'Unknown player'};
            const gd = row.gf-row.ga, q = i<highlightN;
            return `<tr class="${q?'qualify':'out'} ${i===highlightN && i>0?'cut':''} tap-row" tabindex="0" role="button" aria-label="${esc(p.name)}: see matches" onclick="openPlayerMatches('${t.id}','${row.playerId}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openPlayerMatches('${t.id}','${row.playerId}')}">
              <td><span class="pos">${i+1}</span></td>
              <td><span class="who">${renderAvatar(p, 32)}<span style="min-width:0">${esc(p.name)}</span>${q?`<span class="q-chip ${finished?'done':''}" title="${isLeague?'Top of the table':'In a qualifying place'}">${chip}</span>`:''}</span></td>
              <td>${row.played}</td><td>${row.wins}</td><td>${row.draws}</td><td>${row.losses}</td>${hasNR?`<td class="nr">${row.nr||'<span class="dim">0</span>'}</td>`:''}
              <td class="c-gf">${row.gf}</td><td class="c-ga">${row.ga}</td><td class="c-gd ${gd>0?'pos-gd':gd<0?'neg-gd':''}" style="color:var(--text-2)">${gd>0?'+':''}${gd}</td>
              <td>${row.points}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderStandingsTab(t, admin, canEditScores){
  if(!t.groupsDrawn || !t.groupData?.length){
    return `<div class="card empty"><div class="empty-title">${t.format==='league'?'League not started':'Groups not drawn yet'}</div><div class="text-sm">${admin?'Press Start tournament above to draw and create fixtures.':'Standings appear once the organisers start the tournament.'}</div></div>`;
  }
  const isLeague = t.format==='league';
  const cur = currentGroup(t);
  const groups = isLeague ? t.groupData : (cur==='*' ? t.groupData : t.groupData.filter(g=>g.name===cur));
  const q = isLeague ? 1 : t.qualifyPerGroup;
  const content = groups.map(g=>`<div class="group-block">${groups.length>1 || !isLeague && t.groupData.length>1 ? `<div class="group-title">Group ${esc(g.name)}</div>`:''}${standingsTable(t, g, q)}</div>`).join('');
  return `
    <div class="tabs-wrap">
      <span class="page-sub">${t.groupDeadline?`Deadline ${fmtDateTime(t.groupDeadline)}`:'3 pts win · 1 pt draw'}${updatedAtOf(t) ? `<br><span class="upd-inline">${ICON_CLOCK_SM} Standings updated ${whenText(updatedAtOf(t))}</span>` : ''}</span>
      ${isLeague ? '' : groupSwitcher(t, 'pickGroup')}
      <button type="button" class="export-btn no-export" onclick="exportAsJPEG('standingsExport','${slug(t.name)}_standings')">${ICON_DL} ${isLeague || t.groupData.length<2 ? 'Export standings' : cur && cur!=='*' ? `Export Group ${esc(cur)} standings` : 'Export standings · one page per group'}</button>
    </div>
    <section id="standingsExport" class="export-container" aria-label="${isLeague?'League table':'Group standings'}">
      <div class="export-header" style="margin-bottom:12px"><div class="export-title">${esc(t.name)}</div><div class="export-subtitle">${isLeague?'League table':'Group standings'} · ${fmtDate(new Date())}</div></div>
      ${content}
      <div class="section-foot" style="margin-top:14px">
        <span class="legend"><span class="q-chip">Q</span>${isLeague?'Top of the table':`Top ${q} in each group go through to the knockout stage. The dashed line is the cut-off; "Qualified" appears once the group is finished.`} Ties are split by goal difference, then goals scored.${(t.fixtures||[]).some(f=>f.autoDraw) ? ' Matches not played by the deadline count as played, with no points.' : ''}</span><span class="legend no-export tap-hint">Tap a player to see their matches.</span>

      </div>
    </section>
    ${admin && canEditScores ? `<div class="config-helper">Enter scores on the <strong>Fixtures</strong> tab; the table updates instantly.</div>`:''}`;
}

function fixtureStage(t, f){ return t.format==='league' ? `MD ${f.matchday||'—'}` : `${esc(f.group)} · MD ${f.matchday||'—'}` }

function setFixtureQuery(tid, v){
  fixtureQuery = v;
  const t = STORE.tournaments.find(x=>x.id===tid);
  const body = document.getElementById('fixturesBody');
  if(body) body.innerHTML = fixtureRows(t, isAdmin(), t.status==='active');
}

function fixtureRows(t, admin, canEdit){
  const locked = groupLocked(t);
  const cur = t.format==='league' ? '*' : currentGroup(t);
  const q = fixtureQuery.trim().toLowerCase();
  const done = f => hasScore(f.score1) && hasScore(f.score2);
  // Played matches first (latest result on top), then pending matches in schedule order.
  const list = (t.fixtures||[]).map((f,i)=>({f,i})).filter(({f})=>(cur==='*' || f.group===cur) && (!q || playerName(f.team1).toLowerCase().includes(q) || playerName(f.team2).toLowerCase().includes(q)))
    .sort((a,b)=> (done(b.f)-done(a.f)) || (done(a.f) ? String(b.f.scoredAt||'').localeCompare(String(a.f.scoredAt||'')) : 0) || a.i-b.i).map(x=>x.f);
  if(!list.length){
    // Searching inside one group: offer the other groups when the player is there.
    const elsewhere = q && cur!=='*' ? (t.fixtures||[]).filter(f=>f.group!==cur && (playerName(f.team1).toLowerCase().includes(q) || playerName(f.team2).toLowerCase().includes(q))) : [];
    const groups = [...new Set(elsewhere.map(f=>f.group))];
    return `<tr><td colspan="${admin&&canEdit?7:6}" class="t-center text-muted" style="padding:32px">${elsewhere.length
      ? `No matches for “${esc(fixtureQuery.trim())}” in Group ${esc(cur)}.<br><button type="button" class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="pickGroup('${t.id}','${groups.length===1?esc(groups[0]):'*'}')">Show in ${groups.length===1?`Group ${esc(groups[0])}`:'all groups'} (${elsewhere.length})</button>`
      : 'No fixtures match.'}</td></tr>`;
  }
  return list.map(f=>{
    const done = hasScore(f.score1) && hasScore(f.score2);
    const p1 = STORE.players.find(p=>p.id===f.team1)||{name:'Unknown player'}, p2 = STORE.players.find(p=>p.id===f.team2)||{name:'Unknown player'};
    return `<tr>
      <td class="text-muted" style="white-space:nowrap">${fixtureStage(t,f)}</td>
      <td class="t-right"><span class="who right" style="${done&&f.score1>f.score2?'color:var(--primary-dark)':''}">${esc(p1.name)}${renderAvatar(p1,30)}</span></td>
      <td class="t-center"><span class="result-pill ${done?'':'pending'}">${done?`${f.score1} – ${f.score2}`:'vs'}</span></td>
      <td><span class="who" style="${done&&f.score2>f.score1?'color:var(--primary-dark)':''}">${renderAvatar(p2,30)}${esc(p2.name)}</span></td>
      <td class="t-right">${done ? `${f.autoDraw ? '<span class="badge badge-np" title="Not played by the deadline: recorded 0-0, no points">Not played · 0 pts</span>' : '<span class="badge badge-completed">Completed</span>'}` : `<span class="badge badge-pending">Pending</span>`}</td>
      ${admin && canEdit ? `<td class="t-right no-export">${locked && (t.format==='league' || f.group) ? '<span class="fx-lock" title="Group results are locked">🔒 Locked</span>' : `<span class="fx-acts"><button type="button" class="btn btn-ghost btn-sm" onclick="editFixtureScore('${t.id}','${f.id}')">${done?'Edit':'Enter score'}</button>${done ? `<button type="button" class="btn btn-ghost btn-sm fx-clear" onclick="clearFixtureResult('${t.id}','${f.id}')" aria-label="Clear result" title="Clear result">${ICON_CLEAR}</button>` : ''}</span>`}</td>`:''}
    </tr>`;
  }).join('');
}

/* Fixtures tab: after the deadline, say until when scores can still be edited, then that they are locked. */
function groupLockNotice(t){
  if(t.format==='single_elimination' || !t.groupDeadline || t.status==='draft' || t.status==='open') return '';
  const d = deadlineMsOf(t.groupDeadline); if(!Number.isFinite(d) || Date.now() < d) return '';
  const at = groupLockAt(t), stage = t.format==='league' ? 'League' : 'Group stage';
  return groupLocked(t)
    ? `<div class="lock-note locked">🔒 <span><b>${stage} results are final.</b> They were locked 30 minutes after the deadline and can't be changed. Matches not played were recorded as 0–0 with no points.</span></div>`
    : `<div class="lock-note">⏳ <span><b>Deadline passed.</b> Unplayed matches were recorded as 0–0 with no points. Organisers can still correct scores until <b>${fmtDateTime(at)}</b>, then results lock.</span></div>`;
}
function renderAllFixturesTab(t, admin, canEditScores){
  const fixtures = t.fixtures || [];
  if(fixtures.length===0) return `<div class="card empty"><div class="empty-title">No fixtures yet</div><div class="text-sm">Fixtures are created when the tournament starts.</div></div>`;
  const played = fixtures.filter(f=>hasScore(f.score1)&&hasScore(f.score2)).length;
  const canEdit = t.status==='active';
  return `
    ${t.format==='league' ? '' : `<div class="tabs-wrap"><span class="page-sub">Pick a group or view all fixtures</span>${groupSwitcher(t, 'pickGroup')}</div>`}
    ${groupLockNotice(t)}
    ${admin && !canEditScores ? `<div class="locked-notice">Start the tournament to enter scores.</div>`:''}
    <section id="fixturesExport" class="export-container" aria-label="Fixtures" style="display:flex;flex-direction:column;gap:14px">
      <div class="export-header"><div class="export-title">${esc(t.name)}</div><div class="export-subtitle">Fixtures &amp; results${t.groupDeadline?` · Deadline ${fmtDateTime(t.groupDeadline)}`:''}</div></div>
      <div class="flex-between no-export">
        <span class="page-sub">${played} of ${fixtures.length} matches played${(()=>{ const lr = lastResultOf(t); return lr ? `<br><span class="upd-inline">${ICON_CLOCK_SM} Last result ${whenText(lr.at)}: ${esc(playerName(lr.a))} ${lr.s} ${esc(playerName(lr.b))}</span>` : '' })()}</span>
        <label class="search-box" for="fx-search" style="width:240px;height:40px;border-radius:10px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4A5878" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="fx-search" type="search" placeholder="Search player…" aria-label="Search fixtures by player" value="${esc(fixtureQuery)}" oninput="setFixtureQuery('${t.id}', this.value)" style="font-size:13px">
        </label>
        <button type="button" class="export-btn" onclick="exportAsJPEG('fixturesExport','${slug(t.name)}_fixtures')">${ICON_DL} ${t.format==='league' ? 'Export fixtures' : currentGroup(t) && currentGroup(t)!=='*' ? `Export Group ${esc(currentGroup(t))} fixtures` : 'Export fixtures · each group separately'}</button>
      </div>
      <div class="table-wrap">
        <table class="fx-table">
          <thead><tr><th scope="col">Stage</th><th scope="col" class="t-right">Home</th><th scope="col" class="t-center">Result</th><th scope="col">Away</th><th scope="col" class="t-right">Status</th>${admin&&canEdit?'<th class="no-export"></th>':''}</tr></thead>
          <tbody id="fixturesBody">${fixtureRows(t, admin, canEdit)}</tbody>
        </table>
      </div>

    </section>`;
}

/* =========================
   TOURNAMENT STATS
   Built from every result entered: group/league fixtures plus each knockout leg, game and tie-breaker match.
   ========================= */
function tournamentMatches(t){
  const out = [];
  (t.fixtures||[]).forEach(f=>{ if(realResult(f)) out.push({a:f.team1, b:f.team2, ga:+f.score1, gb:+f.score2, stage: t.format==='league' ? `Matchday ${f.matchday}` : `Group ${f.group} · MD ${f.matchday}`}) });
  (t.knockoutBracket||[]).forEach(round=>round.forEach(m=>{
    if(!m || m.isBye || !m.team1 || !m.team2) return;
    const labels = koLegLabels(t.knockoutFormat);
    koLegs(t, m).forEach((l,i)=>{ if(hasScore(l[0]) && hasScore(l[1])) out.push({a:m.team1, b:m.team2, ga:+l[0], gb:+l[1], stage: `${m.round||'Knockout'}${labels[i]?' · '+labels[i]:''}`}) });
    if(m.tb && hasScore(m.tb.a) && hasScore(m.tb.b)) out.push({a:m.team1, b:m.team2, ga:+m.tb.a, gb:+m.tb.b, stage:`${m.round||'Knockout'} · Tie-breaker`});
  }));
  return out;
}
function tournamentStats(t){
  const matches = tournamentMatches(t);
  const S = {};
  const row = id => S[id] = S[id] || {id, p:0, w:0, d:0, l:0, gf:0, ga:0, cs:0, blank:0, form:[]};
  (t.registrations||[]).forEach(r=>row(r.playerId));
  matches.forEach(m=>{
    [[m.a,m.ga,m.gb],[m.b,m.gb,m.ga]].forEach(([id,f,a])=>{
      const r = row(id); r.p++; r.gf+=f; r.ga+=a;
      if(f>a) r.w++; else if(f<a) r.l++; else r.d++;
      if(a===0) r.cs++; if(f===0) r.blank++;
    });
  });
  const rows = Object.values(S).map(r=>({...r, gd:r.gf-r.ga, gpg:r.p ? r.gf/r.p : 0, cpg:r.p ? r.ga/r.p : 0, pts:r.w*3+r.d}));
  return {matches, rows};
}
function statPlayer(id){ return STORE.players.find(p=>p.id===id) || {name: playerName(id)} }
/* A ranked list with shared positions: equal values share the place. */
function statRank(rows, val, desc=true){
  const list = rows.slice().sort((a,b)=> desc ? val(b)-val(a) : val(a)-val(b));
  list.forEach((r,i)=>{ r._v = val(r); r._rk = i && r._v===list[i-1]._v ? list[i-1]._rk : i+1 });
  return list;
}
/* Stat icons: one consistent line set (24px grid, 1.9 stroke), shown white on a coloured tile. */
const SI = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const STAT_ICON = {
  goals: SI('<path d="M3 20V6l4-2h10l4 2v14"/><path d="M3 9h18M7 4v16M17 4v16M3 14h18"/><circle cx="12" cy="17" r="2.6" fill="#FFFFFF" stroke="none"/>'),
  shield: SI('<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12 2.3 2.3 4.2-4.6"/>'),
  plusminus: SI('<circle cx="12" cy="12" r="9"/><path d="M8.5 9h7M12 5.5v7M8.5 16h7"/>'),
  leak: SI('<path d="M3 20V6l4-2h10l4 2v14"/><path d="M3 9h18M7 4v16M17 4v16"/><path d="M12 10v7m-3-3 3 3 3-3"/>'),
  wins: SI('<path d="M7 4h10v4.5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 4M17 6h2.5a2.5 2.5 0 0 1-2.6 4M12 13.5V17M8.5 20.5h7M9.5 17h5"/>'),
  glove: SI('<path d="M7 21v-4.5L4.6 13a1.7 1.7 0 0 1 2.7-2l1.2 1.4V5.5a1.4 1.4 0 0 1 2.8 0V11m0-6.5a1.4 1.4 0 0 1 2.8 0V11m0-5a1.4 1.4 0 0 1 2.8 0V11m0-3a1.4 1.4 0 0 1 2.8 0v7.5c0 3-2 5.5-5 5.5H7z"/>'),
  pace: SI('<path d="M4.2 17a8.5 8.5 0 1 1 15.6 0"/><path d="m12 13 4-4.5"/><circle cx="12" cy="13" r="1.4" fill="#FFFFFF" stroke="none"/><path d="M7 7.5 8 8.5M12 5v1.5M17 7.5 16 8.5"/>'),
  draw: SI('<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M8 10h8M8 14h8"/>'),
  matches: SI('<circle cx="12" cy="12" r="9"/><path d="m12 7.2 3.2 2.3-1.2 3.8h-4l-1.2-3.8z"/><path d="M12 3v4.2M20.5 9.5l-5.3 0M16.8 19.5 14 13.3M7.2 19.5 10 13.3M3.5 9.5h5.3"/>'),
  ball: SI('<circle cx="12" cy="12" r="9"/><path d="m12 7.2 3.2 2.3-1.2 3.8h-4l-1.2-3.8z"/>'),
  avg: SI('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  bolt: SI('<path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12z"/>'),
  fire: SI('<path d="M12 22c4 0 7-2.8 7-7 0-3.3-2.2-5.6-3.6-7.2-.4 1.8-1.4 3-2.6 3.6.3-3.4-1.3-6.5-4.3-8.4.4 3.2-1.3 5.1-2.7 6.8A8.7 8.7 0 0 0 5 15c0 4.2 3 7 7 7z"/><path d="M12 22c-1.7 0-3-1.3-3-3.1 0-1.6 1.2-2.6 2.2-3.6.3 1 .9 1.6 1.6 1.9.1-1 .6-1.8 1.2-2.4.7 1 1 2 1 3.1 0 2.4-1.3 4.1-3 4.1z"/>'),
  h2hvs: SI('<circle cx="7" cy="8" r="2.8"/><circle cx="17" cy="8" r="2.8"/><path d="M2.5 19a4.5 4.5 0 0 1 9 0M12.5 19a4.5 4.5 0 0 1 9 0"/>'),
  unbeaten: SI('<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m12 8 1.3 2.6 2.9.4-2.1 2 .5 2.9-2.6-1.4-2.6 1.4.5-2.9-2.1-2 2.9-.4z" fill="#FFFFFF" stroke="none"/>')
};
const statIco = (k, c) => `<span class="si si-${c}">${STAT_ICON[k]||''}</span>`;
const STAT_DEFS = rows => {
  const maxP = Math.max(0, ...rows.map(r=>r.p));
  const min = Math.max(1, Math.ceil(maxP/2));
  const minNote = min>1 ? `Players with ${min}+ matches` : '';
  const dec1 = v => (Math.round(v*10)/10).toFixed(1), sgn = v => (v>0?'+':'') + v;
  return {min, minNote, list: [
    {icon:'goals', c:'green', title:'Most goals scored', val:r=>r.gf, unit:'goals'},
    {icon:'shield', c:'blue', title:'Fewest goals conceded', hint:minNote, val:r=>r.ga, desc:false, unit:'conceded', min},
    {icon:'plusminus', c:'gold', title:'Best goal difference', val:r=>r.gd, fmt:sgn, unit:'goal diff'},
    {icon:'wins', c:'purple', title:'Most wins', val:r=>r.w, unit:'wins'},
    {icon:'glove', c:'teal', title:'Most clean sheets', hint:'Matches without conceding', val:r=>r.cs, unit:'clean sheets'},
    {icon:'pace', c:'blue', title:'Goals per match', hint:minNote, val:r=>r.gpg, fmt:dec1, unit:'per match', min}
  ]};
};
/* Leaders and the next positions, everyone included when a position is shared. maxPos limits how far down the list goes. */
function statGroups(rows, d, maxPos){
  const pool = rows.filter(r=>r.p>0 && r.p>=(d.min||0));
  const list = statRank(pool, d.val, d.desc!==false);
  const groups = [];
  list.forEach(r=>{ const g = groups.at(-1); if(g && g.rk===r._rk) g.rows.push(r); else groups.push({rk:r._rk, v:r._v, rows:[r]}) });
  return groups.filter(g=>g.rk<=maxPos);
}
const namesOf = rows => rows.map(r=>esc(statPlayer(r.id).name));
function statCard(d, rows, opts={}){
  const fmt = d.fmt || (v=>v);
  const groups = statGroups(rows, d, opts.maxPos || 5);
  const head = `<div class="st-head">${statIco(d.icon, d.c)}<div><b>${d.title}</b>${d.hint?`<span>${d.hint}</span>`:''}</div></div>`;
  if(!groups.length) return `<div class="st-card">${head}<div class="st-empty">No results yet</div></div>`;
  const [lead, ...rest] = groups;
  const shared = lead.rows.length>1;
  return `<div class="st-card st-${d.c}">
    ${head}
    <div class="st-lead ${shared?'shared':''}">
      <div class="st-lead-top"><span class="st-lead-tag">${shared ? `1st · shared by ${lead.rows.length}` : 'Leader'}</span><div class="st-lead-val">${fmt(lead.v)}<small>${d.unit||''}</small></div></div>
      ${shared
        ? `<div class="st-lead-many">${lead.rows.map(r=>`<span class="st-pchip">${renderAvatar(statPlayer(r.id), 22)}${esc(statPlayer(r.id).name)}</span>`).join('')}</div>`
        : `<div class="st-lead-one">${renderAvatar(statPlayer(lead.rows[0].id), 40)}<b>${esc(statPlayer(lead.rows[0].id).name)}</b></div>`}
    </div>
    ${rest.length ? `<ol class="st-list">${rest.map(g=>`<li><span class="st-rk">${g.rk}${g.rows.length>1?'<small>=</small>':''}</span>
        <span class="st-nm ${g.rows.length>4?'many':''}">${(opts.maxNames && g.rows.length>opts.maxNames ? namesOf(g.rows.slice(0,opts.maxNames)).concat(`+${g.rows.length-opts.maxNames} more`) : namesOf(g.rows)).join(', ')}</span><b>${fmt(g.v)}</b></li>`).join('')}</ol>` : ''}
  </div>`;
}
/* One record match on a single compact line; winner in blue. */
function recRow(m){
  const pa = statPlayer(m.a), pb = statPlayer(m.b);
  return `<div class="st-rec-row"><span class="${m.ga>m.gb?'win':''}">${esc(pa.name)}</span><span class="result-pill">${m.ga} – ${m.gb}</span><span class="${m.gb>m.ga?'win':''}">${esc(pb.name)}</span><small>${esc(m.stage)}</small></div>`;
}
function matchLine(m, label){
  const pa = statPlayer(m.a), pb = statPlayer(m.b);
  return `<div class="st-match">${label?`<span class="st-match-label">${label}</span>`:''}
    <div class="st-match-row"><span class="who right ${m.ga>m.gb?'win':''}">${esc(pa.name)}${renderAvatar(pa, 28)}</span><span class="result-pill">${m.ga} – ${m.gb}</span><span class="who ${m.gb>m.ga?'win':''}">${renderAvatar(pb, 28)}${esc(pb.name)}</span></div>
    <span class="st-match-stage">${esc(m.stage)}</span></div>`;
}
function statsSummary(t){
  const {matches, rows} = tournamentStats(t);
  if(!matches.length) return null;
  const goals = matches.reduce((s,m)=>s+m.ga+m.gb,0), draws = matches.filter(m=>m.ga===m.gb).length;
  // Every match that shares a record is kept.
  const margin = m => Math.abs(m.ga-m.gb), total = m => m.ga+m.gb;
  const maxMargin = Math.max(...matches.map(margin)), maxGoals = Math.max(...matches.map(total));
  const biggestAll = matches.filter(m=>margin(m)===maxMargin).sort((x,y)=>total(y)-total(x));
  const highestAll = matches.filter(m=>total(m)===maxGoals).sort((x,y)=>margin(y)-margin(x));
  const biggest = biggestAll[0], highest = highestAll[0];
  const defs = STAT_DEFS(rows);
  const unbeaten = rows.filter(r=>r.p>=defs.min && r.l===0).sort((a,b)=>b.p-a.p || b.w-a.w);
  return {matches, rows, goals, draws, biggest, highest, biggestAll, highestAll, maxMargin, maxGoals, defs, unbeaten};
}
function statNum(icon, c, label, value, sub){ return `<div class="st-num">${statIco(icon, c)}<div><span>${label}</span><b>${value}</b>${sub?`<small>${sub}</small>`:''}</div></div>` }
function renderStatsTab(t){
  const S = statsSummary(t);
  if(!S) return `<div class="card empty"><div class="empty-title">No stats yet</div><div class="text-sm">Stats appear here as soon as the first result is entered.</div></div>`;
  const {matches, rows, goals, draws, biggestAll, highestAll, maxMargin, maxGoals, defs, unbeaten} = S;
  const shareNote = n => n>1 ? ` · shared by ${n} matches` : '';
  return `
  <section class="st-wrap" aria-label="Tournament stats">
    <div class="h2h-top"><span class="page-sub">Built from every result entered in this tournament</span><button type="button" class="export-btn" onclick="exportStatsSheet('${t.id}')">${ICON_DL} Export stats</button></div>
    <div class="st-nums">
      ${statNum('matches','blue','Matches played', matches.length)}
      ${statNum('goals','green','Goals scored', goals)}
      ${statNum('avg','purple','Goals per match', (Math.round(goals/matches.length*10)/10).toFixed(1))}
      ${statNum('draw','slate','Draws', draws, `${Math.round(draws/matches.length*100)}% of matches`)}
    </div>
    <div class="st-grid st-grid-3">${defs.list.map(d=>statCard(d, rows, {maxPos:5, maxNames:6})).join('')}</div>
    <div class="st-grid st-grid-2">
      <div class="st-card"><div class="st-head">${statIco('bolt','gold')}<div><b>Match records</b></div></div>
        <div class="st-rec-group"><span class="st-match-label">Biggest win · ${maxMargin} goal margin${shareNote(biggestAll.length)}</span><div class="st-rec-list">${biggestAll.map(recRow).join('')}</div></div>
        <div class="st-rec-group"><span class="st-match-label">Highest-scoring match · ${maxGoals} goals${shareNote(highestAll.length)}</span><div class="st-rec-list">${highestAll.map(recRow).join('')}</div></div>
      </div>
      <div class="st-card"><div class="st-head">${statIco('unbeaten','green')}<div><b>Still unbeaten</b><span>${defs.minNote || 'No defeats so far'}</span></div></div>
        ${unbeaten.length ? `<ol class="st-list">${unbeaten.map(r=>`<li><span class="st-avs">${renderAvatar(statPlayer(r.id), 22)}</span><span class="st-nm">${esc(statPlayer(r.id).name)}</span><span class="st-wdl">${r.w}W ${r.d}D</span></li>`).join('')}</ol>` : '<div class="st-empty">Everyone has lost at least once.</div>'}
      </div>
    </div>
  </section>`;
}
/* Stats export: one 5:4 page (1500 × 1200). */
function exportStatsSheet(tid){
  const t = STORE.tournaments.find(x=>x.id===tid); if(!t) return;
  const S = statsSummary(t); if(!S){ toast('No stats to export yet', true); return }
  const {matches, rows, goals, draws, biggestAll, highestAll, maxMargin, maxGoals, defs, unbeaten} = S;
  // Record tiles: score in a centred column so every row lines up.
  const recs = (list, label) => `<div class="x169-rec xrec"><span>${label}${list.length>1?` · ${list.length} matches`:''}</span>${list.slice(0,2).map(m=>`<div class="xrec-row"><b class="a ${m.ga>m.gb?'w':''}">${esc(statPlayer(m.a).name)}</b><i>${m.ga}–${m.gb}</i><b class="b ${m.gb>m.ga?'w':''}">${esc(statPlayer(m.b).name)}</b></div>`).join('')}<small>${list.length>2 ? `+${list.length-2} more` : list.length===1 ? esc(list[0].stage) : '&nbsp;'}</small></div>`;
  const rec = (m, label) => `<div class="x169-rec"><span>${label}</span><b>${esc(statPlayer(m.a).name)} <i>${m.ga}–${m.gb}</i> ${esc(statPlayer(m.b).name)}</b><small>${esc(m.stage)}</small></div>`;
  const page = `<div class="x54 x54-stats">
    ${sheetHeader(t, t.name, `Tournament stats · ${matches.length} matches · ${fmtDate(new Date())}`)}
    <div class="x169-strip">
      ${statNum('matches','blue','Matches played', matches.length)}
      ${statNum('goals','green','Goals scored', goals)}
      ${statNum('avg','purple','Goals per match', (Math.round(goals/matches.length*10)/10).toFixed(1))}
      ${statNum('draw','slate','Draws', draws, `${Math.round(draws/matches.length*100)}% of matches`)}
    </div>
    <div class="x169-strip">
      ${recs(biggestAll, `Biggest win · ${maxMargin} goal margin`)}
      ${recs(highestAll, `Highest-scoring · ${maxGoals} goals`)}
      <div class="x169-rec xrec"><span>Still unbeaten</span><b class="xrec-unb">${unbeaten.length ? unbeaten.map(r=>esc(statPlayer(r.id).name)).join(', ') : 'Nobody'}</b><small>&nbsp;</small></div>
    </div>
    <div class="x169-grid">${defs.list.map(d=>statCard(d, rows, {maxPos:4, maxNames:10})).join('')}</div>
    ${sheetFoot()}
  </div>`;
  return renderSheets([page], X54.w, `${slug(t.name)}_stats`);
}

function editFixtureScore(tid, fid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
  if(groupLocked(t)){ toast('Group stage results are locked (30 minutes after the deadline)', true); return }
  const f = (t.fixtures||[]).find(x=>x.id===fid);
  if(!f) return;
  const p1 = STORE.players.find(x=>x.id===f.team1)||{name:'Unknown player'}, p2 = STORE.players.find(x=>x.id===f.team2)||{name:'Unknown player'};
  openModal(`
    <div class="modal-head"><div class="modal-title">${fixtureStage(t,f)}</div><button class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="score-entry">
        <div class="score-side">${renderAvatar(p1, 48)}<div class="score-name">${esc(p1.name)}</div><input class="form-input score-input" type="number" inputmode="numeric" id="fs_score1" value="${hasScore(f.score1)?f.score1:''}" min="0" max="99" aria-label="${esc(p1.name)} goals"></div>
        <div class="score-vs">VS</div>
        <div class="score-side">${renderAvatar(p2, 48)}<div class="score-name">${esc(p2.name)}</div><input class="form-input score-input" type="number" inputmode="numeric" id="fs_score2" value="${hasScore(f.score2)?f.score2:''}" min="0" max="99" aria-label="${esc(p2.name)} goals"></div>
      </div>
    </div>
    <div class="modal-foot">
      ${hasScore(f.score1) ? `<button class="btn btn-ghost" style="margin-right:auto;color:var(--danger)" onclick="clearFixtureResult('${tid}','${fid}')">Clear result</button>`:''}
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveFixtureScore('${tid}','${fid}')">Save</button>
    </div>`);
  enterSaves(()=>saveFixtureScore(tid, fid));
  setTimeout(()=>{ const a = document.getElementById('fs_score1'); a?.focus(); a?.select() }, 50);
}
/* Pressing Enter in a modal's inputs runs its Save action. */
function enterSaves(fn){
  const m = document.querySelector('#modal .modal'); if(!m) return;
  m.addEventListener('keydown', e=>{
    if(e.key!=='Enter' || e.isComposing || e.shiftKey) return;
    if(!(e.target instanceof HTMLInputElement)) return;
    e.preventDefault(); fn();
  });
}
const ICON_CLEAR = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
async function clearFixtureResult(tid, fid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid), f = t?.fixtures?.find(x=>x.id===fid); if(!f) return;
  const ok = await confirmDialog('Clear result', `Clear the ${f.score1}–${f.score2} result of ${playerName(f.team1)} vs ${playerName(f.team2)}? The match goes back to pending and the standings update.`, 'Clear result');
  if(!ok) return;
  saveFixtureScore(tid, fid, true);
}

function readScore(id){ const v = document.getElementById(id)?.value; if(v===undefined || v==='') return null; const n = parseInt(v,10); return Number.isFinite(n) && n>=0 ? n : NaN }

function saveFixtureScore(tid, fid, clear=false){
  const {all, t} = getT(tid);
  if(groupLocked(t)){ closeModal(); toast('Group stage results are locked (30 minutes after the deadline)', true); rerender(); return }
  const f = t.fixtures.find(x=>x.id===fid);
  delete f.autoDraw;   // an organiser's score replaces an automatic 0-0
  if(clear){ f.score1 = null; f.score2 = null; delete f.scoredAt }
  else {
    const s1 = readScore('fs_score1'), s2 = readScore('fs_score2');
    if(s1===null || s2===null || Number.isNaN(s1) || Number.isNaN(s2)){ toast('Enter both scores as whole numbers (0 or more)', true); return }
    if(f.score1!==s1 || f.score2!==s2 || !f.scoredAt) f.scoredAt = new Date().toISOString();
    f.score1 = s1; f.score2 = s2;
  }
  t.resultsAt = new Date().toISOString();
  DB.set('tournaments', all);
  closeModal();
  rerender();
  toast(clear ? 'Result cleared' : 'Score saved · Standings updated');
}

function processDeadline(tid){
  if(!isAdmin()) return;
  const t0 = STORE.tournaments.find(x=>x.id===tid);
  if(!t0 || t0.status!=='active' || !t0.groupDeadline || t0.deadlineProcessed || !(t0.fixtures||[]).length) return;
  if(new Date(t0.groupDeadline) >= new Date()) return;
  const {all, t} = getT(tid);
  let n = 0;
  const now = new Date().toISOString();
  t.fixtures.forEach(f=>{ if((t.format==='league' || f.group) && (!hasScore(f.score1) || !hasScore(f.score2))){ f.score1 = 0; f.score2 = 0; f.autoDraw = true; f.scoredAt = now; n++ } });
  t.deadlineProcessed = true;
  if(n) t.resultsAt = now;
  DB.set('tournaments', all);
  if(n) toast(`Deadline passed · ${n} unplayed match${n>1?'es':''} recorded as 0-0 (no points)`);
}

/* =========================
   KNOCKOUT
   ========================= */
async function drawKnockout(tid){
  if(!isAdmin()) return;
  const t0 = STORE.tournaments.find(x=>x.id===tid);
  const left = (t0.fixtures||[]).filter(f=>!hasScore(f.score1)||!hasScore(f.score2)).length;
  if(left){
    const ok = await confirmDialog('Draw knockout bracket', `${left} group match${left>1?'es are':' is'} still unplayed. Draw the bracket from the current standings anyway?`, 'Draw bracket');
    if(!ok) return;
  } else if(t0.knockoutDrawn){
    const ok = await confirmDialog('Redraw knockout bracket', 'Redraw the bracket from the final group standings? Knockout scores entered so far will be cleared.', 'Redraw bracket');
    if(!ok) return;
  }
  const {all, t} = getT(tid);
  let q = getQualifiers(t);
  if(q.length < 2){ toast('At least 2 qualifiers are needed for a bracket', true); return }
  if(t.seeding==='random') q = shuffle(q);
  else q.sort((a,b)=> a.pos-b.pos || b.points-a.points || (b.gf-b.ga)-(a.gf-a.ga) || b.gf-a.gf);
  t.knockoutBracket = buildBracket(q.map(x=>({playerId:x.playerId, tag:`${x.group}${x.pos}`, group:x.group, pos:x.pos})));
  t.knockoutDrawn = true;
  DB.set('tournaments', all);
  rerender();
  const groupOf = {}; q.forEach(x=>groupOf[x.playerId]=x.group);
  const clashes = t.knockoutBracket[0].filter(m=>m.team1 && m.team2 && groupOf[m.team1]===groupOf[m.team2]).length;
  toast(clashes ? `Bracket drawn · ${clashes} same-group tie${clashes>1?'s':''} could not be avoided with ${t.groupData.length} group${t.groupData.length>1?'s':''}` : 'Knockout bracket drawn · no first-round tie pairs players from the same group', !!clashes);
}

function renderKnockoutTab(t, admin, canEditScores){
  if(t.format==='group_knockout' && !t.knockoutDrawn){
    if(!t.groupsDrawn) return `<div class="card empty"><div class="empty-title">Group stage first</div><div class="text-sm">${admin?'Start the tournament to draw groups. The bracket is drawn after the group stage.':'The bracket appears after the group stage.'}</div></div>`;
    const left = (t.fixtures||[]).filter(f=>!hasScore(f.score1)||!hasScore(f.score2)).length;
    return `<div class="card empty">
      <div class="trophy-disc" style="margin:0 auto 14px;width:80px;height:80px">${ICON.cup}</div>
      <div class="empty-title">Knockout bracket not drawn</div>
      <div class="text-sm">${left ? `${left} group match${left>1?'es':''} still to play.` : 'Group stage complete.'} Top ${t.qualifyPerGroup} from each group go through${admin?'':'; the organisers draw the bracket next'}.</div>
      ${admin && canEditScores ? `<button type="button" class="btn btn-primary mt-16" onclick="drawKnockout('${t.id}')">Draw knockout bracket</button>`:''}
    </div>`;
  }
  if(t.format==='single_elimination' && !t.knockoutDrawn){
    return `<div class="card empty"><div class="empty-title">Bracket not drawn</div><div class="text-sm">${admin?'Press Start tournament above to draw the bracket.':'The bracket appears once the tournament starts.'}</div></div>`;
  }
  const rounds = t.knockoutBracket || [];
  const final = rounds.at(-1)?.[0];
  const nameFn = id => playerName(id);
  return `
    <section id="bracketExport" class="export-container" aria-label="Knockout bracket" style="display:flex;flex-direction:column;gap:16px">
      <div class="export-header"><div class="export-title">${esc(t.name)} · Knockout</div><div class="export-subtitle">${koLabel(t.knockoutFormat)}</div></div>
      <div class="flex-between no-export">
        <span class="page-sub">${koLabel(t.knockoutFormat)}${t.format==='group_knockout'?` · ${t.seeding==='random'?'Random draw':'Seeded by group finish'} · no first-round tie pairs players from the same group`:''}</span>
        <div class="toolbar-actions">
          ${admin && t.format==='group_knockout' && t.status==='active' ? `<button type="button" class="btn btn-secondary" onclick="drawKnockout('${t.id}')">Redraw bracket</button>`:''}
          <button type="button" class="btn btn-primary" onclick="exportAsJPEG('bracketExport','${slug(t.name)}_bracket')">${ICON_DL} Export full bracket</button>
        </div>
      </div>
      ${bracketHTML(t, admin)}
      <div class="round-export-section no-export">
        <div class="round-export-title">Export a single round</div>
        <div class="action-buttons">
          ${rounds.map((round,ri)=>`<button type="button" class="btn-soft" onclick="exportRoundAsJPEG('${t.id}',${ri})">${esc(round[0]?.round||'Round '+(ri+1))}</button>`).join('')}
        </div>
      </div>
    </section>`;
}

function koMatchBody(t, m, nameFn){
  const fmt = t.knockoutFormat, r = koResult(t, m), labels = r.legacy ? [] : koLegLabels(fmt), legs = koLegs(t, m);
  const multi = labels.length>0;
  const cols = `minmax(0,1fr) ${labels.map(()=>'22px').join(' ')} 34px`;
  const name = id => id ? esc(nameFn(id)) : (m.isBye ? 'Bye' : 'TBD');
  const row = side => {
    const id = side===0 ? m.team1 : m.team2;
    const cells = multi ? legs.map(l=>{
      const v = l[side], o = l[1-side];
      return `<span class="km-cell ${hasScore(v)&&hasScore(o)&&v>o?'won':''}">${hasScore(v)?v:'·'}</span>`;
    }).join('') : '';
    const tot = m.isBye ? '' : (r.total ? r.total[side] : '–');
    return `<div class="km-row bracket-team ${m.winner && m.winner===id?'winner':''} ${!id?'tbd':''}" style="grid-template-columns:${multi?cols:'minmax(0,1fr) 34px'}"><span class="km-name">${name(id)}</span>${cells}<span class="km-total">${tot}</span></div>`;
  };
  const head = multi && !m.isBye ? `<div class="km-row km-head" style="grid-template-columns:${cols}"><span></span>${labels.map(l=>`<span>${l}</span>`).join('')}<span>${koTotalLabel(fmt)}</span></div>` : '';
  const pp = m.pens ? [m.pens.a, m.pens.b] : null;
  const tbv = m.tb && hasScore(m.tb.a) && hasScore(m.tb.b) ? [m.tb.a, m.tb.b] : null;
  let note = '';
  if(r.byTb && tbv) note = `<div class="km-note">${name(r.winner===0?m.team1:m.team2)} won the tie-breaker ${Math.max(...tbv)}–${Math.min(...tbv)}</div>`;
  else if(r.byPens && pp) note = `<div class="km-note">${tbv ? `Tie-breaker ${tbv[0]}–${tbv[1]} · ` : ''}${name(r.winner===0?m.team1:m.team2)} won ${Math.max(...pp)}–${Math.min(...pp)} on penalties</div>`;
  return head + row(0) + row(1) + note;
}

function koFieldLabels(fmt){ return fmt==='bo3' ? ['Game 1','Game 2','Game 3'] : fmt==='2leg' ? ['Leg 1','Leg 2'] : ['Score'] }

function openKnockoutMatchModal(tid, roundIdx, matchId){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
  const m = t.knockoutBracket[roundIdx].find(x=>x.id===matchId);
  const fmt = t.knockoutFormat, labels = koFieldLabels(fmt), legs = koLegs(t, m);
  const p = [m.team1, m.team2].map(id=>STORE.players.find(x=>x.id===id) || {name:'Unknown player'});
  const v = x => hasScore(x) ? x : '';
  const cols = `minmax(0,1fr) repeat(${labels.length}, minmax(42px,62px))${labels.length>1?' minmax(48px,70px)':''}`;
  const totalHead = labels.length>1 ? `<span class="ko-th ko-total-col">${fmt==='bo3'?'Series':'Aggregate'}</span>` : '';
  openModal(`
    <div class="modal-head"><div class="modal-title">${esc(m.round)} · ${esc(m.label||'')}</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:16px">
      <div class="page-sub">${fmt==='bo3'?'Best of 3: enter the goals in each game. First to win 2 games goes through; game 3 is only needed at 1–1.':fmt==='2leg'?'Two legs: enter the goals in each leg. The aggregate score decides who goes through.':'Single match: enter the final score.'} ${koTieMatch(t) ? 'If the aggregate is level, enter the tie-breaker match; if that is level too, the penalty shoot-out.' : 'If it ends level, enter the penalty shoot-out.'}</div>
      <div class="ko-entry-wrap">
        <div class="ko-entry" style="grid-template-columns:${cols}">
          <span></span>${labels.map(l=>`<span class="ko-th">${l}</span>`).join('')}${totalHead}
          ${[0,1].map(side=>`
            <span class="ko-player">${renderAvatar(p[side],30)}<span>${esc(p[side].name)}</span></span>
            ${legs.map((l,i)=>`<input class="form-input ko-input" type="number" inputmode="numeric" min="0" max="99" id="km_${i}_${side}" value="${v(l[side])}" aria-label="${esc(p[side].name)} ${labels[i]}" oninput="koPreview('${tid}',${roundIdx},'${matchId}')">`).join('')}
            ${labels.length>1?`<span class="ko-total" id="km_tot_${side}">–</span>`:''}
          `).join('')}
        </div>
      </div>
      ${koTieMatch(t) ? `<div class="ko-pens hidden" id="km_tb">
        <div class="form-label" style="margin:0">Tie-breaker match</div>
        <div class="ko-pens-row">
          <label class="ko-pen">${esc(p[0].name)}<input class="form-input ko-input" type="number" inputmode="numeric" min="0" max="99" id="km_tb_0" value="${v(m.tb?.a)}" oninput="koPreview('${tid}',${roundIdx},'${matchId}')"></label>
          <span class="score-vs" style="margin:0">–</span>
          <label class="ko-pen">${esc(p[1].name)}<input class="form-input ko-input" type="number" inputmode="numeric" min="0" max="99" id="km_tb_1" value="${v(m.tb?.b)}" oninput="koPreview('${tid}',${roundIdx},'${matchId}')"></label>
        </div>
      </div>` : ''}
      <div class="ko-pens hidden" id="km_pens">
        <div class="form-label" style="margin:0">Penalty shoot-out</div>
        <div class="ko-pens-row">
          <label class="ko-pen">${esc(p[0].name)}<input class="form-input ko-input" type="number" inputmode="numeric" min="0" max="99" id="km_p_0" value="${v(m.pens?.a)}" oninput="koPreview('${tid}',${roundIdx},'${matchId}')"></label>
          <span class="score-vs" style="margin:0">–</span>
          <label class="ko-pen">${esc(p[1].name)}<input class="form-input ko-input" type="number" inputmode="numeric" min="0" max="99" id="km_p_1" value="${v(m.pens?.b)}" oninput="koPreview('${tid}',${roundIdx},'${matchId}')"></label>
        </div>
      </div>
      <div class="ko-summary" id="km_sum" role="status"></div>
    </div>
    <div class="modal-foot">
      ${m.winner || legs.some(l=>hasScore(l[0])||hasScore(l[1])) ? `<button type="button" class="btn btn-ghost" style="margin-right:auto;color:var(--danger-ink)" onclick="clearKnockoutResult('${tid}',${roundIdx},'${matchId}')">Clear result</button>`:''}
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveKnockoutMatch('${tid}',${roundIdx},'${matchId}')">Save result</button>
    </div>`);
  koPreview(tid, roundIdx, matchId);
  enterSaves(()=>saveKnockoutMatch(tid, roundIdx, matchId));
}

function koReadInputs(fmt){
  const n = koLegCount(fmt), legs = [];
  const rd = id => { const el = document.getElementById(id); return el && el.disabled ? null : readScore(id) };
  for(let i=0;i<n;i++) legs.push([rd(`km_${i}_0`), rd(`km_${i}_1`)]);
  const pens = document.getElementById('km_pens').classList.contains('hidden') ? null : [readScore('km_p_0'), readScore('km_p_1')];
  const tbBox = document.getElementById('km_tb');
  const tb = tbBox ? (tbBox.classList.contains('hidden') ? [null, null] : [readScore('km_tb_0'), readScore('km_tb_1')]) : undefined;
  return {legs, pens, tb};
}

function koPreview(tid, roundIdx, matchId){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const m = t.knockoutBracket[roundIdx].find(x=>x.id===matchId);
  const fmt = t.knockoutFormat;
  const pensBox = document.getElementById('km_pens');
  const n = koLegCount(fmt), legs = [];
  for(let i=0;i<n;i++) legs.push([readScore(`km_${i}_0`), readScore(`km_${i}_1`)]);
  const pens = [readScore('km_p_0'), readScore('km_p_1')];
  const tbBox = document.getElementById('km_tb');
  const tbv = tbBox ? [readScore('km_tb_0'), readScore('km_tb_1')].map(x=>Number.isNaN(x)?null:x) : undefined;
  const r = evalKO(fmt, legs.map(l=>l.map(x=>Number.isNaN(x)?null:x)), pens, tbv);
  if(tbBox) tbBox.classList.toggle('hidden', !r.needTb);
  pensBox.classList.toggle('hidden', !r.level || (r.needTb && !r.tbLevel));
  [0,1].forEach(side=>{ const el = document.getElementById(`km_tot_${side}`); if(el) el.textContent = r.total ? r.total[side] : '–' });
  if(fmt==='bo3'){
    const w=[0,0]; legs.slice(0,2).forEach(l=>{ if(hasScore(l[0])&&hasScore(l[1])&&!Number.isNaN(l[0])&&!Number.isNaN(l[1])){ if(l[0]>l[1]) w[0]++; else if(l[1]>l[0]) w[1]++ } });
    const notNeeded = w[0]===2 || w[1]===2;
    [0,1].forEach(side=>{ const el = document.getElementById(`km_2_${side}`); if(el){ el.disabled = notNeeded; el.placeholder = notNeeded ? '—' : '' } });
  }
  const nm = i => playerName(i===0 ? m.team1 : m.team2);
  const tot = r.total ? `${r.total[0]}–${r.total[1]}` : '';
  let msg, cls = '';
  if(legs.some(l=>Number.isNaN(l[0])||Number.isNaN(l[1]))) { msg = 'Scores must be whole numbers, 0 or more.'; cls = 'warn' }
  else if(legs.some(l=>hasScore(l[0])!==hasScore(l[1]))) { msg = 'Enter both scores for each '+(fmt==='bo3'?'game':fmt==='2leg'?'leg':'match')+' you fill in.'; cls = 'warn' }
  else if(!r.played) msg = 'Enter the scores as they come in. You can save part-way through and finish later.';
  else if(!r.complete) msg = fmt==='bo3' ? `Series ${tot} so far. Enter the next game when it is played.` : `Leg 1 played (${tot}). Enter leg 2 to settle the tie.`;
  else if(r.winner!==null){
    const how = fmt==='bo3' ? `wins the series ${r.total[r.winner]}–${r.total[1-r.winner]}` : fmt==='2leg' ? `wins ${r.total[r.winner]}–${r.total[1-r.winner]} on aggregate` : `wins ${r.total[r.winner]}–${r.total[1-r.winner]}`;
    msg = `<b>${esc(nm(r.winner))}</b> ${r.byTb ? `wins the tie-breaker match ${tbv[r.winner]}–${tbv[1-r.winner]} after ${tot} on aggregate` : r.byPens ? `goes through on penalties (${pens[r.winner]}–${pens[1-r.winner]}) after ${tot}${r.needTb ? ` and a ${tbv[0]}–${tbv[1]} tie-breaker` : ''}` : how}.`; cls = 'ok';
  } else if(r.needTb && !r.tbLevel){ msg = `Level at ${tot} on aggregate. Play the tie-breaker match and enter its score.`; cls = 'warn' }
  else { msg = `Level at ${tot}${r.tbLevel ? ' and in the tie-breaker' : ''}. Enter the penalty shoot-out to decide who goes through.`; cls = 'warn' }
  const sum = document.getElementById('km_sum');
  sum.className = 'ko-summary ' + cls;
  sum.innerHTML = msg;
}

async function clearKnockoutResult(tid, roundIdx, matchId){
  const t = STORE.tournaments.find(x=>x.id===tid), m = t?.knockoutBracket?.[roundIdx]?.find(x=>x.id===matchId); if(!m) return;
  const later = m.winner && t.knockoutBracket.slice(roundIdx+1).some(r=>r.some(x=>x.team1===m.winner || x.team2===m.winner));
  const ok = await confirmDialog('Clear result', `Clear the result of ${playerName(m.team1)} vs ${playerName(m.team2)}?${later ? ` ${playerName(m.winner)} will also be removed from the next round, along with any result there.` : ''}`, 'Clear result');
  if(!ok){ openKnockoutMatchModal(tid, roundIdx, matchId); return }
  saveKnockoutMatch(tid, roundIdx, matchId, true);
}
function saveKnockoutMatch(tid, roundIdx, matchId, clear=false){
  const t0 = STORE.tournaments.find(x=>x.id===tid);
  const fmt = t0.knockoutFormat;
  let legs = [], pens = null, tb;
  if(!clear){
    ({legs, pens, tb} = koReadInputs(fmt));
    if(legs.some(l=>Number.isNaN(l[0])||Number.isNaN(l[1])) || (pens && pens.some(x=>Number.isNaN(x))) || (tb && tb.some(x=>Number.isNaN(x)))){ toast('Scores must be whole numbers (0 or more)', true); return }
    if(tb && hasScore(tb[0])!==hasScore(tb[1])){ toast('Enter both scores for the tie-breaker match', true); return }
    const half = legs.findIndex(l=>hasScore(l[0])!==hasScore(l[1]));
    if(half>=0){ toast(`Enter both scores for ${koFieldLabels(fmt)[half]}`, true); return }
  }
  const r = clear ? {winner:null, played:0} : evalKO(fmt, legs, pens, tb);
  if(!clear && r.level && !r.byPens && !r.byTb){
    toast(r.needTb && !r.tbLevel ? 'Level on aggregate. Enter the tie-breaker match score before saving.' : pens && hasScore(pens[0]) && hasScore(pens[1]) ? 'A penalty shoot-out cannot end level' : 'Scores are level. Enter the penalty shoot-out before saving.', true);
    return;
  }
  const {all, t} = getT(tid);
  const m = t.knockoutBracket[roundIdx].find(x=>x.id===matchId);
  const L = i => legs[i] || [null,null];
  if(fmt==='bo3'){
    m.games = clear ? null : legs.map(l=>({a:l[0], b:l[1]}));
    m.score1 = r.total ? r.total[0] : null; m.score2 = r.total ? r.total[1] : null;
  } else {
    m.score1 = L(0)[0]; m.score2 = L(0)[1];
    if(fmt==='2leg'){ m.leg2Score1 = L(1)[0]; m.leg2Score2 = L(1)[1] }
  }
  m.pens = !clear && r.byPens ? {a:pens[0], b:pens[1]} : null;
  m.tb = !clear && r.needTb && tb && hasScore(tb[0]) && hasScore(tb[1]) ? {a:tb[0], b:tb[1]} : null;
  m.winner = r.winner===null || r.winner===undefined ? null : (r.winner===0 ? m.team1 : m.team2);
  const stamp = new Date().toISOString();
  if(clear) delete m.scoredAt; else m.scoredAt = stamp;
  t.resultsAt = stamp;
  propagateBracket(t.knockoutBracket);
  DB.set('tournaments', all);
  closeModal();
  rerender();
  toast(clear ? 'Result cleared' : m.winner ? `${playerName(m.winner)} goes through` : 'Result saved · tie still in progress');
}

function openCompleteTournamentModal(tid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
  let champ=null, runner=null, third=null, fourth=null;
  if(t.format!=='league' && t.knockoutBracket?.length){
    const final = t.knockoutBracket[t.knockoutBracket.length-1][0];
    if(final?.winner){ champ = final.winner; runner = final.winner===final.team1 ? final.team2 : final.team1 }
    if(t.knockoutBracket.length>=2){
      const semis = t.knockoutBracket[t.knockoutBracket.length-2].filter(m=>m.winner && !m.isBye).map(m=>m.winner===m.team1?m.team2:m.team1).filter(x=>x && x!==champ && x!==runner && x!==final?.team1 && x!==final?.team2);
      if(semis.length===1) third = semis[0];
      else if(semis.length===2){
        const st = calculateAllStats();
        [third, fourth] = semis.sort((a,b)=>(st[b]?.wins||0)-(st[a]?.wins||0));
      }
    }
  } else if(t.format==='league' && t.groupData?.[0]){
    const s = computeStandings(t, t.groupData[0]);
    champ = s[0]?.playerId; runner = s[1]?.playerId; third = s[2]?.playerId; fourth = s[3]?.playerId;
  }
  if(runner && runner===champ) runner = null;
  if(third && (third===champ || third===runner)) third = null;
  if(fourth && [champ, runner, third].includes(fourth)) fourth = null;
  if(t.fourthPlace) fourth = t.fourthPlace;
  const options = sel => `<option value="">— Select —</option>` + (t.registrations||[]).map(r=>`<option value="${r.playerId}" ${r.playerId===sel?'selected':''}>${esc(playerName(r.playerId))}</option>`).join('');
  openModal(`
    <div class="modal-head"><div class="modal-title">Complete Tournament</div><button class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="text-sm text-muted mb-16">Placings are filled in from the results. ${t.format!=='league'?'Third place defaults to the losing semi-finalist with more wins; change it if you play a third-place match.':''} Placing points (Champion +20, Runner-up +12, 3rd +7, 4th +4) are added to the leaderboard when you complete the tournament.</div>
      <div class="form-group"><label class="form-label" for="ct_champ">Champion</label><select class="form-select ct-pick" id="ct_champ" onchange="syncPlacings()">${options(champ)}</select></div>
      <div class="form-group"><label class="form-label" for="ct_runner">Runner-up</label><select class="form-select ct-pick" id="ct_runner" onchange="syncPlacings()">${options(runner)}</select></div>
      <div class="form-group"><label class="form-label" for="ct_third">Third place</label><select class="form-select ct-pick" id="ct_third" onchange="syncPlacings()">${options(third)}</select></div>
      <div class="form-group"><label class="form-label" for="ct_fourth">Fourth place (optional)</label><select class="form-select ct-pick" id="ct_fourth" onchange="syncPlacings()">${options(fourth)}</select></div>
      <div class="text-xs text-muted">A player can only hold one place. Players already picked are greyed out in the other lists.</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="completeTournament('${tid}')">Complete Tournament</button>
    </div>`);
  syncPlacings();
}
function syncPlacings(){
  const sels = [...document.querySelectorAll('.ct-pick')];
  sels.forEach(sel=>{
    const taken = new Set(sels.filter(o=>o!==sel).map(o=>o.value).filter(Boolean));
    [...sel.options].forEach(op=>{ if(!op.value) return; op.disabled = taken.has(op.value); op.textContent = playerName(op.value) + (taken.has(op.value) ? ' (already placed)' : '') });
  });
}

function completeTournament(tid){
  const c = document.getElementById('ct_champ').value || null, r = document.getElementById('ct_runner').value || null, th = document.getElementById('ct_third').value || null, fo = document.getElementById('ct_fourth')?.value || null;
  if(!c){ toast('Choose a champion', true); return }
  const picks = [c,r,th,fo].filter(Boolean);
  if(new Set(picks).size !== picks.length){ toast('Each placing needs a different player', true); return }
  const {all, t} = getT(tid);
  t.champion = c; t.runnerUp = r; t.thirdPlace = th; t.fourthPlace = fo;
  t.status = 'completed';
  t.completedAt = new Date().toISOString();
  t.resultsAt = t.completedAt;
  DB.set('tournaments', all);
  closeModal();
  currentTab = 'tab-overview';
  rerender();
  toast('Tournament completed · Leaderboard updated');
}

function editTournament(tid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
  const locked = t.groupsDrawn || t.knockoutDrawn;
  openModal(`
    <div class="modal-head"><div class="modal-title">Edit Tournament</div><button class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label" for="e_name">Name</label><input class="form-input" id="e_name" value="${esc(t.name)}" maxlength="80"></div>
      ${imageFieldHTML('tlogo', 'Tournament logo', 'Shown on the tournament page, cards and exported images. Drag and zoom to fit it in the square.')}
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="e_datetime_d">Start date &amp; time</label>${dtField('e_datetime', t.startDateTime||'', '20:00')}</div>
        <div class="form-group"><label class="form-label" for="e_deadline_d">Group stage deadline</label>${dtField('e_deadline', t.groupDeadline||'')}</div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="e_status">Status</label>
          <select class="form-select" id="e_status">
            ${[['draft','Draft (admins only)'],['open','Open'],['active','Live'],['completed','Completed']].map(([v,l])=>`<option value="${v}" ${t.status===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label" for="e_game">Game</label><input class="form-input" id="e_game" value="${esc(t.game||'')}"></div>
      </div>
      ${t.format==='group_knockout'?`
        <div class="form-row">
          <div class="form-group"><label class="form-label" for="e_groups">Number of Groups</label><input class="form-input" type="number" id="e_groups" value="${t.groups}" min="1" max="16"></div>
          <div class="form-group"><label class="form-label" for="e_qualify">Qualify per Group</label><input class="form-input" type="number" id="e_qualify" value="${t.qualifyPerGroup}" min="1" max="8"></div>
        </div>
        <div class="form-group"><label class="form-label" for="e_seed">Knockout Seeding</label>
          <select class="form-select" id="e_seed">
            <option value="dynamic" ${t.seeding!=='random'?'selected':''}>Seeded by group finish</option>
            <option value="random" ${t.seeding==='random'?'selected':''}>Random</option>
          </select>
        </div>
        ${locked?'<div class="text-xs text-muted mb-16">Group count applies the next time you redraw. Qualifiers and seeding apply when the bracket is drawn.</div>':''}`:''}
      ${t.format!=='league'?`
        <div class="form-group"><label class="form-label" for="e_ko">Knockout Match Format</label>
          <select class="form-select" id="e_ko">
            ${[['single','Single Match'],['bo3','Best of 3'],['2leg','2-Leg']].map(([v,l])=>`<option value="${v}" ${t.knockoutFormat===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </div>`:''}
      <div class="card" style="background:var(--surface-2);padding:16px">
        <div class="card-title" style="margin-bottom:12px">Prize Pool</div>
        <div class="form-row-3">
          <div class="form-group"><label class="form-label" for="e_p1">Champion</label><input class="form-input" id="e_p1" value="${esc(t.prize?.champion||'')}"></div>
          <div class="form-group"><label class="form-label" for="e_p2">Runner-up</label><input class="form-input" id="e_p2" value="${esc(t.prize?.runnerUp||'')}"></div>
          <div class="form-group"><label class="form-label" for="e_p3">Third Place</label><input class="form-input" id="e_p3" value="${esc(t.prize?.thirdPlace||'')}"></div>
        </div>
      </div>
      <div class="form-group mt-16"><label class="form-label" for="e_desc">Description</label><textarea class="form-textarea" id="e_desc">${esc(t.description||'')}</textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveTournamentEdit('${tid}')">Save Changes</button>
    </div>`, 'lg');
  initImageField('tlogo', LOGO_OPTS, t.logo ? {image:t.logo, src:t.logoSrc, crop:t.logoCrop} : null);
}

function saveTournamentEdit(tid){
  const name = document.getElementById('e_name').value.trim();
  if(!name){ toast('Enter a tournament name', true); return }
  const {all, t} = getT(tid);
  t.name = name;
  const dt = readDT('e_datetime');
  t.startDateTime = dt; t.date = dt ? dt.slice(0,10) : t.date;
  const newDeadline = readDT('e_deadline');
  if(newDeadline !== t.groupDeadline){ t.groupDeadline = newDeadline; t.deadlineProcessed = false }
  t.status = document.getElementById('e_status').value;
  t.game = document.getElementById('e_game').value.trim();
  t.description = document.getElementById('e_desc').value.trim();
  t.prize = { champion: document.getElementById('e_p1').value.trim(), runnerUp: document.getElementById('e_p2').value.trim(), thirdPlace: document.getElementById('e_p3').value.trim() };
  if(t.format==='group_knockout'){
    t.groups = Math.max(1, +document.getElementById('e_groups').value||1);
    t.qualifyPerGroup = Math.max(1, +document.getElementById('e_qualify').value||1);
    t.seeding = document.getElementById('e_seed').value;
  }
  if(t.format!=='league'){
    const ko = document.getElementById('e_ko').value;
    if(ko!==t.knockoutFormat && (t.knockoutBracket||[]).flat().some(m=>!m.isBye && m.winner)){ toast('Knockout results exist, so the match format stays as it is. Redraw the bracket to change it.', true) }
    else t.knockoutFormat = ko;
  }
  applyImage(t, 'logo', imageFieldValue('tlogo'));
  DB.set('tournaments', all);
  closeModal();
  rerender();
  toast('Tournament updated');
}

/* A player's matches in this tournament, opened by tapping them in the standings. */
function openPlayerMatches(tid, pid){
  const t = STORE.tournaments.find(x=>x.id===tid); if(!t) return;
  const p = STORE.players.find(x=>x.id===pid) || {name:'Unknown player'};
  const list = getPlayerFixtures(t, pid).map((f,i)=>({...f, _i:i}))
    .sort((a,b)=> (!!b.result - !!a.result) || (a.result ? String(b.at||'').localeCompare(String(a.at||'')) : 0) || a._i-b._i);
  const done = list.filter(f=>f.result && f.result!=='np');
  const n = r => done.filter(f=>f.result===r).length;
  let gf=0, ga=0; done.forEach(f=>{ if(f.goals){ gf+=f.goals[0]; ga+=f.goals[1] } });
  const W=n('win'), D=n('draw'), L=n('loss');
  const sum = (v,l) => `<span><b>${v}</b>${l}</span>`;
  const rows = list.map(f=>{
    const opp = STORE.players.find(x=>x.id===f.opponent) || {name: f.opponent ? 'Unknown player' : 'To be decided'};
    const cls = f.result==='win' ? 'w' : f.result==='loss' ? 'l' : f.result==='draw' ? 'd' : f.result==='np' ? 'np' : 'p';
    const tag = {w:'W', l:'L', d:'D', np:'–', p:''}[cls];
    return `<li class="pm-row">
      <span class="pm-res ${cls}">${tag || '–'}</span>
      <span class="pm-mid"><span class="pm-opp">${renderAvatar(opp, 26)}<b>${esc(opp.name)}</b></span><span class="pm-stage">${esc(f.stage)}${/ agg$/.test(f.score||'') ? ' · aggregate' : / games$/.test(f.score||'') ? ' · games won' : ''}${f.detail ? ` · ${esc(f.detail)}` : ''}${f.at && f.result ? ` · ${esc(whenText(f.at))}` : ''}</span></span>
      <span class="pm-score ${cls}">${f.score ? esc(f.score.replace(/ (agg|games)$/,'')).replace(' - ','–') : 'vs'}</span>
    </li>`;
  }).join('');
  openModal(`
    <div class="modal-head"><div class="pm-head">${renderAvatar(p, 40)}<div style="min-width:0"><div class="modal-title">${esc(p.name)}</div><div class="text-sm text-muted">${esc(t.name)}</div></div></div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
      <div class="pm-sum">${sum(done.length,'Played')}${sum(W,'W')}${sum(D,'D')}${sum(L,'L')}${sum(`${gf}–${ga}`,'Goals')}</div>
      ${list.length ? `<ul class="pm-list">${rows}</ul>` : `<div class="empty"><div class="empty-title">No matches yet</div><div class="text-sm">Matches appear when the tournament starts.</div></div>`}
      <button type="button" class="btn btn-white" onclick="closeModal(); selectedPlayerFilter='${pid}'; switchTab('tab-player')">Open in Player View ${ICON.arrow}</button>
    </div>`);
}

/* =========================
   PLAYER VIEW TAB
   ========================= */
function selectPlayerView(tid, pid){
  selectedPlayerFilter = pid;
  const t = STORE.tournaments.find(x=>x.id===tid);
  document.getElementById('tab-player').innerHTML = renderPlayerViewTab(t);
}

function getPlayerFixtures(t, pid){
  const list = [];
  (t.fixtures||[]).forEach(f=>{
    if(f.team1!==pid && f.team2!==pid) return;
    const me1 = f.team1===pid, played = realResult(f);
    if(f.autoDraw && hasScore(f.score1)){ list.push({stage: t.format==='league'?`Matchday ${f.matchday}`:`Group ${f.group}`, opponent: me1?f.team2:f.team1, score:'0 - 0', goals:null, result:'np', detail:'Not played · no points', at: f.scoredAt||''}); return }
    const my = me1?f.score1:f.score2, opp = me1?f.score2:f.score1;
    list.push({stage: t.format==='league'?`Matchday ${f.matchday}`:`Group ${f.group}`, opponent: me1?f.team2:f.team1, score: played?`${my} - ${opp}`:null, goals: played?[my,opp]:null, result: !played?null: my>opp?'win':my<opp?'loss':'draw', at: f.scoredAt||''});
  });
  (t.knockoutBracket||[]).forEach(round=>round.forEach(m=>{
    if(m.isBye || (m.team1!==pid && m.team2!==pid)) return;
    const me = m.team1===pid ? 0 : 1, r = koResult(t, m), fmt = t.knockoutFormat;
    const legs = koLegs(t, m).filter(l=>hasScore(l[0])&&hasScore(l[1]));
    const names = koFieldLabels(fmt);
    let detail = fmt!=='single' && !r.legacy ? legs.map((l,i)=>`${names[i]} ${l[me]}–${l[1-me]}`).join(' · ') : '';
    if(m.tb && hasScore(m.tb.a) && hasScore(m.tb.b) && (r.byTb || r.byPens)){ const tt = [m.tb.a, m.tb.b]; detail = (detail ? detail+' · ' : '') + `Tie-breaker ${tt[me]}–${tt[1-me]}` }
    if(r.byPens && m.pens){ const pp = [m.pens.a, m.pens.b]; detail = (detail ? detail+' · ' : '') + `Pens ${pp[me]}–${pp[1-me]}` }
    list.push({stage: m.round, opponent: me===0?m.team2:m.team1, score: r.played && r.total ? `${r.total[me]} - ${r.total[1-me]}${fmt==='2leg'?' agg':fmt==='bo3'?' games':''}` : null, goals: r.goals ? [r.goals[me], r.goals[1-me]] : null, detail, result: m.winner ? (m.winner===pid?'win':'loss') : null});
  }));
  return list;
}

function renderPlayerViewTab(t){
  const registered = (t.registrations||[]).map(r=>r.playerId);
  const selectedId = selectedPlayerFilter && registered.includes(selectedPlayerFilter) ? selectedPlayerFilter : registered[0];
  if(!selectedId) return `<div class="card empty"><div class="empty-title">No players registered</div></div>`;
  const p = STORE.players.find(x=>x.id===selectedId) || {name:'Unknown player'};
  // Played matches first (latest result on top), then pending ones in schedule order.
  const fixtures = getPlayerFixtures(t, selectedId).map((f,i)=>({...f, _i:i}))
    .sort((a,b)=> (!!b.result - !!a.result) || (a.result ? String(b.at||'').localeCompare(String(a.at||'')) : 0) || a._i-b._i);
  const done = fixtures.filter(f=>f.result && f.result!=='np');
  let gf=0, ga=0; done.forEach(f=>{ if(f.goals){ gf+=f.goals[0]; ga+=f.goals[1] } });
  const wins = done.filter(f=>f.result==='win').length;
  const resBadge = r => r==='np' ? '<span class="badge badge-np">Not played · 0 pts</span>' : r==='win' ? '<span class="badge badge-completed">Win</span>' : r==='loss' ? '<span class="badge" style="background:var(--danger-tint);color:var(--danger-ink)">Loss</span>' : r==='draw' ? '<span class="badge badge-draft">Draw</span>' : '<span class="badge badge-pending">Pending</span>';
  return `
    <section class="card" style="display:flex;flex-wrap:wrap;align-items:center;gap:16px">
      ${renderAvatar(p, 64)}
      <div style="flex:1;min-width:180px">
        <div class="player-name" style="font-size:30px">${esc(p.name)}</div>
        <div class="player-meta">${esc(p.achievements||'Tournament participant')}</div>
      </div>
      <div style="min-width:200px;flex:0 1 280px">
        <label class="form-label" for="pv_select">Show player</label>
        <select class="form-select" id="pv_select" onchange="selectPlayerView('${t.id}', this.value)">
          ${registered.map(pid=>`<option value="${pid}" ${pid===selectedId?'selected':''}>${esc(playerName(pid))}</option>`).join('')}
        </select>
      </div>
    </section>
    <div class="grid grid-4">
      ${statTile('ball','tint-blue','Played', done.length, `${fixtures.filter(f=>!f.result).length} to play`)}
      ${statTile('trophy','tint-gold','Wins', wins)}
      ${statTile('goal','tint-green','Goals', gf, `${ga} conceded`)}
      ${statTile('check','tint-purple','Win rate', (done.length?((wins/done.length)*100).toFixed(1):'0.0')+'%')}
    </div>
    <section id="playerFixturesExport" class="export-container" style="display:flex;flex-direction:column;gap:12px">
      <div class="export-header"><div class="export-title">${esc(p.name)}</div><div class="export-subtitle">${esc(t.name)}</div></div>
      <div class="card-head no-export" style="margin:0">
        <h2 class="card-title">${esc(p.name)}'s fixtures</h2>
        <button type="button" class="export-btn" onclick="exportAsJPEG('playerFixturesExport','${slug(p.name)}_fixtures')">${ICON_DL} Export</button>
      </div>
      ${fixtures.length===0 ? `<div class="empty"><div class="empty-title">No fixtures yet</div><div class="text-sm">Fixtures appear when the tournament starts.</div></div>` : `
      <div class="table-wrap"><table class="fx-table">
        <thead><tr><th scope="col">Stage</th><th scope="col" class="t-right">Player</th><th scope="col" class="t-center">Result</th><th scope="col">Opponent</th><th scope="col" class="t-right">Outcome</th></tr></thead>
        <tbody>
        ${fixtures.map(f=>{ const opp = STORE.players.find(x=>x.id===f.opponent) || {name: f.opponent?'Unknown player':'TBD'}; return `
          <tr>
            <td class="text-muted" style="white-space:nowrap">${esc(f.stage)}</td>
            <td class="t-right"><span class="who right" style="color:var(--primary-dark)">${esc(p.name)}${renderAvatar(p,30)}</span></td>
            <td class="t-center"><span class="result-pill ${f.score?'':'pending'}">${f.score ? esc(f.score).replace(' - ',' – ') : 'vs'}</span>${f.detail?`<div class="text-xs text-muted" style="margin-top:4px;white-space:nowrap">${esc(f.detail)}</div>`:''}</td>
            <td><span class="who">${renderAvatar(opp,30)}${esc(opp.name)}</span></td>
            <td class="t-right">${resBadge(f.result)}</td>
          </tr>`}).join('')}
        </tbody></table></div>`}
    </section>`;
}

/* =========================
   TOURNAMENT RULES & MATCH SETTINGS
   Each stage (group/league, knockout) has its own rules, match settings, editor and export.
   ========================= */
const MATCH_FIELDS = [
  {k:'time', label:'Match time', opts:[6,8,10,12,15,20,25,30].map(n=>[String(n), `${n} minutes`])},
  {k:'extra', label:'Extra time', opts:[['OFF','OFF'],['ON','ON']]},
  {k:'pens', label:'Penalties', opts:[['OFF','OFF'],['ON','ON']]},
  {k:'subs', label:'Substitutions', opts:[1,2,3,4,5,6].map(n=>[String(n), String(n)])},
  {k:'windows', label:'Sub pauses', opts:[1,2,3,4,5,6].map(n=>[String(n), String(n)])},
  {k:'condition', label:'Player condition', opts:[['RANDOM','RANDOM'],['EXCELLENT','EXCELLENT']]},
  {k:'injuries', label:'Injuries', opts:[['OFF','OFF'],['ON','ON']]},
  {k:'tiebreak', label:'When level on aggregate', opts:[['MATCH','Play a tie-breaker match'],['PENS','Go straight to penalties']], tbOnly:true},
];
function fmtShort(d){ if(!d) return '—'; const dt = new Date(d); if(isNaN(dt)) return '—'; return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) + ' · ' + dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) }
function ruleSections(t){
  const s = [];
  if(t.format==='league') s.push({key:'group', title:'League', short:'League'});
  if(t.format==='group_knockout') s.push({key:'group', title:'Group stage', short:'Group stage'});
  if(t.format!=='league') s.push({key:'ko', title: t.format==='single_elimination' ? 'Knockout' : 'Knockout stage', short:'Knockout'});
  if(t.format!=='league' && t.knockoutFormat==='2leg') s.push({key:'tb', title:'Tie-breaker match', short:'Tie-breaker'});
  return s;
}
function expectedKoRounds(t){
  if(t.format==='league') return [];
  if(t.knockoutBracket?.length) return t.knockoutBracket.map(r=>r[0]?.round).filter(Boolean);
  const regs = (t.registrations||[]).length;
  const n = t.format==='group_knockout'
    ? distributePlayersToGroups(Math.max(regs, (t.groups||1)*(t.qualifyPerGroup||1)), t.groups||1).reduce((a,size)=>a+Math.min(size, t.qualifyPerGroup||1), 0)
    : regs;
  const P = nextPow2(Math.max(2, n));
  const out = []; for(let m=P/2; m>=1; m/=2) out.push(roundLabel(m));
  return out;
}
/* Round names with a deadline: the bracket's (or estimated) rounds first, then any saved under another name. */
function koDeadlineRounds(t){
  const base = expectedKoRounds(t), dl = t.rules?.roundDeadlines || {};
  const order = ['Round of 64','Round of 32','Round of 16','Quarter Finals','Semi Finals','Final'];
  const extra = Object.keys(dl).filter(k=>dl[k] && !base.includes(k));
  return [...base, ...extra].sort((a,b)=> (order.indexOf(a)<0?-1:order.indexOf(a)) - (order.indexOf(b)<0?-1:order.indexOf(b)));
}
function stageData(t, key){
  const r = t.rules || {};
  const pre = key==='group' ? 'group' : key==='tb' ? 'tb' : 'ko';
  const match = {...(r[pre+'Match'] || {})};
  if(key==='tb'){ const mode = tbMode(t); if(mode) match.tiebreak = mode }
  if(key==='ko') delete match.tiebreak;
  return { rules: r[pre+'Rules'] || '', match, custom: r[pre+'Settings'] || [] };
}
function settingsList(t, key){
  const d = stageData(t, key), m = d.match, out = [];
  if(m.time) out.push({label:'Match time', value:`${m.time} min`});
  if(m.extra) out.push({label:'Extra time', value:m.extra});
  if(m.pens) out.push({label:'Penalties', value:m.pens});
  if(m.subs || m.windows) out.push({label:'Substitutions', value:[m.subs?`${m.subs} subs`:'', m.windows?`${m.windows} pause${m.windows==='1'?'':'s'}`:''].filter(Boolean).join(' · ')});
  if(m.condition) out.push({label:'Player condition', value:m.condition});
  if(m.injuries) out.push({label:'Injuries', value:m.injuries});
  if(key==='tb' && m.tiebreak) out.unshift({label:'Level on aggregate', value: m.tiebreak==='MATCH' ? 'Tie-breaker match' : 'Penalties'});
  if(key==='ko' && t.knockoutFormat==='2leg' && tbMode(t)) out.push({label:'Level on aggregate', value: tbMode(t)==='MATCH' ? 'Tie-breaker match' : 'Penalties'});
  return out.concat(d.custom.filter(x=>x.label && x.value));
}
function stageHasContent(t, key){
  const d = stageData(t, key);
  const dl = key==='ko' && Object.values(t.rules?.roundDeadlines||{}).some(Boolean);
  return !!(d.rules.trim() || settingsList(t, key).length || dl);
}
function hasRules(t){ return ruleSections(t).some(s=>stageHasContent(t, s.key)) }
function ruleLines(text){ return String(text||'').split('\n').map(x=>x.replace(/^\s*(\d+[.)]|[-•*])\s*/,'').trim()).filter(Boolean) }

function rulesSectionHTML(t, sec, admin){
  const lines = ruleLines(stageData(t, sec.key).rules);
  const settings = settingsList(t, sec.key);
  const dl = t.rules?.roundDeadlines || {};
  const rounds = sec.key==='ko' ? koDeadlineRounds(t) : [];
  const hasDl = rounds.some(x=>dl[x]);
  const groupDl = sec.key==='group' && t.groupDeadline ? `<div class="rules-deadline"><span>${ICON.calendar}</span><div><small>${t.format==='league'?'League deadline':'Group stage deadline'}</small><b>${fmtDateTime(t.groupDeadline)}</b></div></div>` : '';
  const has = stageHasContent(t, sec.key);
  return `<section class="rules-card" id="rules-${sec.key}">
    <div class="rules-card-head">
      <span class="rules-chip">${esc(sec.title)}</span>
      <span class="rules-card-actions no-export">
        ${has ? `<button type="button" class="btn-icon-square" onclick="exportRulesSheet('${t.id}','${sec.key}')" aria-label="Export ${esc(sec.title)} rules (image or PDF)" title="Export ${esc(sec.title)} (image or PDF)">${ICON_DL}</button>` : ''}
        ${admin ? `<button type="button" class="btn btn-primary btn-sm" style="min-height:44px" onclick="openRulesModal('${t.id}','${sec.key}')">${has?'Edit':'Add rules'}</button>` : ''}
      </span>
    </div>
    ${groupDl}
    <div class="rules-block rb-rules">
      <h3>Rules</h3>
      ${lines.length ? `<ol class="rules-list">${lines.map(l=>`<li>${esc(l)}</li>`).join('')}</ol>` : `<p class="rules-empty">No rules added yet.</p>`}
    </div>
    <div class="rules-block rb-settings">
      <h3>Match settings</h3>
      ${settings.length ? `<dl class="settings-grid">${settings.map(x=>`<div><dt>${esc(x.label)}</dt><dd class="${String(x.value).length>12?'long':''}">${esc(x.value)}</dd></div>`).join('')}</dl>` : `<p class="rules-empty">No match settings added yet.</p>`}
    </div>
    ${sec.key==='ko' ? `<div class="rules-block rb-dl">
      <h3>Round deadlines</h3>
      ${hasDl ? `<div class="deadline-list">${rounds.map(x=>{ const d = dl[x]; const past = d && new Date(d) < new Date(); return `<div class="${past?'past':''}"><span>${esc(x)}</span>${past?'<i>Passed</i>':''}<b>${d ? fmtDateTime(d) : 'Not set'}</b></div>` }).join('')}</div>` : `<p class="rules-empty">No round deadlines set yet.</p>`}
    </div>` : ''}
  </section>`;
}

function renderRulesTab(t, admin){
  const secs = ruleSections(t);
  const any = hasRules(t);
  return `
    <div class="hof-bar">
      <div><h2 class="card-title">Rules &amp; match settings</h2><div class="page-sub">${any && t.rules?.updatedAt ? `Updated ${fmtDate(t.rules.updatedAt)}` : 'What every player needs to know before playing'}</div></div>
      ${any && secs.length>1 ? `<div class="hof-bar-actions"><button type="button" class="btn btn-secondary" onclick="exportRulesSheet('${t.id}')">${ICON_DL} Export all</button></div>` : ''}
    </div>
    ${!any && !admin ? `<div class="card empty"><div class="empty-title">No rules published yet</div><div class="text-sm">The organisers will post the rules and match settings here.</div></div>` :
      `<div class="grid ${secs.length>1?'grid-2':''}" style="align-items:start">${secs.map(sec=>rulesSectionHTML(t, sec, admin)).join('')}</div>`}`;
}

function settingRowHTML(label='', value=''){
  return `<div class="setting-row">
    <input class="form-input" data-cl maxlength="40" value="${esc(label)}" placeholder="Setting, e.g. Server" aria-label="Setting name">
    <input class="form-input" data-cv maxlength="60" value="${esc(value)}" placeholder="Value, e.g. Asia" aria-label="Setting value">
    <button type="button" class="btn btn-ghost btn-icon" onclick="this.parentElement.remove()" aria-label="Remove setting">✕</button>
  </div>`;
}
function addSettingRow(){ document.getElementById('rs_custom').insertAdjacentHTML('beforeend', settingRowHTML()); const ins = document.querySelectorAll('[data-cl]'); ins[ins.length-1].focus() }

function openRulesModal(tid, key){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
  const sec = ruleSections(t).find(s=>s.key===key);
  const d = stageData(t, key);
  const rounds = key==='ko' ? koDeadlineRounds(t) : [];
  const dl = t.rules?.roundDeadlines || {};
  openModal(`
    <div class="modal-head"><div class="modal-title">${esc(sec.title)} · rules &amp; settings</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:20px">
      <div class="page-sub">${key==='tb' ? `Used when a 2-leg knockout tie in <b>${esc(t.name)}</b> is level on aggregate. These settings apply to the tie-breaker match only.` : `Only for <b>${esc(t.name)}</b>. Everyone can read these on the tournament's Rules tab.`}</div>
      <fieldset class="rules-edit">
        <legend>Match settings</legend>
        <div class="match-fields">
          ${MATCH_FIELDS.filter(f=>!f.tbOnly || key==='tb').map(f=>`<label class="match-field" for="mf_${f.k}"><span>${f.label}</span>
            <select class="form-select" id="mf_${f.k}" data-mf="${f.k}"><option value="">Not set</option>${f.opts.map(([v,l])=>`<option value="${v}" ${String(d.match[f.k]||'')===v?'selected':''}>${l}</option>`).join('')}</select></label>`).join('')}
        </div>
        <div class="form-label" style="margin:16px 0 8px">Other settings (optional)</div>
        <div class="settings-edit" id="rs_custom">${d.custom.map(x=>settingRowHTML(x.label, x.value)).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="addSettingRow()">${ICON.plus} Add another setting</button>
      </fieldset>
      <fieldset class="rules-edit">
        <legend>Rules</legend>
        <div class="flex-between" style="margin-bottom:8px">
          <span class="form-label" style="margin:0">One rule per line</span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="generateRules('${tid}','${key}')">Generate standard rules</button>
        </div>
        <textarea class="form-textarea" id="rr_text" rows="8" placeholder="Press Generate standard rules to start from a ready-made list, then edit it.">${esc(d.rules)}</textarea>
        <div class="text-xs text-muted" style="margin-top:6px">Generated rules use this tournament's setup and the match settings above. Generating again replaces the text.</div>
      </fieldset>
      ${key==='ko' ? `<fieldset class="rules-edit">
        <legend>Round deadlines</legend>
        ${rounds.length ? `<div class="round-dl-edit">${rounds.map((x,i)=>`<div class="rd-row"><label for="rd_${i}_d">${esc(x)}</label>${dtField('rd_'+i, dl[x]||'', '23:59', `data-round="${esc(x)}"`)}</div>`).join('')}</div>` : `<p class="text-sm text-muted">Rounds appear once players are registered.</p>`}
        ${!t.knockoutBracket && rounds.length ? `<div class="text-xs text-muted" style="margin-top:8px">Rounds are estimated from the current players and qualifiers. They update once the bracket is drawn.</div>` : ''}
      </fieldset>` : ''}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveRules('${tid}','${key}')">Save ${esc(sec.short.toLowerCase())}</button>
    </div>`, 'lg');
}

function readMatchForm(){ const m = {}; document.querySelectorAll('[data-mf]').forEach(sel=>{ if(sel.value) m[sel.dataset.mf] = sel.value }); return m }

function generateRules(tid, key){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const m = readMatchForm();
  const L = [];
  if(key==='group'){
    if(t.format==='league'){
      L.push(`League format: every player plays each opponent ${t.leagueRounds===2?'twice (home and away)':'once'}.`);
      L.push('Win = 3 points, draw = 1 point, loss = 0 points.');
      L.push('Ties in the table are split by goal difference, then goals scored.');
      L.push('The player at the top of the table at the end is the champion.');
    } else {
      L.push(`${t.groups||1} group${(t.groups||1)>1?'s':''}: every player plays each opponent in their group once.`);
      L.push('Win = 3 points, draw = 1 point, loss = 0 points.');
      L.push('Ties in the table are split by goal difference, then goals scored.');
      L.push(`The top ${t.qualifyPerGroup||1} in each group go through to the knockout stage.`);
    }
    if(t.groupDeadline) L.push(`All matches must be played by ${fmtDateTime(t.groupDeadline)}. Matches not played by then count as 0-0 draws.`);
    if(m.time) L.push(`Each match is ${m.time} minutes.`);
    L.push('Agree the match time with your opponent and send the final score screenshot to the organisers.');
    L.push('If a match disconnects, replay it from the same score and time if both players agree; otherwise the organisers decide.');
  } else if(key==='tb'){
    const mode = m.tiebreak || tbMode(t);
    if(mode==='PENS'){
      L.push('If the aggregate score is level after the second leg, there is no tie-breaker match. A penalty shoot-out decides who goes through.');
    } else {
      L.push('If the aggregate score is level after both legs, the two players play one tie-breaker match.');
      L.push('The winner of the tie-breaker match goes through. Goals from the two legs do not carry over.');
      if(m.extra==='ON' && m.pens==='ON') L.push('If the tie-breaker match is level after full time, it goes to extra time and then penalties.');
      else if(m.extra==='ON') L.push('If the tie-breaker match is level after full time, it goes to extra time, then penalties if still level.');
      else L.push('If the tie-breaker match is level after full time, a penalty shoot-out decides it.');
      if(m.time) L.push(`The tie-breaker match is ${m.time} minutes.`);
      L.push('Play the tie-breaker as soon as possible after the second leg, and before the round deadline.');
      L.push('Send the final score screenshot of the tie-breaker to the organisers straight after the match.');
    }
  } else {
    const fmt = t.knockoutFormat;
    if(fmt==='2leg') L.push('Every tie is played over two legs. The aggregate score decides who goes through.');
    else if(fmt==='bo3') L.push('Every tie is best of 3 games. The first player to win 2 games goes through.');
    else L.push('Every tie is a single match. The winner goes through.');
    let lvl = fmt==='2leg' ? 'If the aggregate score is level after the second leg' : fmt==='bo3' ? 'If a game is level after full time' : 'If the score is level after full time';
    if(fmt==='2leg' && tbMode(t)==='MATCH'){
      L.push('If the aggregate score is level after the second leg, the two players play a tie-breaker match. The winner of the tie-breaker goes through (see the Tie-breaker match rules).');
    }
    else if(m.extra==='ON' && m.pens==='ON') L.push(`${lvl}, it goes to extra time and then penalties.`);
    else if(m.extra==='ON') L.push(`${lvl}, it goes to extra time.`);
    else if(m.pens==='ON') L.push(`${lvl}, penalties decide it.`);
    if(t.format==='group_knockout') L.push(t.seeding==='random' ? 'The bracket is drawn at random, but players from the same group never meet in the first round.' : 'Group winners face runners-up, and players from the same group never meet in the first round.');
    if(Object.values(t.rules?.roundDeadlines||{}).some(Boolean) || document.querySelector('[data-round]')) L.push('Each round must be finished by its deadline. The organisers decide any tie that is not played on time.');
    if(m.time) L.push(`Each match is ${m.time} minutes.`);
    L.push('Send the final score screenshot to the organisers straight after every match.');
  }
  document.getElementById('rr_text').value = L.join('\n');
  toast('Standard rules added. Edit them as you like before saving.');
}

function saveRules(tid, key){
  const match = readMatchForm();
  const custom = [...document.querySelectorAll('[data-cl]')].map(inp=>({label: inp.value.trim(), value: inp.parentElement.querySelector('[data-cv]').value.trim()})).filter(x=>x.label && x.value);
  const text = document.getElementById('rr_text').value.trim();
  const {all, t} = getT(tid);
  const r = {...(t.rules||{})};
  if(key==='group'){ r.groupRules = text; r.groupMatch = match; r.groupSettings = custom }
  else if(key==='tb'){
    r.tbRules = text; r.tbMatch = match; r.tbSettings = custom;
    if(r.koMatch && r.koMatch.tiebreak){ r.koMatch = {...r.koMatch}; delete r.koMatch.tiebreak }
  }
  else {
    const oldMode = r.koMatch?.tiebreak; if(oldMode && !r.tbMatch?.tiebreak) match.tiebreak = oldMode;
    r.koRules = text; r.koMatch = match; r.koSettings = custom;
    const dl = {...(r.roundDeadlines||{})};
    document.querySelectorAll('[data-round]').forEach(el=>{ const v = readDT(el.id); if(v) dl[el.dataset.round] = v; else delete dl[el.dataset.round] });
    r.roundDeadlines = dl;
  }
  r.updatedAt = new Date().toISOString();
  t.rules = r;
  DB.set('tournaments', all);
  closeModal(); currentTab = 'tab-rules'; rerender();
  toast('Rules saved');
}

/* Export pages in a 5:4 shape (1500 × 1200). */
const X54 = {w:1500, h:1200};
function exportRulesSheet(tid, key){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const secs = ruleSections(t).filter(s=>!key || s.key===key).filter(s=>key || stageHasContent(t, s.key));
  if(!secs.length){ toast('Nothing to export yet', true); return }
  // One 5:4 page per stage: rules on the left, match settings and deadlines on the right.
  const pages = secs.map((sec, i)=>{
    const dlBits = [];
    if(sec.key==='group' && t.groupDeadline) dlBits.push(`${t.format==='league'?'League':'Group stage'} deadline ${fmtDateTime(t.groupDeadline)}`);
    if(sec.key==='ko'){ const fin = (t.rules?.roundDeadlines||{})['Final']; if(fin) dlBits.push(`Final by ${fmtDateTime(fin)}`) }
    if(sec.key==='tb') dlBits.push('Used when a 2-leg tie is level on aggregate');
    return `<div class="x54 x54-rules">${sheetHeader(t, t.name, [`${sec.title} · Rules &amp; match settings`, ...dlBits].join(' · '))}${rulesSectionHTML(t, sec, false)}${sheetFoot(i+1, secs.length)}</div>`;
  });
  return renderSheets(pages, X54.w, `${slug(t.name)}_${key ? slug(secs[0].title) + '_' : ''}rules`);
}

/* =========================
   HALL OF FAME
   ========================= */
const HOF_TYPES = {
  champion:{label:'Champion', medal:'1', cls:'gold'},
  runner_up:{label:'Runner-up', medal:'2', cls:'silver'},
  third:{label:'Third place', medal:'3', cls:'bronze'},
  award:{label:'Award', medal:'★', cls:'award'}
};
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/* Placement badge used across the app: a metallic disc (gold, silver, bronze, or purple for awards)
   with the place number in the display font. Same look as the leaderboard position badges. */
const STAR_SVG = '<svg viewBox="0 0 24 24" width="55%" height="55%" aria-hidden="true"><path d="M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17l-5.6 3 1.1-6.2-4.6-4.4 6.3-.9z" fill="currentColor"/></svg>';
function medalHTML(cls, label, size=32){
  const name = HOF_TYPES[cls==='gold'?'champion':cls==='silver'?'runner_up':cls==='bronze'?'third':'award']?.label || '';
  return `<span class="rk rk-${cls} rk-sz" style="--s:${size}px" role="img" aria-label="${esc(name)}">${cls==='award' ? STAR_SVG : esc(label)}</span>`;
}
function hofMedal(type, size){ const t = HOF_TYPES[type] || HOF_TYPES.award; return medalHTML(t.cls, t.medal, size) }
let hofFilter = {org:'all', player:'all'};

function hofPlayer(h){ return h.playerId ? (STORE.players.find(p=>p.id===h.playerId) || {name: h.playerName || 'Unknown player'}) : {name: h.playerName || 'Unknown player'} }
function hofTitle(h){ return h.type==='award' ? (h.title || 'Award') : (h.title || HOF_TYPES[h.type]?.label || 'Achievement') }
function hofDate(h){ if(!h.date) return ''; const [y,m] = String(h.date).split('-'); return m ? `${MONTHS[+m-1]||''} ${y}` : y }
// Short name for the community as an organiser in the Hall of Fame.
const HOF_OUR_ORG = 'MG';
function hofOrg(h){ return h.organizer==='other' ? (h.organizerName || 'Other organiser') : HOF_OUR_ORG }
function hofKey(h){ return h.playerId || 'name:'+String(h.playerName||'').toLowerCase() }

function hofRow(h){
  const t = HOF_TYPES[h.type] || HOF_TYPES.award, p = hofPlayer(h);
  return `<div class="row-grid hof-row">
    ${medalHTML(t.cls, t.medal, 26)}
    ${renderAvatar(p, 30)}
    <span class="row-stack"><b>${esc(p.name)}</b><span>${esc(hofTitle(h))} · ${esc(h.tournament||'')}</span></span>
    <span class="row-date">${esc(hofDate(h)) || '—'}</span>
  </div>`;
}

const EDIT_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
/* One Hall of Fame achievement as a list row: medal, player, achievement and tournament, organiser and date. */
function hofItem(h, admin){
  const t = HOF_TYPES[h.type] || HOF_TYPES.award, p = hofPlayer(h);
  return `<div class="hof-li ${t.cls}">
    <span class="hof-li-medal">${medalHTML(t.cls, t.medal, 30)}</span>
    <span class="hof-li-av">${renderAvatar(p, 40)}</span>
    <span class="hof-li-main">
      <b>${esc(p.name)}</b>
      <span class="hof-li-sub"><i class="hof-chip ${t.cls}">${esc(hofTitle(h))}</i><span class="hof-li-t">${esc(h.tournament||'')}</span></span>
      ${h.note ? `<span class="hof-li-note">${esc(h.note)}</span>` : ''}
    </span>
    <span class="hof-li-meta">
      <span class="badge ${h.organizer==='other'?'badge-format':'badge-open'}">${esc(hofOrg(h))}</span>
      <span class="hof-li-date">${esc(hofDate(h)) || '—'}</span>
    </span>
    ${admin ? `<span class="hof-li-actions no-export">
      <button type="button" class="btn btn-ghost btn-icon" onclick="openHofModal('${h.id}')" aria-label="Edit achievement">${EDIT_SVG}</button>
      <button type="button" class="btn btn-ghost btn-icon" style="color:var(--danger-ink)" onclick="deleteHof('${h.id}')" aria-label="Delete achievement">${TRASH_SVG}</button>
    </span>` : ''}
  </div>`;
}

function hofFiltered(){
  return [...STORE.hof].sort(hofSort).filter(h=>
    (hofFilter.org==='all' || (hofFilter.org==='other' ? h.organizer==='other' : h.organizer!=='other')) &&
    (hofFilter.player==='all' || hofKey(h)===hofFilter.player));
}

function renderHallOfFame(){
  setHeader('Community', 'Hall of Fame');
  const admin = isAdmin();
  const all = [...STORE.hof].sort(hofSort);
  const tally = hofTally(all);
  const ranked = hofRanked(tally);
  const playerOpts = Object.values(tally).map(t=>({key:t.key, name:hofPlayer(t.h).name})).sort((a,b)=>a.name.localeCompare(b.name));
  if(hofFilter.player!=='all' && !tally[hofFilter.player]) hofFilter.player = 'all';
  const list = hofFiltered();
  const byYear = {};
  list.forEach(h=>{ const y = h.date ? String(h.date).slice(0,4) : 'Undated'; (byYear[y] = byYear[y] || []).push(h) });
  const years = Object.keys(byYear).sort((a,b)=> a==='Undated' ? 1 : b==='Undated' ? -1 : b.localeCompare(a));
  const completedWithPlacings = STORE.tournaments.filter(t=>t.status==='completed' && (t.champion||t.runnerUp||t.thirdPlace));
  const seg = (group, opts) => `<div class="segmented" role="group">${opts.map(([v,l])=>`<button type="button" class="seg ${hofFilter[group]===v?'active':''}" aria-pressed="${hofFilter[group]===v}" onclick="setHofFilter('${group}','${v}')">${l}</button>`).join('')}</div>`;

  document.getElementById('main').innerHTML = `
    <section class="hof-hero ${STORE.hofcover?.image?'has-cover':''}" ${cssUrl(STORE.hofcover?.image) ? `style="--cover:${cssUrl(STORE.hofcover.image)}"` : ''}>
      ${admin ? `<button type="button" class="hero-edit" onclick="openPicModal('hofcover')">${ICON.image}<span>${STORE.hofcover?.image?'Change picture':'Add picture'}</span></button>` : ''}
      <div class="hof-emblem">${ICON.hofEmblem}</div>
      <div class="hof-hero-text">
        <div class="hof-hero-title">Hall of Fame</div>
        <div class="hof-hero-sub">Podium finishes by ${esc(titleCase(commName()))} players, in our tournaments and other organisers' events.</div>
      </div>
      <div class="hof-hero-stats">
        <div><b>${all.filter(h=>h.type==='champion').length}</b><span>Champions</span></div>
        <div><b>${all.filter(h=>h.type==='runner_up').length}</b><span>Runners-up</span></div>
        <div><b>${all.filter(h=>h.type==='third').length}</b><span>Third place</span></div>
      </div>
    </section>

    ${ranked.length ? `<section class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="card-head" style="margin:0"><h2 class="card-title">Most decorated</h2><button type="button" class="btn-icon-square" onclick="exportDecoratedSheet()" aria-label="Export most decorated (image or PDF)" title="Export most decorated (image or PDF)">${ICON_DL}</button></div>
      <div class="decorated">
        ${ranked.slice(0,6).map((t,i)=>{ const p = hofPlayer(t.h); return `
          <button type="button" class="decorated-item ${hofFilter.player===t.key?'active':''}" data-key="${esc(hofFilter.player===t.key?'all':t.key)}" onclick="setHofFilter('player', this.dataset.key)" aria-pressed="${hofFilter.player===t.key}">
            ${rankBadge(t.rank, MEDAL_BY_RANK[t.rank], t.tied)}${renderAvatar(p,36)}
            <span class="grow"><b>${esc(p.name)}</b><span class="decorated-counts">${decoratedCounts(t)}</span></span>
          </button>`}).join('')}
      </div>
    </section>` : ''}

    <div class="hof-bar">
      <div class="hof-bar-filters">
        ${seg('org', [['all','All'],['ours',HOF_OUR_ORG],['other','Other organisers']])}
        <select class="form-select hof-player-select" aria-label="Filter by player" onchange="setHofFilter('player', this.value)">
          <option value="all">All players</option>
          ${playerOpts.map(o=>`<option value="${esc(o.key)}" ${hofFilter.player===o.key?'selected':''}>${esc(o.name)}</option>`).join('')}
        </select>
      </div>
      <div class="hof-bar-actions">
        ${list.length ? `<button type="button" class="btn-icon-square" onclick="exportHofSheet()" aria-label="Export (image or PDF)" title="Export (image or PDF)">${ICON_DL}</button>` : ''}
        ${admin && completedWithPlacings.length ? `<button type="button" class="btn btn-secondary" onclick="importHofFromTournaments()">Import</button>` : ''}
        ${admin ? `<button type="button" class="btn btn-primary" onclick="openHofModal()">${ICON.plus} Add</button>` : ''}
      </div>
    </div>

    <div id="hofList" style="display:flex;flex-direction:column;gap:20px">
    ${list.length===0 ? `<div class="card empty"><div class="empty-title">${all.length ? 'Nothing matches these filters' : 'The Hall of Fame is empty'}</div><div class="text-sm">${all.length ? 'Try another filter.' : admin ? 'Add the first achievement, or import champions from tournaments already finished in this app.' : 'Achievements appear here once the organisers add them.'}</div></div>` :
      years.map(y=>`<section class="hof-year"><div class="hof-year-label">${esc(y)}<span>${byYear[y].length}</span></div><div class="hof-list ${admin?'is-admin':''}">${byYear[y].map(h=>hofItem(h, admin)).join('')}</div></section>`).join('')}
    </div>`;
}

/* Most decorated: titles first, then runner-up, third place and awards. */
function hofTally(all){
  const tally = {};
  all.forEach(h=>{ const k = hofKey(h); const t = tally[k] = tally[k] || {key:k, h, champion:0, runner_up:0, third:0, award:0, total:0}; t[h.type in t ? h.type : 'award']++; t.total++ });
  return tally;
}
function hofRanked(tally){
  const list = Object.values(tally).sort((a,b)=> b.champion-a.champion || b.runner_up-a.runner_up || b.third-a.third || b.award-a.award || hofPlayer(a.h).name.localeCompare(hofPlayer(b.h).name));
  // Players with exactly the same record share the position (1, 2, 2, 2, 5 …).
  const same = (a,b) => a.champion===b.champion && a.runner_up===b.runner_up && a.third===b.third && a.award===b.award;
  list.forEach((x,i)=>{ x.rank = i && same(x, list[i-1]) ? list[i-1].rank : i+1 });
  list.forEach((x,i)=>{ x.tied = (i>0 && list[i-1].rank===x.rank) || (i<list.length-1 && list[i+1].rank===x.rank) });
  return list;
}
function decoratedCounts(t){
  return `${t.champion?`<i class="gold">${t.champion}× Champion</i>`:''}${t.runner_up?`<i class="silver">${t.runner_up}× Runner-up</i>`:''}${t.third?`<i class="bronze">${t.third}× 3rd</i>`:''}${t.award?`<i class="award">${t.award} award${t.award>1?'s':''}</i>`:''}`;
}
const DEC_PER_PAGE = 14;
function exportDecoratedSheet(){
  const ranked = hofRanked(hofTally([...STORE.hof]));
  if(!ranked.length){ toast('Nothing to export yet', true); return }
  const parts = chunk(ranked, DEC_PER_PAGE);
  const cell = (n, cls) => n ? `<span class="dec-n ${cls}">${n}</span>` : `<span class="dec-0">–</span>`;
  const pages = parts.map((part, i)=> sheetHeader(null, 'Most Decorated Players', `Hall of Fame · ${ranked.length} player${ranked.length===1?'':'s'}${parts.length>1?` · Page ${i+1} of ${parts.length}`:''} · ${fmtDate(new Date())}`)
    + `<div class="xs-card"><table class="lbx dec-table">
      <thead><tr><th>#</th><th class="l">Player</th><th>${medalHTML('gold','1',20)}<span>Champion</span></th><th>${medalHTML('silver','2',20)}<span>Runner-up</span></th><th>${medalHTML('bronze','3',20)}<span>Third</span></th><th>Awards</th><th>Total</th></tr></thead>
      <tbody>${part.map(t=>{ const p = hofPlayer(t.h); return `<tr class="${t.rank<=3?'top':''}">
        <td>${rankBadge(t.rank, MEDAL_BY_RANK[t.rank], t.tied)}</td>
        <td class="l"><span class="who">${renderAvatar(p, 34)}<span>${esc(p.name)}</span></span></td>
        <td>${cell(t.champion,'gold')}</td><td>${cell(t.runner_up,'silver')}</td><td>${cell(t.third,'bronze')}</td><td>${cell(t.award,'award')}</td>
        <td><span class="lbx-pts">${t.total}</span></td></tr>` }).join('')}</tbody></table></div>`
    + `<div class="xs-points">Ranked by titles, then runner-up finishes, third places and awards. Players with the same record share the position. Includes our tournaments and other organisers' events.</div>`
    + sheetFoot(i+1, parts.length));
  return renderSheets(pages, 900, 'most_decorated');
}

function setHofFilter(group, v){ hofFilter[group] = v; renderHallOfFame() }

function openHofModal(id){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const h0 = id ? STORE.hof.find(x=>x.id===id) : {type:'champion', organizer:'ours', date:String(new Date().getFullYear())};
  if(!h0) return;
  const h = {...h0, type: h0.type==='award' ? 'champion' : h0.type};
  const [yy, mm] = String(h.date||'').split('-');
  const thisYear = new Date().getFullYear();
  const years = []; for(let y=thisYear+1; y>=2015; y--) years.push(y);
  openModal(`
    <div class="modal-head"><div class="modal-title">${id?'Edit':'Add'} achievement</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label" for="h_player">Player</label>
        <select class="form-select" id="h_player" onchange="document.getElementById('h_name_wrap').classList.toggle('hidden', this.value!=='__other')">
          ${STORE.players.map(p=>`<option value="${p.id}" ${h.playerId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
          <option value="__other" ${id && !h.playerId ? 'selected' : ''}>Someone not in the player list…</option>
        </select>
      </div>
      <div class="form-group ${id && !h.playerId ? '' : 'hidden'}" id="h_name_wrap">
        <label class="form-label" for="h_name">Player name</label>
        <input class="form-input" id="h_name" maxlength="40" value="${esc(h.playerName||'')}" placeholder="e.g. FORMER PLAYER">
      </div>
      <div class="form-group">
        <span class="form-label">Achievement</span>
        <div class="hof-type-pick" role="radiogroup">
          ${Object.entries(HOF_TYPES).filter(([k])=>k!=='award').map(([k,t])=>`<label class="hof-type ${t.cls}"><input type="radio" name="h_type" value="${k}" ${h.type===k?'checked':''} onchange="hofTypeChanged()">${medalHTML(t.cls, t.medal, 34)}<span>${t.label}</span></label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="h_tournament">Tournament</label>
        <input class="form-input" id="h_tournament" maxlength="80" value="${esc(h.tournament||'')}" placeholder="e.g. Milandhoo Champions League Season 4">
      </div>
      <div class="form-group">
        <span class="form-label">Organised by</span>
        <div class="flex gap-8" style="flex-wrap:wrap">
          <label class="radio-pill"><input type="radio" name="h_org" value="ours" ${h.organizer!=='other'?'checked':''} onchange="document.getElementById('h_orgname_wrap').classList.add('hidden')">${HOF_OUR_ORG}</label>
          <label class="radio-pill"><input type="radio" name="h_org" value="other" ${h.organizer==='other'?'checked':''} onchange="document.getElementById('h_orgname_wrap').classList.remove('hidden')">Another organiser</label>
        </div>
      </div>
      <div class="form-group ${h.organizer==='other'?'':'hidden'}" id="h_orgname_wrap">
        <label class="form-label" for="h_orgname">Organiser name</label>
        <input class="form-input" id="h_orgname" maxlength="60" value="${esc(h.organizerName||'')}" placeholder="e.g. Maldives eSports Association">
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="h_month">Month (optional)</label>
          <select class="form-select" id="h_month"><option value="">—</option>${MONTHS.map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}" ${mm===String(i+1).padStart(2,'0')?'selected':''}>${m}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label class="form-label" for="h_year">Year</label>
          <select class="form-select" id="h_year">${years.map(y=>`<option value="${y}" ${String(y)===(yy||String(thisYear))?'selected':''}>${y}</option>`).join('')}<option value="" ${id && !yy?'selected':''}>Not sure</option></select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="h_note">Note (optional)</label>
        <textarea class="form-textarea" id="h_note" maxlength="300" placeholder="e.g. Beat AXE77 3–1 in the final">${esc(h.note||'')}</textarea>
      </div>
    </div>
    <div class="modal-foot">
      ${id ? `<button type="button" class="btn btn-ghost" style="margin-right:auto;color:var(--danger-ink)" onclick="deleteHof('${id}')">Delete</button>` : ''}
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveHof('${id||''}')">${id?'Save changes':'Add to Hall of Fame'}</button>
    </div>`);
  if(!STORE.players.length){ document.getElementById('h_player').value='__other'; document.getElementById('h_name_wrap').classList.remove('hidden') }
}
function hofTypeChanged(){}
function saveHof(id){
  const sel = document.getElementById('h_player').value;
  const other = sel==='__other';
  const playerName = other ? document.getElementById('h_name').value.trim() : '';
  if(other && !playerName){ toast('Enter the player name', true); return }
  const type = document.querySelector('input[name="h_type"]:checked')?.value || 'champion';
  const title = '';
  const tournament = document.getElementById('h_tournament').value.trim();
  if(!tournament){ toast('Enter the tournament name', true); return }
  const organizer = document.querySelector('input[name="h_org"]:checked')?.value==='other' ? 'other' : 'ours';
  const organizerName = organizer==='other' ? document.getElementById('h_orgname').value.trim() : '';
  if(organizer==='other' && !organizerName){ toast('Enter the organiser name', true); return }
  const y = document.getElementById('h_year').value, m = document.getElementById('h_month').value;
  const date = y ? (m ? `${y}-${m}` : y) : '';
  const note = document.getElementById('h_note').value.trim();
  const list = DB.get('hof');
  const entry = {playerId: other ? null : sel, playerName: other ? playerName : (STORE.players.find(p=>p.id===sel)?.name || ''), type, title, tournament, organizer, organizerName, date, note};
  if(id){ const i = list.findIndex(x=>x.id===id); if(i>=0) list[i] = {...list[i], ...entry, updatedAt:new Date().toISOString()} }
  else list.push({id:uid(), ...entry, createdAt:new Date().toISOString()});
  DB.set('hof', list.sort(hofSort));
  closeModal(); rerender(); toast(id ? 'Achievement updated' : 'Added to the Hall of Fame');
}
async function deleteHof(id){
  const h = STORE.hof.find(x=>x.id===id); if(!h) return;
  const ok = await confirmDialog('Delete achievement', `Remove "${hofTitle(h)} · ${h.tournament}" for ${hofPlayer(h).name} from the Hall of Fame?`, 'Delete');
  if(!ok) return;
  DB.set('hof', DB.get('hof').filter(x=>x.id!==id));
  rerender(); toast('Achievement removed');
}
async function importHofFromTournaments(){
  const list = DB.get('hof');
  const have = new Set(list.filter(h=>h.sourceId).map(h=>h.sourceId+':'+h.type));
  const add = [];
  STORE.tournaments.filter(t=>t.status==='completed').forEach(t=>{
    [['champion',t.champion],['runner_up',t.runnerUp],['third',t.thirdPlace]].forEach(([type,pid])=>{
      if(!pid || have.has(t.id+':'+type)) return;
      const d = t.completedAt || t.startDateTime || t.date || '';
      add.push({id:uid(), playerId:pid, playerName:playerName(pid), type, title:'', tournament:t.name, organizer:'ours', organizerName:'', date: d ? String(d).slice(0,7) : '', when: t.completedAt || '', note:'', sourceId:t.id, createdAt:new Date().toISOString()});
    });
  });
  if(!add.length){ toast('Every finished tournament is already in the Hall of Fame'); return }
  const ok = await confirmDialog('Import from our tournaments', `Add ${add.length} placing${add.length>1?'s':''} (champions, runners-up and third places) from tournaments finished in this app? You can edit or delete them afterwards.`, 'Import');
  if(!ok) return;
  DB.set('hof', list.concat(add).sort(hofSort));
  rerender(); toast(`Added ${add.length} achievement${add.length>1?'s':''}`);
}
const HOF_PER_PAGE = 12;
function exportHofSheet(){
  const list = hofFiltered();
  const parts = chunk(list, HOF_PER_PAGE);
  const pages = parts.map((part, i)=>{
    const body = `<div class="xs-card" style="padding:6px 18px"><div class="hof-list xs-list">${part.map(h=>hofItem(h,false)).join('')}</div></div>`;
    return sheetHeader(null, 'Hall of Fame', `${list.length} achievement${list.length===1?'':'s'}${parts.length>1?` · Page ${i+1} of ${parts.length}`:''} · ${fmtDate(new Date())}`) + body + sheetFoot(i+1, parts.length);
  });
  return renderSheets(pages, 900, 'hall_of_fame');
}

/* =========================
   LEADERBOARD
   ========================= */
function renderLeaderboard(){
  const stats = calculateAllStats();
  const enriched = rankPlayers(stats);
  const moves = rankMoves(enriched); enriched.forEach(x=>{ x.move = moves[x.p.id] || 0 });
  const nUp = enriched.filter(x=>x.move>0).length, nDown = enriched.filter(x=>x.move<0).length;
  const totalMatches = Math.round(enriched.reduce((s,x)=>s+x.s.matches,0)/2);
  const totalGoals = enriched.reduce((s,x)=>s+x.s.gf,0);
  const podium = [1,2,3].map(r=>enriched.filter(x=>x.rank===r && x.s.pts>0)).filter(g=>g.length);
  setHeader('Community', 'Leaderboard');
  document.getElementById('main').innerHTML = `
    <div class="grid grid-4">
      ${statTile('users','tint-blue','Players', STORE.players.length)}
      ${statTile('ball','tint-purple','Matches played', totalMatches)}
      ${statTile('goal','tint-green','Goals scored', totalGoals)}
      ${statTile('trophy','tint-gold','Completed', STORE.tournaments.filter(t=>t.status==='completed').length)}
    </div>
    ${podium.length ? `<section class="lb-podium" aria-label="Top three positions">${podium.map(lbPodCard).join('')}</section>` : ''}
    <section id="leaderboardExport" class="card lb-card" aria-label="Community leaderboard">
      <div class="lb-card-head">
        <div><h2 class="card-title">All-time ranking</h2><div class="flex gap-8" style="align-items:center;flex-wrap:wrap;margin-top:4px">${STORE.mode==='shared' ? `<span class="admin-indicator live-indicator">Live</span>` : ''}<span class="page-sub">Ranked by total points · updates as results are saved</span></div>
          ${updatedLine([moves.__newest ? `Last updated ${whenText(moves.__newest)}` : '', (nUp||nDown) ? `<span class="mv-sum">${moveBadge(1).replace('>1<','><')} ${nUp} up · ${moveBadge(-1).replace('>1<','><')} ${nDown} down since the latest results</span>` : ''])}</div>
        <button type="button" class="export-btn" onclick="exportAsJPEG('leaderboardExport','milandhoo_leaderboard')">${ICON_DL} Export leaderboard</button>
      </div>
      <div class="lbx-wrap">${lbTable(enriched, 0)}</div>
      ${lbLegend()}
      <div class="table-hint">Turn your phone sideways to see draws, losses, goals for and against, goal difference and titles.</div>
    </section>`;
}
const ORDINAL = {1:'1st', 2:'2nd', 3:'3rd'};
function lbPodCard(group){
  const r = group[0].rank, m = MEDAL_BY_RANK[r], lead = group[0], n = group.length;
  const stat = (v,l) => `<span><b>${v}</b>${l}</span>`;
  const head = `<div class="lb-pod-top"><span class="lb-pod-pos">${rankBadge(r, m)}${ORDINAL[r]}${n>1?' <i>· shared</i>':''}</span><span class="lb-pod-pts"><b>${lead.s.pts}</b><span>PTS</span></span></div>`;
  if(n===1) return `<div class="lb-pod p${r} ${m}">
    ${head}
    <div class="lb-pod-who">${renderAvatar(lead.p, 52)}<div class="lb-pod-name">${esc(lead.p.name)} ${moveBadge(lead.move)}</div></div>
    <div class="lb-pod-stats">${stat(lead.s.wins,'W')}${stat(lead.s.draws,'D')}${stat(lead.s.losses,'L')}${stat(Math.round(parseFloat(lead.s.winPct))+'%','Win')}${stat(lead.s.tourneyWins,'Titles')}</div>
  </div>`;
  // Shared position: everyone on these points, in table order.
  return `<div class="lb-pod p${r} ${m} tie">
    ${head}
    <div class="lb-pod-tied-note">${n} players share this position</div>
    <ul class="lb-pod-list">${group.map(x=>`<li>${renderAvatar(x.p, 30)}<span class="who2"><span class="nmrow"><span class="nm">${esc(x.p.name)}</span>${moveBadge(x.move)}${x.s.tourneyWins ? `<i>${x.s.tourneyWins} title${x.s.tourneyWins>1?'s':''}</i>` : ''}</span><span class="mini">${x.s.wins}W · ${x.s.draws}D · ${x.s.losses}L · ${Math.round(parseFloat(x.s.winPct))}%</span></span></li>`).join('')}</ul>
  </div>`;
}
function lbLegend(){
  const it = (l, v) => `<span><b>${v}</b>${l}</span>`;
  return `<div class="lb-legend">
    <div class="lb-legend-items">${it('Win','+3')}${it('Draw','+1')}${it('Loss','0')}${it('Knockout win bonus','+2')}${it('Champion','+20')}${it('Runner-up','+12')}${it('3rd','+7')}${it('4th','+4')}</div>
    <div class="lb-legend-note">Highest total points first. Players on equal points share the position (listed by win %, then total wins). Placing points are added when a tournament is completed; only a player's best placing in each tournament counts. Hall of Fame placings from before the app count too.</div>
  </div>`;
}

/* The leaderboard table: used on the page and, 10 players per page, in the export. */
function lbTable(rows, offset){
  return `
        <table class="lbx lb-table">
          <thead><tr><th scope="col">#</th><th scope="col" class="l">Player</th><th scope="col">P</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th><th scope="col">GF</th><th scope="col">GA</th><th scope="col">GD</th><th scope="col">Win %</th><th scope="col">Titles</th><th scope="col" class="pts">PTS</th></tr></thead>
          <tbody>
            ${rows.length===0 ? `<tr><td colspan="12" class="t-center text-muted" style="padding:40px">No players yet</td></tr>` :
              rows.map((x,j)=>{ const i = offset + j; const gd = x.s.gf-x.s.ga; const top = x.rank<=3 && x.s.pts>0; return `
                <tr class="${top?'top':''}" title="${x.s.ptsMatch} match pts + ${x.s.ptsKo} knockout bonus + ${x.s.ptsPlace} placing pts">
                  <td><span class="rk-wrap">${rankMark(x)}${moveBadge(x.move)}</span></td>
                  <td class="l"><span class="who">${renderAvatar(x.p, 34)}<span>${esc(x.p.name)}</span></span></td>
                  <td>${x.s.matches}</td><td>${x.s.wins}</td><td>${x.s.draws}</td><td>${x.s.losses}</td>
                  <td>${x.s.gf}</td><td>${x.s.ga}</td>
                  <td class="muted">${gd>0?'+':''}${gd}</td>
                  <td class="pct">${x.s.winPct}%</td>
                  <td>${x.s.tourneyWins>0 ? `<span class="lbx-title">${x.s.tourneyWins}</span>` : '<span class="dec-0">0</span>'}</td>
                  <td class="pts"><span class="lbx-pts">${x.s.pts}</span></td>
                </tr>`}).join('')}
          </tbody>
        </table>`;
}
const LB_PER_PAGE = 12;
function exportLeaderboardSheet(){
  EXPORT_CTX.scopes = [{id:'all', label:'All players'}, {id:'top10', label:'Top 10'}];
  const enriched = rankPlayers(calculateAllStats());
  const parts = chunk(enriched, LB_PER_PAGE);
  const pages = parts.map((part, i)=> sheetHeader(null, 'Community Leaderboard', `All-time ranking by total points · ${fmtDate(new Date())}${parts.length>1?` · Page ${i+1} of ${parts.length}`:''}`)
    + `<div class="xs-card" style="padding:8px 14px">${lbTable(part, i*LB_PER_PAGE)}</div>`
    + `<div class="xs-points"><b>${esc(PTS_LEGEND)}</b><br>${esc(PTS_RANKING)}</div>`
    + sheetFoot(i+1, parts.length));
  return renderSheets(pages, 900, 'milandhoo_leaderboard');
}

/* =========================
   TELEGRAM: players' own fixtures by private message
   The bot (@MGefootballbot) and its sending run on the server (supabase/functions/telegram).
   Draws send automatically; organisers can also resend from "Message players".
   ========================= */
const TG_BOT_LINK = 'https://t.me/MGefootballbot?start=link';
const TG_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.5 4.1 2.9 11.3c-1.3.5-1.2 2.3.1 2.6l4.6 1.4 1.8 5.6c.3 1 1.6 1.3 2.3.5l2.6-2.6 4.6 3.4c.9.6 2.1.1 2.3-.9l3.1-15.1c.3-1.4-1.1-2.6-2.8-2.1zM17 8.3l-7.6 6.9-.3 3.2-1.4-4.4L17 8.3z"/></svg>';
const WA_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>';
const SMS_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
let TG_MSG = {tid:null, players:[]};

async function tgCall(body){
  if(!AUTH.sb) throw new Error('Still connecting. Try again in a moment.');
  const {data, error} = await AUTH.sb.functions.invoke('telegram', {body});
  if(error) throw new Error(error.message || 'The server did not answer');
  if(data?.error) throw new Error(data.error);
  return data;
}
async function tgLinks(){
  if(!AUTH.sb) return null;
  const {data, error} = await AUTH.sb.from('telegram_links').select('player_id,tg_name,linked_at');
  return error ? null : new Map((data||[]).map(r=>[r.player_id, r]));
}
async function renderTgStatus(){
  const el = document.getElementById('tgStatus'); if(!el) return;
  const links = await tgLinks();
  if(!links){ el.innerHTML = '<span class="text-sm text-muted">Could not check linked players right now.</span>'; return }
  const not = STORE.players.filter(p=>!links.has(p.id)).sort((a,b)=>a.name.localeCompare(b.name));
  const n = STORE.players.length - not.length;
  el.innerHTML = `<div class="tg-meter"><div><b>${n}</b> of ${STORE.players.length} players linked</div><span class="tg-bar"><i style="width:${STORE.players.length ? Math.round(n/STORE.players.length*100) : 0}%"></i></span></div>
    ${not.length ? `<details class="tg-missing"><summary>Not linked yet (${not.length})</summary><div class="tg-chips">${not.map(p=>`<span>${esc(p.name)}${STORE.phones[p.id]?'':' <i>no number</i>'}</span>`).join('')}</div></details>` : '<span class="text-sm" style="color:var(--success-ink);font-weight:600">Everyone is linked.</span>'}`;
}

function waLink(phone, text){ const n = telegramNumber(phone); return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : '' }
function smsLink(phone, text){ const n = telegramNumber(phone); return n ? `sms:+${n}${/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)?'&':'?'}body=${encodeURIComponent(text)}` : '' }

async function openMessagePlayersModal(tid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid); if(!t) return;
  openModal(`<div class="modal-head"><div class="modal-title">Message players</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body"><div class="text-sm text-muted">Getting each player's fixtures…</div></div>`, 'lg');
  try{
    const data = await tgCall({action:'texts', tid});
    TG_MSG = {tid, players: data.players || []};
    renderMessagePlayers();
  }catch(e){
    const body = document.querySelector('#modal .modal-body'); if(body) body.innerHTML = `<div class="config-helper">Couldn't load the messages: ${esc(e.message)}</div>`;
  }
}
function renderMessagePlayers(){
  const t = STORE.tournaments.find(x=>x.id===TG_MSG.tid); if(!t) return;
  const rows = TG_MSG.players.map((x,i)=>({...x, i, p: STORE.players.find(p=>p.id===x.pid) || {name: playerName(x.pid)}})).sort((a,b)=> (a.linked===b.linked ? a.p.name.localeCompare(b.p.name) : a.linked ? 1 : -1));
  const linked = rows.filter(r=>r.linked && r.text).length;
  const body = document.querySelector('#modal .modal-body'); if(!body) return;
  body.innerHTML = `
    <div class="tg-hero">
      <div><p style="margin:0"><b>${linked} of ${rows.length}</b> players get their fixtures on Telegram automatically.</p><span>Everyone else: tap WhatsApp or SMS next to their name. Each message only has that player's own fixtures.</span></div>
      <button type="button" class="btn btn-primary" ${linked?'':'disabled'} onclick="sendTelegramFixtures('${t.id}')">${TG_SVG} Send to ${linked} on Telegram</button>
    </div>
    ${groupDeadlineAhead(t) ? `<div class="tg-hero tg-dl">
      <div><p style="margin:0"><b>Group deadline reminder</b></p><span>Sends each linked player who still has group matches to play their remaining fixtures, the deadline (${esc(fmtDateTime(t.groupDeadline))}) and the rules. It's also sent automatically at 18:00 on deadline day.</span></div>
      <button type="button" class="btn btn-primary" onclick="sendDeadlineReminder('${t.id}')">${ICON.alarm} Send reminder now</button>
    </div>` : ''}
    <div class="link-box"><input class="form-input" readonly value="${TG_BOT_LINK}" aria-label="Bot link" onclick="this.select()"><button type="button" class="btn btn-secondary" onclick="copyText('${TG_BOT_LINK}')">Copy bot link</button></div>
    <div class="msg-list">${rows.map(r=>{ const ph = STORE.phones[r.pid]; return `
      <div class="msg-row">
        ${renderAvatar(r.p, 34)}
        <div class="msg-main"><b>${esc(r.p.name)}</b>${r.text ? `<details><summary>Preview message</summary><pre>${esc(r.text)}</pre></details>` : '<span class="text-xs text-muted">No fixtures to send</span>'}</div>
        <div class="msg-acts">
          ${r.linked ? `<span class="tg-chip on">${TG_SVG} Telegram</span>` : ''}
          ${!r.linked && r.text && ph ? `<a class="btn btn-sm btn-wa" href="${esc(waLink(ph, r.text))}" target="_blank" rel="noopener">${WA_SVG} WhatsApp</a><a class="btn btn-sm btn-secondary" href="${esc(smsLink(ph, r.text))}">${SMS_SVG} SMS</a>` : ''}
          ${!r.linked && r.text && !ph ? `<span class="tg-chip">No number</span>` : ''}
          ${r.text ? `<button type="button" class="btn btn-sm btn-ghost" onclick="copyMessage(${r.i})" aria-label="Copy ${esc(r.p.name)}'s message">Copy</button>` : ''}
        </div>
      </div>`}).join('')}</div>`;
}
async function copyMessage(i){
  const x = TG_MSG.players[i]; if(!x?.text) return;
  try{ await navigator.clipboard.writeText(x.text); toast('Message copied') }catch{ toast('Copy is blocked here', true) }
}
function groupDeadlineAhead(t){
  return !!(t && t.status==='active' && t.format!=='single_elimination' && t.groupDeadline && !t.deadlineProcessed && new Date(t.groupDeadline) > new Date()
    && (t.fixtures||[]).some(f=>!(hasScore(f.score1) && hasScore(f.score2))));
}
async function sendDeadlineReminder(tid){
  const ok = await confirmDialog('Send deadline reminder', 'Send every linked player who still has group matches to play a Telegram reminder with their remaining fixtures, the deadline and the rules?', 'Send');
  if(!ok){ openMessagePlayersModal(tid); return }
  toast('Sending…');
  try{
    const r = await tgCall({action:'deadline', tid});
    toast(r.sent ? `Reminder sent to ${r.sent} player${r.sent===1?'':'s'} on Telegram${r.failed?` · ${r.failed} failed`:''}` : 'No linked players have group matches left to play', !!r.failed);
  }catch(e){ toast('Sending failed: ' + e.message, true) }
}
async function sendTelegramFixtures(tid){
  const linked = TG_MSG.players.filter(x=>x.linked && x.text).length;
  const ok = await confirmDialog('Send fixtures on Telegram', `Send ${linked} linked player${linked>1?'s':''} their own fixtures for this tournament now?`, 'Send');
  if(!ok){ openMessagePlayersModal(tid); return }
  toast('Sending…');
  try{
    const r = await tgCall({action:'send', tid});
    toast(`Sent to ${r.sent} player${r.sent===1?'':'s'} on Telegram${r.failed?` · ${r.failed} failed (they may have blocked the bot)`:''}`, !!r.failed);
  }catch(e){ toast('Sending failed: ' + e.message, true) }
}

/* =========================
   HEAD TO HEAD
   Every result between two players from live and completed tournaments:
   group/league fixtures, each knockout leg or game, and tie-breaker matches.
   ========================= */
let H2H = {a:null, b:null};
function h2hData(a, b){
  const ts = STORE.tournaments.filter(t=>t.status==='active' || t.status==='completed')
    .sort((x,y)=> String(y.completedAt||y.startedAt||y.createdAt||'').localeCompare(String(x.completedAt||x.startedAt||x.createdAt||'')));
  const matches = [], ties = [];
  ts.forEach(t=>{
    tournamentMatches(t).forEach(m=>{
      if(!((m.a===a && m.b===b) || (m.a===b && m.b===a))) return;
      const ga = m.a===a ? m.ga : m.gb, gb = m.a===a ? m.gb : m.ga;
      matches.push({t, stage:m.stage, ga, gb, home: m.a===a});
    });
    (t.knockoutBracket||[]).flat().forEach(m=>{
      if(!m || m.isBye || !m.winner) return;
      if(!((m.team1===a && m.team2===b) || (m.team1===b && m.team2===a))) return;
      ties.push({t, round:m.round, winner:m.winner});
    });
  });
  const res = {aw:0, d:0, bw:0, agf:0, bgf:0, acs:0, bcs:0};
  matches.forEach(m=>{ res.agf+=m.ga; res.bgf+=m.gb; if(m.ga>m.gb) res.aw++; else if(m.gb>m.ga) res.bw++; else res.d++; if(m.gb===0) res.acs++; if(m.ga===0) res.bcs++ });
  res.awp = matches.length ? Math.round(res.aw/matches.length*100) : 0;
  res.bwp = matches.length ? Math.round(res.bw/matches.length*100) : 0;
  const best = side => { const list = matches.filter(m=> side==='a' ? m.ga>m.gb : m.gb>m.ga); if(!list.length) return null; return list.slice().sort((x,y)=> Math.abs(y.ga-y.gb)-Math.abs(x.ga-x.gb) || (y.ga+y.gb)-(x.ga+x.gb))[0] };
  const stats = calculateAllStats(), ranked = rankPlayers(stats);
  const rankOf = id => ranked.find(x=>x.p.id===id)?.rank || '–';
  const both = ts.filter(t=>(t.registrations||[]).some(r=>r.playerId===a) && (t.registrations||[]).some(r=>r.playerId===b)).length;
  return {na: playerName(a), nb: playerName(b), matches, ties, res, bestA:best('a'), bestB:best('b'), sa:stats[a], sb:stats[b], rankA:rankOf(a), rankB:rankOf(b), both,
    koA: ties.filter(x=>x.winner===a).length, koB: ties.filter(x=>x.winner===b).length};
}
function h2hDefaults(){
  const ids = STORE.players.map(p=>p.id);
  if(!ids.includes(H2H.a) || !ids.includes(H2H.b) || H2H.a===H2H.b){
    const r = rankPlayers(calculateAllStats());
    H2H.a = ids.includes(H2H.a) ? H2H.a : r[0]?.p.id || null;
    H2H.b = (ids.includes(H2H.b) && H2H.b!==H2H.a) ? H2H.b : (r.find(x=>x.p.id!==H2H.a)?.p.id || null);
  }
}
function setH2H(side, id){ H2H[side] = id; if(H2H.a===H2H.b){ const other = STORE.players.find(p=>p.id!==id); H2H[side==='a'?'b':'a'] = other?.id || null } renderH2H() }
/* Type-to-search player picker: type part of a name, then tap a match (or press Enter for the first). */
function h2hPicker(side, label, p){
  return `<div class="h2h-sel"><span>${label}</span>
    <div class="h2h-combo">
      ${renderAvatar(p, 28)}
      <input class="form-input" id="h2h_${side}" value="${esc(p.name)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" name="h2h-pick-${side}-${Date.now()}" placeholder="Type a player name…" aria-label="${label} — type a player name"
        onfocus="this.select();h2hFilter('${side}', '')" oninput="h2hFilter('${side}', this.value)" onkeydown="h2hKey(event,'${side}')" onblur="setTimeout(()=>h2hClose('${side}', true), 150)">
      <svg class="h2h-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>
      <div class="h2h-drop" id="h2h_${side}_drop" role="listbox"></div>
    </div></div>`;
}
function h2hFilter(side, q){
  const d = document.getElementById(`h2h_${side}_drop`); if(!d) return;
  const other = side==='a' ? H2H.b : H2H.a;
  const k = String(q||'').trim().toLowerCase();
  const list = STORE.players.filter(p=>p.id!==other && (!k || p.name.toLowerCase().includes(k)))
    .sort((x,y)=> (k ? (x.name.toLowerCase().indexOf(k) - y.name.toLowerCase().indexOf(k)) : 0) || x.name.localeCompare(y.name));
  d.innerHTML = list.length ? list.map(p=>`<button type="button" class="sd-item" onmousedown="event.preventDefault()" onclick="setH2H('${side}','${p.id}')">${renderAvatar(p, 28)}<span class="sd-txt"><b>${esc(p.name)}</b></span></button>`).join('') : `<div class="sd-empty">No player matches “${esc(q)}”</div>`;
  d.classList.add('show');
}
function h2hClose(side, restore){
  document.getElementById(`h2h_${side}_drop`)?.classList.remove('show');
  if(restore){ const inp = document.getElementById(`h2h_${side}`), p = STORE.players.find(x=>x.id===H2H[side]); if(inp && p && document.activeElement!==inp) inp.value = p.name }
}
function h2hKey(e, side){
  if(e.key==='Enter'){ e.preventDefault(); document.querySelector(`#h2h_${side}_drop.show .sd-item`)?.click() }
  if(e.key==='Escape'){ h2hClose(side, true); e.target.blur() }
}
function swapH2H(){ [H2H.a, H2H.b] = [H2H.b, H2H.a]; renderH2H() }
const H2H_SWAP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4 3.5 7.5 7 11M3.5 7.5h13M17 13l3.5 3.5L17 20M20.5 16.5h-13"/></svg>';
function h2hBar(label, va, vb, fmt=v=>v, lowerIsBetter=false){
  const x = +va || 0, y = +vb || 0, tot = x + y;
  const pa = tot ? Math.round(x/tot*100) : 50;
  const lead = x===y ? '' : ((x>y) !== lowerIsBetter ? 'a' : 'b');
  return `<div class="h2h-row"><b class="${lead==='a'?'lead':''}">${fmt(va)}</b><div class="h2h-mid"><span>${label}</span><div class="h2h-bar"><i class="a" style="width:${pa}%"></i><i class="b" style="width:${100-pa}%"></i></div></div><b class="r ${lead==='b'?'lead':''}">${fmt(vb)}</b></div>`;
}
function h2hVsBody(D){
  const r = D.res, n = D.matches.length;
  if(!n) return `<div class="st-empty">No results between these two players yet in live or completed tournaments.</div>`;
  return `<div class="h2h-chips"><span><b>${n}</b>Matches</span><span><b>${r.d}</b>Draws</span>${D.ties.length?`<span><b>${D.ties.length}</b>Knockout ties</span>`:''}</div>
    <div class="h2h-bars">
    ${h2hBar('Wins', r.aw, r.bw)}
    ${h2hBar('Win rate', r.awp, r.bwp, v=>v+'%')}
    ${h2hBar('Goals scored', r.agf, r.bgf)}
    ${h2hBar('Goals per match', r.agf/n, r.bgf/n, v=>(Math.round(v*10)/10).toFixed(1))}
    ${h2hBar('Clean sheets', r.acs, r.bcs)}
    ${D.ties.length ? h2hBar('Knockout ties won', D.koA, D.koB) : h2hBar('Draws', r.d, r.d)}
    </div>
    <div class="h2h-best">
      <div><span>${esc(D.na)} · biggest win</span><b>${D.bestA ? `${D.bestA.ga}–${D.bestA.gb}` : '–'}</b><small>${D.bestA ? esc(D.bestA.t.name) : 'No wins yet'}</small></div>
      <div class="r"><span>${esc(D.nb)} · biggest win</span><b>${D.bestB ? `${D.bestB.gb}–${D.bestB.ga}` : '–'}</b><small>${D.bestB ? esc(D.bestB.t.name) : 'No wins yet'}</small></div>
    </div>`;
}
function h2hCareerBody(D){
  return `<div class="h2h-bars">${h2hBar('Titles', D.sa.tourneyWins, D.sb.tourneyWins)}
    ${h2hBar('Runner-up', D.sa.tourneyRunnerUp, D.sb.tourneyRunnerUp)}
    ${h2hRankRow(D.rankA, D.rankB)}
    ${h2hBar('Ranking points', D.sa.pts, D.sb.pts)}
    ${h2hBar('Matches played', D.sa.matches, D.sb.matches)}
    ${h2hBar('Matches won', D.sa.wins, D.sb.wins)}</div>`;
}
/* Leaderboard position: the better (lower) rank is highlighted. */
function h2hRankRow(a, b){
  const lead = a===b ? '' : (a<b ? 'a' : 'b');
  return `<div class="h2h-row"><b class="${lead==='a'?'lead':''}">#${a}</b><div class="h2h-mid"><span>Leaderboard rank</span><div class="h2h-rank"><i class="${lead==='a'?'on a':''}"></i><i class="${lead==='b'?'on b':''}"></i></div></div><b class="r ${lead==='b'?'lead':''}">#${b}</b></div>`;
}
function renderH2H(){
  setHeader('Community', 'Head to Head');
  h2hDefaults();
  const main = document.getElementById('main');
  if(STORE.players.length<2){ main.innerHTML = `<div class="card empty"><div class="empty-title">Add at least two players</div><div class="text-sm">Head to head compares two players.</div></div>`; return }
  const pa = STORE.players.find(p=>p.id===H2H.a), pb = STORE.players.find(p=>p.id===H2H.b);
  const opts = sel => STORE.players.slice().sort((x,y)=>x.name.localeCompare(y.name)).map(p=>`<option value="${p.id}" ${p.id===sel?'selected':''}>${esc(p.name)}</option>`).join('');
  const D = h2hData(H2H.a, H2H.b), r = D.res, n = D.matches.length;
  const pct = v => v + '%';
  const winPct = s => Math.round(parseFloat(s?.winPct||0));
  main.innerHTML = `
    <div class="h2h-top"><span class="page-sub">Compare two players across all live and completed tournaments</span><button type="button" class="export-btn" onclick="exportH2H()">${ICON_DL} Export</button></div>
    <section class="card h2h-pick">
      ${h2hPicker('a', 'Player', pa)}
      <button type="button" class="btn btn-secondary btn-icon h2h-swap" onclick="swapH2H()" aria-label="Swap players" title="Swap players">${H2H_SWAP}</button>
      ${h2hPicker('b', 'Against', pb)}
    </section>

    <section class="h2h-hero">
      <div class="h2h-side a">${renderAvatar(pa, 84)}<b>${esc(pa.name)}</b><span>Rank #${D.rankA}</span></div>
      <div class="h2h-score">
        <div class="h2h-big"><b>${r.aw}</b><i>–</i><b>${r.d}</b><i>–</i><b>${r.bw}</b></div>
        <div class="h2h-lbl"><span>Wins</span><span>Draws</span><span>Wins</span></div>
        <div class="h2h-sub">${n ? `${n} match${n>1?'es':''} against each other` : 'They have not played each other yet'}${D.ties.length ? ` · knockout ties ${D.koA}–${D.koB}` : ''}</div>
      </div>
      <div class="h2h-side b">${renderAvatar(pb, 84)}<b>${esc(pb.name)}</b><span>Rank #${D.rankB}</span></div>
    </section>

    <section class="card h2h-card">
      <div class="h2h-card-h">${statIco('h2hvs','blue')}<b>Against each other</b></div>
      ${h2hVsBody(D)}
    </section>
    <section class="card h2h-card">
      <div class="h2h-card-h">${statIco('wins','gold')}<b>Career comparison</b></div>
      ${h2hCareerBody(D)}
    </section>

    <section class="card h2h-card">
      <div class="h2h-card-h">${statIco('matches','purple')}<b>Match results</b></div>
      ${n ? `<div class="h2h-list">${D.matches.map(m=>`<div class="h2h-m">
          <span class="h2h-m-a ${m.ga>m.gb?'w':''}">${esc(pa.name)}</span>
          <span class="result-pill">${m.ga} – ${m.gb}</span>
          <span class="h2h-m-b ${m.gb>m.ga?'w':''}">${esc(pb.name)}</span>
          <small>${esc(m.t.name)} · ${esc(m.stage)}</small>
        </div>`).join('')}</div>` : `<div class="st-empty">Matches between ${esc(pa.name)} and ${esc(pb.name)} will appear here.</div>`}
      <div class="text-xs text-muted">From live and completed tournaments. Played in ${D.both} tournament${D.both===1?'':'s'} together.</div>
    </section>`;
}
function exportH2H(){
  const pa = STORE.players.find(p=>p.id===H2H.a), pb = STORE.players.find(p=>p.id===H2H.b);
  if(!pa || !pb) return;
  const D = h2hData(H2H.a, H2H.b), r = D.res, n = D.matches.length;
  const winPct = s => Math.round(parseFloat(s?.winPct||0));
  const hero = `<div class="fb-h2h-hero"><div class="s">${renderAvatar(pa, 96)}<b>${esc(pa.name)}</b></div>
      <div class="m"><div class="big"><b>${r.aw}</b><i>–</i><b>${r.d}</b><i>–</i><b>${r.bw}</b></div><div class="lbl"><span>Wins</span><span>Draws</span><span>Wins</span></div><div class="sub">${n} match${n===1?'':'es'}${D.ties.length?` · knockout ties ${D.koA}–${D.koB}`:''}</div></div>
      <div class="s">${renderAvatar(pb, 96)}<b>${esc(pb.name)}</b></div></div>`;
  const comp = `<div class="fb-h2h-cards"><div class="fb-card fb-h2h-comp"><div class="fb-h2h-h">Against each other</div>${h2hVsBody(D)}</div>
    <div class="fb-card fb-h2h-comp"><div class="fb-h2h-h">Career comparison</div>${h2hCareerBody(D)}</div></div>`;
  const rows = D.matches.map(m=>`<div class="fbf"><span class="a ${m.ga>m.gb?'w':''}">${esc(pa.name)}</span><span class="sc">${m.ga} – ${m.gb}</span><span class="b ${m.gb>m.ga?'w':''}">${esc(pb.name)}</span></div><div class="fb-h2h-st">${esc(m.t.name)} · ${esc(m.stage)}</div>`);
  const title = `${pa.name} vs ${pb.name}`;
  const first = fbSheet(null, title, 'Head to head · live and completed tournaments', hero + comp, 1, 1);
  const more = n ? fbPack(D.matches.map((_,i)=>rows[i]), (set, i, k)=>fbSheet(null, title, 'Head to head · match results', `<div class="fb-card"><div class="fb-md">Match results</div>${set.join('')}</div>`, i+1, k)) : [];
  EXPORT_CTX.zPerPage = true;
  return renderSheets(fbRenumber([first, ...more]), FB.w, `h2h_${slug(pa.name)}_vs_${slug(pb.name)}`);
}

/* =========================
   ADMIN
   ========================= */
function renderAdmin(){
  setTimeout(()=>{ if(document.getElementById('tgStatus')) renderTgStatus() }, 0);
  const main = document.getElementById('main');
  setHeader('Community', 'Admin Panel');
  const mark = communityMark(64);
  if(STORE.resetMode && AUTH.user){ renderResetPassword(main, mark); return }
  if(!STORE.admin){ if(!AUTH.sb && !STORE.live){ renderSkeleton(); setHeader('Community', 'Admin Panel'); return } renderSignIn(main, mark); return }
  if(!STORE.live){ main.innerHTML = `<div class="card empty"><div class="empty-title">Loading organiser tools…</div><div class="text-sm">Getting the latest data first, so nothing is saved from an older copy.</div></div>`; return }
  const live = STORE.tournaments.filter(t=>t.status==='active').length;
  main.innerHTML = `
    <div class="toolbar">
      <div class="flex gap-8" style="align-items:center;flex-wrap:wrap"><span class="admin-indicator">Admin mode</span><span class="page-sub">Signed in · changes appear for everyone instantly</span></div>
      <div class="toolbar-actions">
        <button type="button" class="btn btn-secondary" onclick="exportData()">Export backup</button>
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('importFile').click()">Import backup</button>
        <input type="file" id="importFile" style="display:none" accept=".json,application/json" onchange="importData(event)">
        <button type="button" class="btn btn-danger" onclick="signOut()">Sign out</button>
      </div>
    </div>
    <div class="grid grid-4">
      ${statTile('users','tint-blue','Players', STORE.players.length)}
      ${statTile('trophy','tint-gold','Tournaments', STORE.tournaments.length)}
      ${statTile('clock','tint-orange','Live now', live)}
      ${statTile('check','tint-green','Completed', STORE.tournaments.filter(t=>t.status==='completed').length)}
    </div>
    <div class="grid grid-2">
      <section class="card" style="display:flex;flex-direction:column;gap:12px">
        <h2 class="card-title">Players</h2>
        <p class="page-sub">Add, edit and remove player profiles with photos.</p>
        <div class="toolbar-actions" style="margin-top:auto"><button type="button" class="btn btn-primary" onclick="openPlayerModal()">${ICON.plus} New player</button><button type="button" class="btn btn-secondary" onclick="navigate('players')">Manage</button></div>
      </section>
      <section class="card" style="display:flex;flex-direction:column;gap:12px">
        <h2 class="card-title">Tournaments</h2>
        <p class="page-sub">Create tournaments, enter scores and draw brackets.</p>
        <div class="toolbar-actions" style="margin-top:auto"><button type="button" class="btn btn-primary" onclick="openCreateTournament()">${ICON.plus} New tournament</button><button type="button" class="btn btn-secondary" onclick="navigate('tournaments')">Manage</button></div>
      </section>
      <section class="card tg-card" style="display:flex;flex-direction:column;gap:12px">
        <h2 class="card-title">${TG_SVG} Telegram fixtures bot</h2>
        <p class="page-sub">Players open the bot once, tap <b>Start</b> and share their phone number. It's matched with the number saved for them, then their groups, fixtures and deadline reminders arrive privately on Telegram whenever a draw is made.</p>
        <div class="link-box"><input class="form-input" readonly value="${TG_BOT_LINK}" aria-label="Bot link" onclick="this.select()"><button type="button" class="btn btn-primary" onclick="copyText('${TG_BOT_LINK}')">Copy link</button></div>
        <div id="tgStatus" class="tg-status"><span class="text-sm text-muted">Checking who has linked…</span></div>
      </section>
      <section class="card" style="display:flex;flex-direction:column;gap:12px">
        <h2 class="card-title">Branding</h2>
        <div><div class="page-sub">Community name</div><div class="brand-name" style="font-size:24px">${esc(commName())}</div>${commTag()?`<div class="brand-sub">${esc(commTag())}</div>`:''}</div>
        <div class="flex gap-16" style="align-items:center;flex-wrap:wrap">
          ${communityMark(72)}
          <div class="cover-thumb" style="${cssUrl(STORE.cover?.image)?`background-image:${cssUrl(STORE.cover.image)}`:''}">${STORE.cover?.image?'':'<span>Default banner</span>'}</div>
          <p class="page-sub" style="flex:1;min-width:180px">The logo appears in the sidebar, the phone header and exported images. The cover picture fills the dashboard banner.</p>
        </div>
        <details class="size-table">
          <summary>Recommended image sizes</summary>
          <dl>${Object.values(IMG_SIZES).map(x=>`<div><dt>${x.label}</dt><dd><b>${x.w} × ${x.h} px</b><span>${x.ratio}</span></dd></div>`).join('')}</dl>
        </details>
        <div class="toolbar-actions" style="margin-top:auto"><button type="button" class="btn btn-primary" onclick="openCommunityLogoModal()">Change logo</button><button type="button" class="btn btn-secondary" onclick="openCoverModal()">Change cover picture</button><button type="button" class="btn btn-secondary" onclick="openNameModal()">Change name</button><button type="button" class="btn btn-secondary" onclick="openSideCardModal()">Change sidebar picture</button><button type="button" class="btn btn-secondary" onclick="openPicModal('hofcover')">Change Hall of Fame picture</button></div>
      </section>
      ${organisersCardHTML()}
    </div>`;
  renderOrganiserList();
}

function openCommunityLogoModal(){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const st = STORE.settings || {};
  openModal(`
    <div class="modal-head"><div class="modal-title">Community logo</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      ${imageFieldHTML('clogo', 'Logo', 'PNG with a transparent background works best. Drag and zoom to fit it in the square. Remove it to go back to the default mark.')}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveCommunityLogo()">Save logo</button>
    </div>`);
  initImageField('clogo', LOGO_OPTS, st.logo ? {image:st.logo, src:st.logoSrc, crop:st.logoCrop} : null);
}
const COVER_OPTS = {shape:'wide', fit:'cover', aspect:3, out:1500, maxChars:230000, srcMax:2000, keepSrc:false, rec:IMG_SIZES.cover};
function openCoverModal(){
  if(!isAdmin()){ toast('Admin access required', true); return }
  openModal(`
    <div class="modal-head"><div class="modal-title">Dashboard cover picture</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      ${imageFieldHTML('cover', 'Cover picture', 'A wide photo works best, like a team shot or a match screenshot. Drag and zoom to frame it. A dark blue shade is added on the left so the title stays readable, and phones show the middle of the picture.', true)}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveCoverFromModal()">Save cover</button>
    </div>`, 'lg');
  initImageField('cover', COVER_OPTS, STORE.cover?.image ? {image:STORE.cover.image} : null);
}
const SIDE_OPTS = {shape:'wide', fit:'cover', aspect:1.2, out:720, maxChars:200000, srcMax:1600, keepSrc:false, rec:IMG_SIZES.side};
function openSideCardModal(){
  if(!isAdmin()){ toast('Admin access required', true); return }
  openModal(`
    <div class="modal-head"><div class="modal-title">Sidebar card picture</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      ${imageFieldHTML('side', 'Picture behind "Play · Compete · Belong"', 'A team photo or trophy shot works well. A dark blue shade is added so the words stay readable. Remove it to go back to plain navy.', true)}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveSideCardFromModal()">Save picture</button>
    </div>`);
  initImageField('side', SIDE_OPTS, STORE.sidecard?.image ? {image:STORE.sidecard.image} : null);
}
function saveSideCardFromModal(){
  const v = imageFieldValue('side');
  if(v===undefined){ closeModal(); return }
  saveSideCard(v ? v.image : null);
  closeModal(); rerender();
  toast(v ? 'Sidebar picture updated' : 'Sidebar picture removed');
}
function saveCoverFromModal(){
  const v = imageFieldValue('cover');
  if(v===undefined){ closeModal(); return }
  saveCover(v ? v.image : null);
  closeModal();
  rerender();
  toast(v ? 'Cover picture updated' : 'Cover picture removed · back to the default banner');
}

function openNameModal(){
  if(!isAdmin()){ toast('Admin access required', true); return }
  openModal(`
    <div class="modal-head"><div class="modal-title">Community name</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label" for="c_name">Name</label><input class="form-input" id="c_name" maxlength="24" value="${esc(commName())}" placeholder="e.g. MG EFOOTBALL" oninput="previewName()"></div>
      <div class="form-group"><label class="form-label" for="c_tag">Line under the name (optional)</label><input class="form-input" id="c_tag" maxlength="40" value="${esc(commTag())}" placeholder="e.g. eFOOTBALL COMMUNITY" oninput="previewName()"></div>
      <div class="name-preview" aria-hidden="true">${communityMark(44)}<div><div class="brand-name" id="np_name"></div><div class="brand-sub" id="np_tag"></div></div></div>
      <div class="text-sm text-muted" style="margin-top:12px">Shown in the sidebar, the dashboard banner, the footer and every exported image. Capital letters look best on the banner.</div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-ghost" style="margin-right:auto" onclick="c_name.value='MG EFOOTBALL';c_tag.value='eFOOTBALL COMMUNITY';previewName()">Use default</button>
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveName()">Save name</button>
    </div>`);
  previewName();
}
function previewName(){
  document.getElementById('np_name').textContent = document.getElementById('c_name').value.trim() || 'MG EFOOTBALL';
  document.getElementById('np_tag').textContent = document.getElementById('c_tag').value.trim();
}
function saveName(){
  const name = document.getElementById('c_name').value.trim().replace(/\s+/g,' ');
  const tagline = document.getElementById('c_tag').value.trim().replace(/\s+/g,' ');
  if(!name){ toast('Enter a community name', true); return }
  saveSettings({name, tagline});
  closeModal(); rerender(); toast('Community name updated');
}

function saveCommunityLogo(){
  const v = imageFieldValue('clogo');
  if(v===undefined){ closeModal(); return }
  if(v===null) saveSettings({logo:null, logoSrc:null, logoCrop:null, appIcons:null});
  else saveSettings({logo:v.image, logoSrc:v.src, logoCrop:v.crop});
  scheduleOffload(800);
  closeModal();
  rerender();
  toast(v ? 'Community logo updated' : 'Community logo removed');
}

/* =========================
   ADMIN PIN LOCK
   Admin tools stay locked until the organiser PIN is entered in this tab.
   Only a salted SHA-256 hash is stored: shared mode under data/private (organisers-only),
   local mode in this browser. Unlock lasts for this browser tab session.
   ========================= */
const PIN_DOC = 'data/private/config/pin';
const SS = {
  get(k){ try{ return sessionStorage.getItem('mec_'+k) }catch{ return null } },
  set(k,v){ try{ v===null ? sessionStorage.removeItem('mec_'+k) : sessionStorage.setItem('mec_'+k, v) }catch{} }
};
let pinFails = 0, pinBlockedUntil = 0;

async function hashPin(pin, salt){
  const data = new TextEncoder().encode(`milandhoo:${salt}:${pin}`);
  if(window.crypto && crypto.subtle){
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  let h = 2166136261; for(const b of data){ h ^= b; h = Math.imul(h, 16777619) >>> 0 } return 'f'+h.toString(16);
}
function randomSalt(){ const a = new Uint8Array(12); (window.crypto||{}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_,i)=>a[i]=Math.random()*256|0); return [...a].map(b=>b.toString(16).padStart(2,'0')).join('') }
const validPin = p => /^\d{4,8}$/.test(p);

function canManage(){ return !!STORE.admin }
function isUnlocked(){ return !!STORE.live }

function loadPinShared(db){
  STORE.pinLoaded = false;
  db.doc(PIN_DOC).onSnapshot(snap=>{
    STORE.pin = snap.exists ? clone(snap.data()) : null;
    STORE.pinLoaded = true;
    if(STORE.loaded.players && STORE.loaded.tournaments) scheduleRender();
  }, ()=>{ STORE.pinLoaded = true; scheduleRender() });
}
function loadPinLocal(){ STORE.pin = LS.get('pin', null); STORE.pinLoaded = true }
function storePin(pin){
  STORE.pin = pin;
  if(STORE.mode==='shared') queueWrite(PIN_DOC, ()=> pin ? STORE.db.doc(PIN_DOC).set(clone(pin)) : STORE.db.doc(PIN_DOC).delete());
  else LS.set('pin', pin);
}

async function createPin(){
  const a = document.getElementById('pin_new').value.trim(), b = document.getElementById('pin_conf').value.trim();
  if(!validPin(a)){ toast('Use 4 to 8 digits for the PIN', true); return }
  if(a!==b){ toast('The two PINs do not match', true); return }
  const salt = randomSalt(), hash = await hashPin(a, salt);
  storePin({salt, hash, setAt:new Date().toISOString()});
  SS.set('unlock', hash);
  toast('PIN created · admin unlocked');
  rerender();
}
async function unlockAdmin(){
  const input = document.getElementById('pin_enter');
  if(Date.now() < pinBlockedUntil){ toast(`Too many wrong tries. Wait ${Math.ceil((pinBlockedUntil-Date.now())/1000)} seconds.`, true); return }
  const pin = input.value.trim();
  if(!pin) { input.focus(); return }
  const hash = await hashPin(pin, STORE.pin.salt);
  if(hash===STORE.pin.hash){ pinFails = 0; SS.set('unlock', hash); toast('Admin unlocked'); rerender(); return }
  pinFails++; input.value = ''; input.focus();
  if(pinFails>=5){ pinBlockedUntil = Date.now()+30000; pinFails = 0; toast('Wrong PIN 5 times. Try again in 30 seconds.', true) }
  else toast(`Wrong PIN. ${5-pinFails} tr${5-pinFails===1?'y':'ies'} left before a short pause.`, true);
}
function lockAdmin(){ SS.set('unlock', null); closeModal(); toast('Admin locked'); navigate('admin') }

function openChangePin(){
  openModal(`
    <div class="modal-head"><div class="modal-title">Change admin PIN</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label" for="cp_old">Current PIN</label><input class="form-input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="cp_old"></div>
      <div class="form-group"><label class="form-label" for="cp_new">New PIN (4–8 digits)</label><input class="form-input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="cp_new"></div>
      <div class="form-group"><label class="form-label" for="cp_conf">Repeat new PIN</label><input class="form-input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="cp_conf" onkeydown="if(event.key==='Enter')changePin()"></div>
      <div class="text-sm text-muted">${STORE.mode==='shared'?'The new PIN works for every organiser. Anyone unlocked with the old PIN is locked out until they enter the new one.':'The new PIN is saved in this browser.'}</div>
    </div>
    <div class="modal-foot"><button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button><button type="button" class="btn btn-primary" onclick="changePin()">Change PIN</button></div>`);
  setTimeout(()=>document.getElementById('cp_old')?.focus(), 50);
}
async function changePin(){
  const old = document.getElementById('cp_old').value.trim(), np = document.getElementById('cp_new').value.trim(), conf = document.getElementById('cp_conf').value.trim();
  if(await hashPin(old, STORE.pin.salt) !== STORE.pin.hash){ toast('Current PIN is wrong', true); return }
  if(!validPin(np)){ toast('Use 4 to 8 digits for the new PIN', true); return }
  if(np!==conf){ toast('The new PINs do not match', true); return }
  const salt = randomSalt(), hash = await hashPin(np, salt);
  storePin({salt, hash, setAt:new Date().toISOString()});
  SS.set('unlock', hash);
  closeModal(); rerender(); toast('PIN changed');
}
async function resetPin(){
  const ok = await confirmDialog('Reset admin PIN', 'Remove the current PIN? The next organiser to open the Admin Panel will be asked to create a new one.', 'Reset PIN');
  if(!ok) return;
  storePin(null); SS.set('unlock', null); rerender(); toast('PIN removed · create a new one');
}

/* Returns true when it rendered a gate instead of the admin panel. */
function renderPinGate(main, mark){
  if(STORE.mode==='shared' && !STORE.pinLoaded){
    main.innerHTML = `<div class="card empty"><div class="empty-title">Checking admin lock…</div></div>`; return true;
  }
  if(!STORE.pin || !STORE.pin.hash){
    main.innerHTML = `
      <div class="login-wrap"><div class="login-card">
        <div class="login-brand">${mark}<h1>Create admin PIN</h1><p>Set a 4–8 digit PIN. You'll need it to open the Admin Panel and to edit players, tournaments and results.</p></div>
        <div class="form-group"><label class="form-label" for="pin_new">New PIN</label><input class="form-input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="pin_new" placeholder="••••"></div>
        <div class="form-group"><label class="form-label" for="pin_conf">Repeat PIN</label><input class="form-input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="pin_conf" placeholder="••••" onkeydown="if(event.key==='Enter')createPin()"></div>
        <button type="button" class="btn btn-primary btn-block" onclick="createPin()">Create PIN and unlock</button>
        <div class="text-xs text-muted" style="text-align:center;margin-top:14px">${STORE.mode==='shared'?'Every organiser uses this same PIN. You can change it later in the Admin Panel.':'Saved in this browser. You can change it later in the Admin Panel.'}</div>
      </div></div>`;
    setTimeout(()=>document.getElementById('pin_new')?.focus(), 50);
    return true;
  }
  if(!isUnlocked()){
    main.innerHTML = `
      <div class="login-wrap"><div class="login-card">
        <div class="login-brand">${mark}<h1>Admin locked</h1><p>Enter the organiser PIN to manage players, tournaments and results.</p></div>
        <div class="form-group"><label class="form-label" for="pin_enter">PIN</label><input class="form-input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="pin_enter" placeholder="••••" onkeydown="if(event.key==='Enter')unlockAdmin()"></div>
        <button type="button" class="btn btn-primary btn-block" onclick="unlockAdmin()">Unlock</button>
        <div class="text-xs text-muted" style="text-align:center;margin-top:14px">Forgot the PIN? ${STORE.mode==='shared' ? (STORE.owner ? `As the page owner you can <button type="button" class="btn-link" style="font-size:12px" onclick="resetPin()">reset it</button>.` : 'Ask the page owner to reset it.') : 'It can only be removed by clearing this site\'s data in your browser.'}</div>
      </div></div>`;
    setTimeout(()=>document.getElementById('pin_enter')?.focus(), 50);
    return true;
  }
  return false;
}

function exportData(){
  const data = { app:'milandhoo-efootball', players: STORE.players, tournaments: STORE.tournaments, hallOfFame: STORE.hof, phones: STORE.phones, settings:{community:STORE.settings, cover:STORE.cover, sidecard:STORE.sidecard, hofcover:STORE.hofcover}, exportedAt: new Date().toISOString() };
  saveFile(`milandhoo-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2));
}

function importData(e){
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async ev=>{
    let data;
    try{ data = JSON.parse(ev.target.result) }catch{ toast('That file is not a valid backup (.json)', true); return }
    if(!Array.isArray(data.players) || !Array.isArray(data.tournaments)){ toast('That file is not a backup from this app', true); return }
    const ok = await confirmDialog('Import backup', `Replace current data with ${data.players.length} players and ${data.tournaments.length} tournaments from this backup? Anything not in the backup will be removed.`, 'Import');
    if(!ok) return;
    const validId = id => typeof id==='string' && /^[A-Za-z0-9_\-.~:@+]{1,120}$/.test(id) && id!=='.' && id!=='..';
    const players = data.players.filter(p=>p && validId(p.id) && p.name);
    const tournaments = data.tournaments.filter(t=>t && validId(t.id) && t.name).map(migrateTournament);
    DB.set('players', players);
    DB.set('tournaments', tournaments);
    if(Array.isArray(data.hallOfFame)) DB.set('hof', data.hallOfFame.filter(h=>h && validId(h.id) && (h.playerId || h.playerName)).sort(hofSort));
    if(data.phones && typeof data.phones==='object') Object.entries(data.phones).forEach(([pid, ph])=>{ if(validId(pid) && typeof ph==='string' && players.some(p=>p.id===pid)) setPhone(pid, ph.slice(0,24)) });
    if(data.settings && typeof data.settings==='object'){
      const st = data.settings;
      if(st.community && typeof st.community==='object'){ STORE.settings = clone(st.community); queueWrite('settings/community', ()=>STORE.db.doc('settings/community').set(clone(STORE.settings))) }
      ['cover','sidecard','hofcover'].forEach(k=>{ const v = st[k]; if(v && typeof v.image==='string' && isImgSrc(v.image)) savePicDoc(k, v.image) });
    }
    rerender();
    toast('Backup imported');
  };
  reader.readAsText(file);
}

/* Older backups stored group stats by hand and fixtures without ids. */
function migrateTournament(t){
  (t.fixtures||[]).forEach(f=>{ if(!f.id) f.id = uid(); delete f.previousStats; delete f.played });
  if(t.format==='league' && t.groupsDrawn && !(t.fixtures||[]).length) t.fixtures = buildFixtures(t);
  if(t.knockoutBracket) propagateBracket(t.knockoutBracket);
  return t;
}

/* Shorter search hint on narrow phones, so it isn't cut off. */
(function(){
  const set = ()=>{ const el = document.getElementById('globalSearch'); if(!el) return;
    el.placeholder = window.innerWidth < 400 ? 'Search players, tournaments' : 'Search players or tournaments…';
    if(window.innerWidth < 340) el.placeholder = 'Search…' };
  set(); window.addEventListener('resize', set, {passive:true});
})();

/* =========================
   THEME: Light, Dark, or Auto (follows the phone). Saved on this device.
   The page <head> applies it before first paint; this keeps it in sync afterwards.
   ========================= */
const THEME_MQ = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function themeMode(){ try{ return localStorage.getItem('mg-theme') || 'auto' }catch{ return 'auto' } }
function applyTheme(){
  const m = themeMode(), dark = m==='dark' || (m==='auto' && !!THEME_MQ?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themeMode = m;
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', dark ? '#0A1120' : '#0B1B3F');
  document.querySelectorAll('[data-theme-opt]').forEach(b=>{ const on = b.dataset.themeOpt===m; b.classList.toggle('on', on); b.setAttribute('aria-checked', on) });
}
function setThemeMode(m){
  try{ localStorage.setItem('mg-theme', m) }catch{}
  document.documentElement.classList.add('theme-anim');
  applyTheme();
  setTimeout(()=>document.documentElement.classList.remove('theme-anim'), 400);
}
THEME_MQ?.addEventListener?.('change', ()=>{ if(themeMode()==='auto') applyTheme() });
applyTheme();
/* Search boxes: a clear (×) button appears while something is typed; one tap empties the box. */
function searchClearSync(input){
  const box = input.closest('.search-box'); if(!box) return;
  let btn = box.querySelector('.sx-clear');
  if(!btn){
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sx-clear'; btn.setAttribute('aria-label', 'Clear search');
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    btn.addEventListener('mousedown', e=>e.preventDefault());
    btn.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); const i = box.querySelector('input'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})); i.focus(); });
    box.appendChild(btn);
  }
  box.classList.toggle('filled', !!input.value);
}
document.addEventListener('input', e=>{ if(e.target.matches?.('.search-box input')) searchClearSync(e.target) }, true);
new MutationObserver(()=>document.querySelectorAll('.search-box input').forEach(i=>{ if(i.value || i.closest('.search-box').classList.contains('filled')) searchClearSync(i) }))
  .observe(document.getElementById('main') || document.body, {childList:true, subtree:true});
setInterval(()=>{ if(isAdmin()) STORE.tournaments.filter(t=>t.status==='active').forEach(t=>processDeadline(t.id)) }, 30000);

/* =========================
   PERFORMANCE LAYER
   - Instant start: the last live data is kept on this device and shown at once,
     then replaced by live data. Organiser tools unlock only once live data is in,
     so nothing is ever saved from an older copy.
   - Pictures live in Supabase Storage (cached by the browser and the service
     worker) instead of inside the data, so pages load a few KB instead of MBs.
     Any picture still stored inline is moved there in the background.
   - Libraries load without blocking the page; the image-export library loads
     only when someone exports.
   ========================= */
const MEDIA_PREFIX = SUPABASE_URL + '/storage/v1/object/public/media/';
const isDataImg = v => typeof v==='string' && v.startsWith('data:image/');
const isMediaUrl = v => typeof v==='string' && v.startsWith(MEDIA_PREFIX) && /^[A-Za-z0-9_\-./]+$/.test(v.slice(MEDIA_PREFIX.length));
const isImgSrc = v => isMediaUrl(v) || isDataImg(v);
/* Extra <img> attributes: CORS for stored pictures (so exports can draw them), async decoding always. */
const imgAttrs = v => (isMediaUrl(v) ? ' crossorigin="anonymous"' : '') + ' decoding="async"';
/* A CSS url() only for pictures we trust and that can't break out of the quotes. */
const cssUrl = v => isImgSrc(v) && !/['"\\\n\r]/.test(v) ? `url('${v}')` : '';

/* ---- Script loading ---- */
function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = ()=>resolve(); s.onerror = ()=>{ s.remove(); reject(new Error('load '+src)) };
    document.head.appendChild(s);
  });
}
const SUPABASE_JS = ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js', 'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'];
function waitForSupabase(){
  if(window.supabase && typeof window.supabase.createClient==='function') return Promise.resolve(true);
  return new Promise(resolve=>{
    let done = false;
    const finish = ()=>{ if(done) return; done = true; resolve(!!(window.supabase && typeof window.supabase.createClient==='function')) };
    const fallback = ()=>{ if(done) return; loadScript(SUPABASE_JS[1]).then(finish, finish) };
    const tag = document.getElementById('sbjs');
    if(window.__sbFailed) fallback();
    else if(tag){ tag.addEventListener('load', ()=>{ window.supabase ? finish() : fallback() }); tag.addEventListener('error', fallback) }
    else loadScript(SUPABASE_JS[0]).then(()=>window.supabase ? finish() : fallback(), fallback);
    setTimeout(()=>{ if(!done){ window.supabase ? finish() : fallback() } }, 12000);
    setTimeout(finish, 25000);
  });
}
let h2cLoading = null;
function ensureHtml2canvas(){
  if(typeof window.html2canvas==='function') return Promise.resolve(true);
  if(!h2cLoading){
    h2cLoading = loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js')
      .catch(()=>loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'))
      .then(()=>typeof window.html2canvas==='function', ()=>false)
      .then(ok=>{ if(!ok) h2cLoading = null; return ok });
  }
  return h2cLoading;
}

/* ---- Instant start from the last saved copy ---- */
const SNAP_KEY = 'mec_snap_v1';
function stripInline(v){ return isDataImg(v) ? null : v }
function makeSnapshot(){
  const players = STORE.players.map(p=>({...p, photo:stripInline(p.photo), photoSrc:stripInline(p.photoSrc)}));
  const tournaments = STORE.tournaments.map(t=>({...t, logo:stripInline(t.logo), logoSrc:stripInline(t.logoSrc)}));
  const settings = {...STORE.settings, logo:stripInline(STORE.settings.logo), logoSrc:stripInline(STORE.settings.logoSrc)};
  const pic = o => o && o.image ? {...o, image:stripInline(o.image)} : (o||{});
  return {v:1, at:Date.now(), players, tournaments, hof:STORE.hof, settings, cover:pic(STORE.cover), sidecard:pic(STORE.sidecard), hofcover:pic(STORE.hofcover)};
}
let snapTimer = null;
function saveSnapshotSoon(){
  if(!STORE.live) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(()=>{
    try{ const s = JSON.stringify(makeSnapshot()); if(s.length < 3.5e6) localStorage.setItem(SNAP_KEY, s); else localStorage.removeItem(SNAP_KEY) }catch{}
  }, 900);
}
function readSnapshot(){
  try{
    const s = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    if(!s || s.v!==1 || !Array.isArray(s.players) || !Array.isArray(s.tournaments)) return null;
    return s;
  }catch{ return null }
}
function applySnapshot(s){
  STORE.players = s.players; STORE.tournaments = s.tournaments;
  STORE.hof = Array.isArray(s.hof) ? s.hof : [];
  STORE.settings = s.settings || {}; STORE.cover = s.cover || {}; STORE.sidecard = s.sidecard || {}; STORE.hofcover = s.hofcover || {};
  STORE.loaded.players = true; STORE.loaded.tournaments = true;
  STORE.fromSnapshot = true;
}
/* Organiser role remembered for this signed-in email, so organiser tools appear quickly. Saving still requires the server to agree. */
const ROLE_KEY = 'mec_role_hint';
function storedSessionEmail(){
  try{ const s = JSON.parse(localStorage.getItem('sb-pdgkxbkxpzinlbyedvco-auth-token') || 'null'); return (s && (s.user?.email || s.currentSession?.user?.email)) || null }catch{ return null }
}
function readRoleHint(){
  try{ const h = JSON.parse(localStorage.getItem(ROLE_KEY) || 'null'); const email = storedSessionEmail(); return h && email && h.email===email ? h.role : null }catch{ return null }
}
function saveRoleHint(){
  try{ if(AUTH.user && AUTH.role) localStorage.setItem(ROLE_KEY, JSON.stringify({email:AUTH.user.email, role:AUTH.role})); else localStorage.removeItem(ROLE_KEY) }catch{}
}
/* Live data has arrived for everything organisers can change. */
function markLive(key){
  STORE.liveLoaded = STORE.liveLoaded || {};
  STORE.liveLoaded[key] = true;
  const L = STORE.liveLoaded;
  if(!STORE.live && L.players && L.tournaments && L.halloffame && L.settings){
    STORE.live = true; STORE.fromSnapshot = false;
    if(liveResolve) liveResolve();
    scheduleRender(); saveSnapshotSoon(); scheduleOffload(1500);
  }
}

/* ---- Pictures: move inline images to Supabase Storage ---- */
async function sha256hex(bytes){
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].slice(0, 12).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function uploadDataUrl(dataUrl, folder){
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if(!m) throw new Error('unsupported image');
  const bin = atob(m[2]); const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  const ext = m[1]==='image/png' ? 'png' : m[1]==='image/webp' ? 'webp' : 'jpg';
  const path = `${folder}/${await sha256hex(bytes)}.${ext}`;
  const {error} = await AUTH.sb.storage.from('media').upload(path, new Blob([bytes], {type:m[1]}), {contentType:m[1], cacheControl:'31536000', upsert:false});
  if(error && !/exist|duplicate|409/i.test(`${error.message||''} ${error.error||''} ${error.statusCode||''}`)) throw error;
  return MEDIA_PREFIX + path;
}
let offloadTimer = null, offloadRunning = false, offloadFails = 0;
function scheduleOffload(delay=2500){
  if(!isAdmin() || offloadFails > 3) return;
  clearTimeout(offloadTimer); offloadTimer = setTimeout(offloadImages, delay);
}
async function offloadImages(){
  if(offloadRunning || !isAdmin() || !AUTH.sb || navigator.onLine===false) return;
  offloadRunning = true;
  try{
    for(const [key, fields, folder] of [['players',['photo','photoSrc'],'players'], ['tournaments',['logo','logoSrc'],'logos']]){
      for(const item of [...STORE[key]]){
        for(const f of fields){
          const v = item[f]; if(!isDataImg(v)) continue;
          const url = await uploadDataUrl(v, folder);
          if(STORE[key].some(x=>x.id===item.id && x[f]===v)) DB.set(key, STORE[key].map(x=> x.id===item.id && x[f]===v ? {...x, [f]:url} : x));
        }
      }
    }
    for(const f of ['logo','logoSrc']){
      const v = STORE.settings && STORE.settings[f];
      if(isDataImg(v)){ const url = await uploadDataUrl(v, 'brand'); if(STORE.settings[f]===v) saveSettings({[f]:url}) }
    }
    const pi = STORE.settings && STORE.settings.prizeIcons;
    if(pi && Object.values(pi).some(isDataImg)){
      const next = {...pi};
      for(const k of Object.keys(next)) if(isDataImg(next[k])) next[k] = await uploadDataUrl(next[k], 'brand');
      if(STORE.settings.prizeIcons===pi) saveSettings({prizeIcons: next});
    }
    for(const k of ['cover','sidecard','hofcover']){
      const v = STORE[k] && STORE[k].image;
      if(isDataImg(v)){ const url = await uploadDataUrl(v, 'brand'); if(STORE[k].image===v) savePicDoc(k, url) }
    }
    offloadFails = 0;
    await syncAppIcons();
  }catch(e){ offloadFails++; console.warn('Picture upload paused', e); if(offloadFails<=3) scheduleOffload(15000*offloadFails) }
  finally{ offloadRunning = false }
}

/* ---- Skeleton while the very first data loads ---- */
function renderSkeleton(){
  setHeader('Welcome', 'Dashboard');
  const tile = '<div class="sk-tile"><i class="sk sk-line w40"></i><i class="sk sk-line w60 tall"></i></div>';
  document.getElementById('main').innerHTML = `
    <div class="skeleton" aria-busy="true" aria-label="Loading">
      <div class="sk sk-hero"></div>
      <div class="sk-row">${tile.repeat(4)}</div>
      <div class="sk-row two"><div class="sk-card">${'<i class="sk sk-line"></i>'.repeat(5)}</div><div class="sk-card">${'<i class="sk sk-line"></i>'.repeat(5)}</div></div>
    </div>`;
}

/* ---- Service worker updates ---- */
function watchForUpdates(reg){
  if(!reg) return;
  const hadController = !!navigator.serviceWorker.controller;
  let shown = false;
  const showBar = ()=>{
    if(shown) return; shown = true;
    const bar = document.createElement('div');
    bar.className = 'update-bar'; bar.setAttribute('role','status');
    bar.innerHTML = `<span>A new version of the app is ready.</span><button type="button" class="btn btn-primary btn-sm" onclick="location.reload()">Reload</button><button type="button" class="update-x" aria-label="Dismiss" onclick="this.parentNode.remove()">×</button>`;
    document.body.appendChild(bar);
  };
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(!hadController || shown) return;
    // Only offer a reload when the new worker serves a different version from the one running here.
    const paths = [...document.querySelectorAll('script[src*="/assets/app."], link[rel="stylesheet"][href*="/assets/app."]')].map(el=>new URL(el.src || el.href, location.href).pathname);
    let answered = false;
    const onMsg = e=>{
      if(!e.data || e.data.type!=='version') return;
      answered = true; navigator.serviceWorker.removeEventListener('message', onMsg);
      const assets = e.data.assets || [];
      if(!paths.length || paths.some(x=>!assets.includes(x))) showBar();
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    try{ navigator.serviceWorker.controller.postMessage({type:'version'}) }catch{ showBar() }
    setTimeout(()=>{ if(!answered){ navigator.serviceWorker.removeEventListener('message', onMsg); showBar() } }, 4000);
  });
  const check = ()=>{ try{ reg.update() }catch{} };
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') check() });
  setInterval(check, 60*60*1000);
}

/* Writes wait until live data has arrived (see markLive). */
let liveResolve = null;
const LIVE_READY = new Promise(r=>{ liveResolve = r });

/* PDF library, loaded only when someone exports a PDF. */
let pdfLoading = null;
function ensureJsPDF(){
  if(window.jspdf && window.jspdf.jsPDF) return Promise.resolve(true);
  if(!pdfLoading){
    pdfLoading = loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
      .catch(()=>loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'))
      .then(()=>!!(window.jspdf && window.jspdf.jsPDF), ()=>false)
      .then(ok=>{ if(!ok) pdfLoading = null; return ok });
  }
  return pdfLoading;
}

/* ---- Home-screen icon follows the community logo ----
   Icons are drawn from the logo (on the navy brand colour), stored in Supabase Storage,
   and served to phones through the app-icon function named in the manifest. */
function loadImage(src){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    if(/^https?:/.test(src)) img.crossOrigin = 'anonymous';
    img.onload = ()=>resolve(img); img.onerror = ()=>reject(new Error('image'));
    img.src = src;
  });
}
let iconsRunning = false;
const ICONS_VERSION = 4;
async function syncAppIcons(){
  const st = STORE.settings || {}, logo = st.logo;
  if(iconsRunning || !isAdmin() || !AUTH.sb) return;
  if(!logo){ if(st.appIcons) saveSettings({appIcons:null}); return }
  if(!isMediaUrl(logo) || (st.appIcons && st.appIcons.from===logo && st.appIcons.v===ICONS_VERSION)) return;
  iconsRunning = true;
  try{
    // Redraw from the original picture and saved crop for sharp large icons; fall back to the logo itself.
    let art;
    try{
      if(!st.logoSrc || !st.logoCrop) throw new Error('no source');
      const img = await loadImage(st.logoSrc);
      art = document.createElement('canvas'); art.width = art.height = 1024;
      paintCrop({img, opts:LOGO_OPTS, zoom:st.logoCrop.zoom||1, x:st.logoCrop.x||0, y:st.logoCrop.y||0, ready:true}, art.getContext('2d'), 1024, 1024, null);
    }catch{ art = await loadImage(logo) }
    const draw = (size, scale)=>{
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d'); g.fillStyle = '#0B1B3F'; g.fillRect(0, 0, size, size);
      g.imageSmoothingQuality = 'high';
      if(scale>=1){ g.drawImage(art, 0, 0, size, size); return c.toDataURL('image/png') }
      // Android shapes crop the edges: blurred logo colours behind, the logo smaller on top with soft edges.
      g.filter = 'blur(24px)'; g.drawImage(art, -size*0.15, -size*0.15, size*1.3, size*1.3); g.filter = 'none';
      const sz = Math.round(size*scale), t = document.createElement('canvas'); t.width = t.height = sz;
      const tg = t.getContext('2d'); tg.drawImage(art, 0, 0, sz, sz);
      const fade = tg.createRadialGradient(sz/2, sz/2, sz*0.36, sz/2, sz/2, sz*0.5);
      fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
      tg.globalCompositeOperation = 'destination-in'; tg.fillStyle = fade; tg.fillRect(0, 0, sz, sz);
      g.drawImage(t, (size-sz)/2, (size-sz)/2);
      return c.toDataURL('image/png');
    };
    const icons = {from:logo, v:ICONS_VERSION};
    for(const [key, size, scale] of [['192',192,1], ['512',512,1], ['mask',512,0.8], ['180',180,1], ['32',32,1]]){
      icons[key] = await uploadDataUrl(draw(size, scale), 'app');
    }
    if((STORE.settings||{}).logo===logo) saveSettings({appIcons:icons});
  }catch(e){ console.warn('Home-screen icon not updated', e) }
  finally{ iconsRunning = false }
}


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
        <button type="button" class="btn btn-ghost btn-icon" onclick="toggleNotifPanel(false)" aria-label="Close updates">✕</button>
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
    <div class="modal-head"><div class="modal-title">Install the app</div><button type="button" class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
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

/* Init */
boot();
