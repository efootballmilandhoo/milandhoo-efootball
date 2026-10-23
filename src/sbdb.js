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
