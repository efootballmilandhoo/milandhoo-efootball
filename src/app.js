/* =========================
   UTILITIES
   ========================= */
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,9) }
const clone = x => JSON.parse(JSON.stringify(x));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => (String(s || 'export').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'') || 'export');
const hasScore = v => v !== null && v !== undefined && v !== '' && !Number.isNaN(v);
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
    if(code==='invalid_argument') toast('Save refused: only signed-in organisers can change community data. Sign in again from the Admin Panel.', true);
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
  else if(['halloffame','players','leaderboard','tournaments','admin','dashboard'].includes(h)) navigate(h);
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
  g.players.forEach(p=>{ rows[p.playerId] = {playerId:p.playerId, played:0, wins:0, draws:0, losses:0, gf:0, ga:0, points:0} });
  (t.fixtures||[]).forEach(f=>{
    if(f.group!==g.name || !hasScore(f.score1) || !hasScore(f.score2)) return;
    const a = rows[f.team1], b = rows[f.team2];
    if(!a || !b) return;
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
   AUTO-CALCULATE STATS
   ========================= */
function calculateAllStats(){
  const players = STORE.players, tournaments = STORE.tournaments;
  const stats = {};
  players.forEach(p=>{ stats[p.id] = {matches:0, wins:0, draws:0, losses:0, gf:0, ga:0, tourneyWins:0, tourneyRunnerUp:0, tourneyThird:0, achievements:[], lastAt:'', addedAt:String(p.createdAt||'')} });
  tournaments.forEach(t=>{
    const tWhen = String(t.completedAt || t.startedAt || t.createdAt || '');
    const touch = pid => { const s = stats[pid]; if(s && tWhen > s.lastAt) s.lastAt = tWhen };
    (t.fixtures||[]).forEach(f=>{
      if(!hasScore(f.score1) || !hasScore(f.score2)) return;
      const a = stats[f.team1], b = stats[f.team2];
      touch(f.team1); touch(f.team2);
      if(a){ a.matches++; a.gf+=f.score1; a.ga+=f.score2; if(f.score1>f.score2) a.wins++; else if(f.score1<f.score2) a.losses++; else a.draws++ }
      if(b){ b.matches++; b.gf+=f.score2; b.ga+=f.score1; if(f.score2>f.score1) b.wins++; else if(f.score2<f.score1) b.losses++; else b.draws++ }
    });
    (t.knockoutBracket||[]).forEach(round=>round.forEach(m=>{
      if(m.isBye || !m.team1 || !m.team2 || !m.winner) return;
      touch(m.team1); touch(m.team2);
      const r = koResult(t, m);
      [[m.team1,0],[m.team2,1]].forEach(([pid,side])=>{
        const s = stats[pid]; if(!s) return;
        s.matches++;
        if(r.goals){ s.gf += r.goals[side]; s.ga += r.goals[1-side] }
        if(m.winner===pid) s.wins++; else s.losses++;
      });
    }));
    if(t.status==='completed'){
      if(t.champion && stats[t.champion]){ stats[t.champion].tourneyWins++; stats[t.champion].achievements.push(`Champion · ${t.name}`) }
      if(t.runnerUp && stats[t.runnerUp]){ stats[t.runnerUp].tourneyRunnerUp++; stats[t.runnerUp].achievements.push(`Runner-up · ${t.name}`) }
      if(t.thirdPlace && stats[t.thirdPlace]){ stats[t.thirdPlace].tourneyThird++; stats[t.thirdPlace].achievements.push(`Third Place · ${t.name}`) }
    }
  });
  Object.values(stats).forEach(s=>{ s.winPct = s.matches ? ((s.wins/s.matches)*100).toFixed(1) : '0.0' });
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
      if(f.id!==currentTournamentId) selectedPlayerFilter = null;
      currentTournamentId = f.id;
      currentTab = tabs.includes(want) ? want : (view==='bracket' ? 'tab-overview' : tabs.includes('tab-knockout') ? 'tab-knockout' : 'tab-overview');
      view = 'tournament-detail';
      param = f.id;
    }
  } else if(view==='tournament-detail'){
    if(opts.tab) currentTab = opts.tab;
    else if(param!==currentTournamentId){ currentTab='tab-overview'; selectedPlayerFilter=null }
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

function onGlobalSearch(v){
  playerQuery = v;
  if(currentView!=='players'){ navigate('players'); document.getElementById('globalSearch')?.focus() }
  else renderPlayers();
}

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
      <div class="xs-kicker">${esc(commFull().toUpperCase().replace('EFOOTBALL','eFOOTBALL'))}</div>
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
function sheetFoot(page, pages){
  return `<div class="xs-foot">
    <div class="xs-follow-label">FOLLOW US</div>
    <div class="xs-socials">${SOCIALS.map(x=>`<span class="xs-social">${x.icon}<span><small>${x.network}</small><b>${esc(x.handle)}</b></span></span>`).join('')}</div>
    <div class="xs-date">Exported ${fmtDateTime(new Date())}${pages>1 ? ` · Page ${page} of ${pages}` : ''}</div>
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
function sheetCanvas(sheet, W, H, scale){
  return html2canvas(sheet, { backgroundColor:'#EEF2F8', scale, useCORS:true, logging:false, width:W, height:H, windowWidth:Math.max(W+40, 1280), windowHeight:H+40 });
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
function chooseExportFormat(pages){
  return new Promise(resolve=>{
    let done = false;
    const finish = v=>{ if(done) return; done = true; window.__exportPick = null; closeModal(); resolve(v) };
    window.__exportPick = finish;
    openModal(`
      <div class="modal-head"><div class="modal-title">Export</div><button type="button" class="btn btn-ghost btn-icon" onclick="__exportPick&&__exportPick(null)" aria-label="Close">✕</button></div>
      <div class="modal-body">
        <div class="export-choice">
          <button type="button" class="export-option" onclick="__exportPick('png')">${ICON.image}<b>Image (PNG)</b><span>${pages>1?`${pages} images, one per page`:'One image'}. Best for WhatsApp, Instagram and Viber.</span></button>
          <button type="button" class="export-option" onclick="__exportPick('pdf')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg><b>PDF document</b><span>${pages>1?`One file with all ${pages} pages`:'One page'}. Best for printing and sharing as a file.</span></button>
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
  const format = await chooseExportFormat(pages.length);
  if(!format) return;
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
  if(elementId==='playerFixturesExport'){
    const pid = document.getElementById('pv_select')?.value;
    return exportGenericSheet(el, t, playerName(pid), `${esc(t?.name||'')} · Fixtures &amp; results`, filename);
  }
  if(elementId==='leaderboardExport') return exportLeaderboardSheet();
  return exportGenericSheet(el, null, 'Community Leaderboard', `Ranked by titles, then wins, then win rate · ${fmtDate(new Date())}`, filename);
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
  users:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>',
  trophy:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  check:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
  clock:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  ball:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 5h-5L8 10z"/><path d="M12 3v4M21 10l-5 0M3 10h5M7 20l2.5-5M17 20l-2.5-5"/></svg>',
  goal:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20V6h18v14M3 10h18M8 6v14M16 6v14"/></svg>',
  calendar:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  alarm:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3L2 6M19 3l3 3"/></svg>',
  arrow:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  plus:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  phone:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  image:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 17l-5-5-8 8"/></svg>',
  hofEmblem:'<svg width="48" height="48" viewBox="8 6 48 50" aria-hidden="true"><g fill="none" stroke="#FFF7DC" stroke-width="1.8" stroke-linecap="round"><path d="M25.5 52.0A21 21 0 0 1 23.5 12.8"/><path d="M38.5 52.0A21 21 0 0 0 40.5 12.8"/></g><g fill="#FFF7DC"><ellipse cx="42.7" cy="52.0" rx="5.6" ry="2.5" transform="rotate(-180 42.7 52.0)"/><ellipse cx="45.8" cy="41.5" rx="5.3" ry="2.3" transform="rotate(-96 45.8 41.5)"/><ellipse cx="55.1" cy="35.6" rx="4.9" ry="2.2" transform="rotate(-132 55.1 35.6)"/><ellipse cx="50.0" cy="26.9" rx="4.6" ry="2.1" transform="rotate(-48 50.0 26.9)"/><ellipse cx="52.2" cy="16.8" rx="4.3" ry="1.9" transform="rotate(-84 52.2 16.8)"/><ellipse cx="42.3" cy="15.6" rx="3.9" ry="1.8" transform="rotate(0 42.3 15.6)"/><ellipse cx="39.2" cy="9.7" rx="2.2" ry="4.2" transform="rotate(20 39.2 9.7)"/><ellipse cx="21.3" cy="52.0" rx="5.6" ry="2.5" transform="rotate(0 21.3 52.0)"/><ellipse cx="18.2" cy="41.5" rx="5.3" ry="2.3" transform="rotate(-84 18.2 41.5)"/><ellipse cx="8.9" cy="35.6" rx="4.9" ry="2.2" transform="rotate(-48 8.9 35.6)"/><ellipse cx="14.0" cy="26.9" rx="4.6" ry="2.1" transform="rotate(-132 14.0 26.9)"/><ellipse cx="11.8" cy="16.8" rx="4.3" ry="1.9" transform="rotate(-96 11.8 16.8)"/><ellipse cx="21.7" cy="15.6" rx="3.9" ry="1.8" transform="rotate(-180 21.7 15.6)"/><ellipse cx="24.8" cy="9.7" rx="2.2" ry="4.2" transform="rotate(-20 24.8 9.7)"/></g><path d="M32.0 19.5L34.7 26.8L42.5 27.1L36.4 31.9L38.5 39.4L32.0 35.1L25.5 39.4L27.6 31.9L21.5 27.1L29.3 26.8z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/><path d="M27 53.5l5-2.6 5 2.6" fill="none" stroke="#FFF7DC" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cup:'<svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true"><path d="M17 12H9.5a1.5 1.5 0 0 0-1.5 1.5V18c0 7.2 5.4 12.6 12.4 13" fill="none" stroke="#E0A100" stroke-width="4" stroke-linecap="round"/><path d="M47 12h7.5a1.5 1.5 0 0 1 1.5 1.5V18c0 7.2-5.4 12.6-12.4 13" fill="none" stroke="#E0A100" stroke-width="4" stroke-linecap="round"/><path d="M16 7h32v15.5C48 32.2 40.8 40 32 40s-16-7.8-16-17.5V7z" fill="#F5B400"/><path d="M16 7h32v4H16z" fill="#FFCB2E"/><path d="M21.5 13v9c0 5.2 2.6 9.4 6.5 11.4" fill="none" stroke="#FFE68A" stroke-width="2.6" stroke-linecap="round"/><path d="M32 15.5l2.3 4.6 5.1.7-3.7 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.7-3.6 5.1-.7z" fill="#FFF6D6"/><path d="M28.5 40h7l1.5 7h-10z" fill="#D18F00"/><rect x="21" y="47" width="22" height="6" rx="1.5" fill="#B07C00"/><rect x="17" y="53" width="30" height="5" rx="2" fill="#0B1B3F"/></svg>'
};
async function copyText(text){
  try{ await navigator.clipboard.writeText(text); toast('Copied ' + text) }
  catch{ toast('Copy is blocked here. Select the number and copy it by hand.', true) }
}

function statTile(icon, tint, label, value, delta){
  return `<div class="stat"><div class="stat-icon ${tint}">${ICON[icon]}</div><div class="stat-body"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${delta?`<span class="stat-delta">${delta}</span>`:''}</div></div>`;
}

/* =========================
   DASHBOARD
   ========================= */
function renderDashboard(){
  const tourneys = visibleTournaments();
  const stats = calculateAllStats();
  const totalMatches = STORE.tournaments.reduce((s,t)=> s + (t.fixtures||[]).filter(f=>hasScore(f.score1)&&hasScore(f.score2)).length + (t.knockoutBracket||[]).flat().filter(m=>!m.isBye && m.team1 && m.team2 && (matchTotals(t,m) || m.winner)).length, 0);
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
    else facts.push(`Starts ${fmtDate(f.startDateTime||f.date)}`);
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

  const topRows = rankPlayers(stats).slice(0,5).map((x,i)=>`
      <div class="row-grid top-row"><span class="rank-badge ${rankClass(i)}">${i+1}</span>${renderAvatar(x.p,30)}<span class="row-name">${esc(x.p.name)}</span><span class="row-num muted">${x.s.winPct}%</span><span class="row-num">${x.s.wins}W</span></div>`).join('') || `<div class="text-sm text-muted">No players yet.</div>`;
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
        <div class="row-grid top-row row-head"><span>#</span><span></span><span>Player</span><span class="row-num">Win %</span><span class="row-num">Wins</span></div>
        ${topRows}
      </section>
      <section class="card" style="display:flex;flex-direction:column;gap:6px">
        <div class="card-head" style="margin-bottom:4px"><h2 class="card-title">Hall of Fame</h2><button type="button" class="btn-link" onclick="navigate('halloffame')">View all →</button></div>
        ${hofHtml}
      </section>
    </div>`;
}

function rankPlayers(stats){
  return STORE.players.map(p=>({p, s:stats[p.id]})).sort((a,b)=> (b.s.tourneyWins-a.s.tourneyWins) || (b.s.wins-a.s.wins) || (parseFloat(b.s.winPct)-parseFloat(a.s.winPct)) || (b.s.matches-a.s.matches) || b.s.lastAt.localeCompare(a.s.lastAt) || b.s.addedAt.localeCompare(a.s.addedAt));
}

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
      ${s.tourneyWins>0 || s.achievements.length ? `<div class="champ-box" style="padding:10px 12px">${ICON.cup.replace('width="36" height="36"','width="24" height="24"')}<div style="min-width:0"><small>${s.tourneyWins} TITLE${s.tourneyWins===1?'':'S'}</small><span class="text-xs" style="color:var(--gold-ink)">${esc(s.achievements.slice(-1)[0]||'')}</span></div></div>` : ''}
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
  const players = STORE.players.filter(p=>p.name.toLowerCase().includes(q));
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

function renderTournamentCards(list){
  if(list.length===0) return `<div class="card empty" style="grid-column:1/-1"><div class="empty-title">No tournaments here yet</div><div class="text-sm">${isAdmin()?'Create one with New Tournament.':'New tournaments will appear here.'}</div></div>`;
  return list.map(t=>{
    const n = (t.registrations||[]).length;
    const champ = t.champion ? `<div class="champ-box">${ICON.cup.replace('width="36" height="36"','width="26" height="26"')}<div style="min-width:0"><small>CHAMPION</small><b>${esc(playerName(t.champion))}</b></div></div>`
      : `<div class="champ-box" style="background:var(--surface-2)"><span class="stat-icon tint-blue" style="width:36px;height:36px;border-radius:10px">${ICON.calendar}</span><div style="min-width:0"><small style="color:var(--muted)">${t.status==='completed'?'COMPLETED':'STARTS'}</small><b style="font-size:18px">${fmtDateTime(t.startDateTime||t.date)}</b></div></div>`;
    return `
    <button type="button" class="t-card" onclick="navigate('tournament-detail','${t.id}')">
      <div class="t-card-head" style="background:${tColor(t)}">
        ${t.logo ? tournamentLogo(t, 76, 'on-color') : `<span class="t-card-code">${esc(tCode(t))}</span>`}
        ${statusBadge(t.status)}
      </div>
      <div class="t-card-body">
        <div><div class="t-card-name">${esc(t.name)}</div><div class="t-card-meta">${formatLabel(t.format)}${t.prize?.champion?` · Prize ${esc(t.prize.champion)}`:''}</div></div>
        ${champ}
        <div class="t-card-foot"><span>${n} player${n===1?'':'s'}</span><b>View ${t.status==='completed'?'results':'tournament'} →</b></div>
      </div>
    </button>`}).join('');
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
        <span class="page-sub">${fmtDateTime(t.startDateTime || t.date)} · ${esc(t.game||'eFootball')}</span>
      </div>
      ${admin ? `<div class="toolbar-actions t-actions">
        ${t.status==='active' ? `<button type="button" class="btn btn-primary" onclick="openCompleteTournamentModal('${t.id}')">Complete tournament</button>`:''}
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
  return '';
}

/* Description, group-stage deadline and prizes, shown at the top of the Overview tab. */
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
          <div class="deadline-notice-text">${fmtDateTime(t.groupDeadline)} · ${isDeadlinePassed?'Unplayed matches are recorded as 0-0 draws':'Unplayed matches after this count as 0-0 draws'}</div>
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
  t.champion = t.runnerUp = t.thirdPlace = null;
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
    ${t.groupData.map(g=>`<button type="button" class="seg ${g.name===cur?'active':''}" aria-pressed="${g.name===cur}" onclick="${onPick}('${t.id}','${esc(g.name)}')">Group ${esc(g.name)}</button>`).join('')}
    <button type="button" class="seg ${cur==='*'?'active':''}" aria-pressed="${cur==='*'}" onclick="${onPick}('${t.id}','*')">All</button>
  </div>`;
}
function currentGroup(t){
  if(!t.groupData?.length) return null;
  if(selectedGroup==='*' || t.groupData.some(g=>g.name===selectedGroup)) return selectedGroup;
  return t.groupData[0].name;
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
  const groupFx = (t.fixtures||[]).filter(f=>f.group===g.name);
  const finished = groupFx.length>0 && groupFx.every(f=>hasScore(f.score1)&&hasScore(f.score2));
  const isLeague = t.format==='league';
  const chip = isLeague ? (finished ? 'Champion' : 'Leader') : (finished ? 'Qualified' : 'Q');
  return `
    <div class="table-wrap">
      <table class="group-table">
        <thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">P</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th><th scope="col">GF</th><th scope="col">GA</th><th scope="col">GD</th><th scope="col">Pts</th></tr></thead>
        <tbody>
          ${rows.map((row,i)=>{
            const p = STORE.players.find(x=>x.id===row.playerId) || {name:'Unknown player'};
            const gd = row.gf-row.ga, q = i<highlightN;
            return `<tr class="${q?'qualify':'out'} ${i===highlightN && i>0?'cut':''}">
              <td>${i+1}</td>
              <td><span class="who">${renderAvatar(p, 32)}<span style="min-width:0">${esc(p.name)}</span>${q?`<span class="q-chip ${finished?'done':''}" title="${isLeague?'Top of the table':'In a qualifying place'}">${chip}</span>`:''}</span></td>
              <td>${row.played}</td><td>${row.wins}</td><td>${row.draws}</td><td>${row.losses}</td>
              <td>${row.gf}</td><td>${row.ga}</td><td style="color:var(--text-2)">${gd>0?'+':''}${gd}</td>
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
      <span class="page-sub">${t.groupDeadline?`Deadline ${fmtDateTime(t.groupDeadline)}`:'3 pts win · 1 pt draw'}</span>
      ${isLeague ? '' : groupSwitcher(t, 'pickGroup')}
    </div>
    <section id="standingsExport" class="export-container" aria-label="${isLeague?'League table':'Group standings'}">
      <div class="export-header" style="margin-bottom:12px"><div class="export-title">${esc(t.name)}</div><div class="export-subtitle">${isLeague?'League table':'Group standings'} · ${fmtDate(new Date())}</div></div>
      ${content}
      <div class="section-foot" style="margin-top:14px">
        <span class="legend"><span class="q-chip">Q</span>${isLeague?'Top of the table':`Top ${q} in each group go through to the knockout stage. The dashed line is the cut-off; "Qualified" appears once the group is finished.`} Ties are split by goal difference, then goals scored.</span>
        <button type="button" class="export-btn no-export" onclick="exportAsJPEG('standingsExport','${slug(t.name)}_standings')">${ICON_DL} ${isLeague || t.groupData.length<2 ? 'Export standings' : cur && cur!=='*' ? `Export Group ${esc(cur)} standings` : 'Export standings · one page per group'}</button>
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
  const cur = t.format==='league' ? '*' : currentGroup(t);
  const q = fixtureQuery.trim().toLowerCase();
  const list = (t.fixtures||[]).filter(f=>(cur==='*' || f.group===cur) && (!q || playerName(f.team1).toLowerCase().includes(q) || playerName(f.team2).toLowerCase().includes(q)));
  if(!list.length) return `<tr><td colspan="${admin&&canEdit?7:6}" class="t-center text-muted" style="padding:32px">No fixtures match.</td></tr>`;
  return list.map(f=>{
    const done = hasScore(f.score1) && hasScore(f.score2);
    const p1 = STORE.players.find(p=>p.id===f.team1)||{name:'Unknown player'}, p2 = STORE.players.find(p=>p.id===f.team2)||{name:'Unknown player'};
    return `<tr>
      <td class="text-muted" style="white-space:nowrap">${fixtureStage(t,f)}</td>
      <td class="t-right"><span class="who right" style="${done&&f.score1>f.score2?'color:var(--primary-dark)':''}">${esc(p1.name)}${renderAvatar(p1,30)}</span></td>
      <td class="t-center"><span class="result-pill ${done?'':'pending'}">${done?`${f.score1} – ${f.score2}`:'vs'}</span></td>
      <td><span class="who" style="${done&&f.score2>f.score1?'color:var(--primary-dark)':''}">${renderAvatar(p2,30)}${esc(p2.name)}</span></td>
      <td class="t-right">${done ? `<span class="badge badge-completed">${f.autoDraw?'Auto 0-0':'Completed'}</span>` : `<span class="badge badge-pending">Pending</span>`}</td>
      ${admin && canEdit ? `<td class="t-right no-export"><button type="button" class="btn btn-ghost btn-sm" onclick="editFixtureScore('${t.id}','${f.id}')">${done?'Edit':'Enter score'}</button></td>`:''}
    </tr>`;
  }).join('');
}

function renderAllFixturesTab(t, admin, canEditScores){
  const fixtures = t.fixtures || [];
  if(fixtures.length===0) return `<div class="card empty"><div class="empty-title">No fixtures yet</div><div class="text-sm">Fixtures are created when the tournament starts.</div></div>`;
  const played = fixtures.filter(f=>hasScore(f.score1)&&hasScore(f.score2)).length;
  const canEdit = t.status==='active';
  return `
    ${t.format==='league' ? '' : `<div class="tabs-wrap"><span class="page-sub">Pick a group or view all fixtures</span>${groupSwitcher(t, 'pickGroup')}</div>`}
    ${admin && !canEditScores ? `<div class="locked-notice">Start the tournament to enter scores.</div>`:''}
    <section id="fixturesExport" class="export-container" aria-label="Fixtures" style="display:flex;flex-direction:column;gap:14px">
      <div class="export-header"><div class="export-title">${esc(t.name)}</div><div class="export-subtitle">Fixtures &amp; results${t.groupDeadline?` · Deadline ${fmtDateTime(t.groupDeadline)}`:''}</div></div>
      <div class="flex-between no-export">
        <span class="page-sub">${played} of ${fixtures.length} matches played</span>
        <label class="search-box" for="fx-search" style="width:240px;height:40px;border-radius:10px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4A5878" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="fx-search" type="search" placeholder="Search player…" aria-label="Search fixtures by player" value="${esc(fixtureQuery)}" oninput="setFixtureQuery('${t.id}', this.value)" style="font-size:13px">
        </label>
      </div>
      <div class="table-wrap">
        <table class="fx-table">
          <thead><tr><th scope="col">Stage</th><th scope="col" class="t-right">Home</th><th scope="col" class="t-center">Result</th><th scope="col">Away</th><th scope="col" class="t-right">Status</th>${admin&&canEdit?'<th class="no-export"></th>':''}</tr></thead>
          <tbody id="fixturesBody">${fixtureRows(t, admin, canEdit)}</tbody>
        </table>
      </div>
      <div class="section-foot no-export" style="justify-content:flex-end">
        <button type="button" class="export-btn" onclick="exportAsJPEG('fixturesExport','${slug(t.name)}_fixtures')">${ICON_DL} ${t.format==='league' ? 'Export fixtures' : currentGroup(t) && currentGroup(t)!=='*' ? `Export Group ${esc(currentGroup(t))} fixtures` : 'Export fixtures · each group separately'}</button>
      </div>
    </section>`;
}

function editFixtureScore(tid, fid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
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
      ${hasScore(f.score1) ? `<button class="btn btn-ghost" style="margin-right:auto;color:var(--danger)" onclick="saveFixtureScore('${tid}','${fid}',true)">Clear result</button>`:''}
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveFixtureScore('${tid}','${fid}')">Save</button>
    </div>`);
  setTimeout(()=>document.getElementById('fs_score1')?.focus(), 50);
}

function readScore(id){ const v = document.getElementById(id)?.value; if(v===undefined || v==='') return null; const n = parseInt(v,10); return Number.isFinite(n) && n>=0 ? n : NaN }

function saveFixtureScore(tid, fid, clear=false){
  const {all, t} = getT(tid);
  const f = t.fixtures.find(x=>x.id===fid);
  if(clear){ f.score1 = null; f.score2 = null }
  else {
    const s1 = readScore('fs_score1'), s2 = readScore('fs_score2');
    if(s1===null || s2===null || Number.isNaN(s1) || Number.isNaN(s2)){ toast('Enter both scores as whole numbers (0 or more)', true); return }
    f.score1 = s1; f.score2 = s2;
  }
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
  t.fixtures.forEach(f=>{ if(!hasScore(f.score1) || !hasScore(f.score2)){ f.score1 = 0; f.score2 = 0; f.autoDraw = true; n++ } });
  t.deadlineProcessed = true;
  DB.set('tournaments', all);
  if(n) toast(`Deadline passed · ${n} unplayed match${n>1?'es':''} recorded as 0-0`);
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
      ${m.winner || legs.some(l=>hasScore(l[0])||hasScore(l[1])) ? `<button type="button" class="btn btn-ghost" style="margin-right:auto;color:var(--danger-ink)" onclick="saveKnockoutMatch('${tid}',${roundIdx},'${matchId}',true)">Clear result</button>`:''}
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="saveKnockoutMatch('${tid}',${roundIdx},'${matchId}')">Save result</button>
    </div>`);
  koPreview(tid, roundIdx, matchId);
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
  propagateBracket(t.knockoutBracket);
  DB.set('tournaments', all);
  closeModal();
  rerender();
  toast(clear ? 'Result cleared' : m.winner ? `${playerName(m.winner)} goes through` : 'Result saved · tie still in progress');
}

function openCompleteTournamentModal(tid){
  if(!isAdmin()){ toast('Admin access required', true); return }
  const t = STORE.tournaments.find(x=>x.id===tid);
  let champ=null, runner=null, third=null;
  if(t.format!=='league' && t.knockoutBracket?.length){
    const final = t.knockoutBracket[t.knockoutBracket.length-1][0];
    if(final?.winner){ champ = final.winner; runner = final.winner===final.team1 ? final.team2 : final.team1 }
    if(t.knockoutBracket.length>=2){
      const semis = t.knockoutBracket[t.knockoutBracket.length-2].filter(m=>m.winner && !m.isBye).map(m=>m.winner===m.team1?m.team2:m.team1).filter(x=>x && x!==champ && x!==runner && x!==final?.team1 && x!==final?.team2);
      if(semis.length===1) third = semis[0];
      else if(semis.length===2){
        const st = calculateAllStats();
        third = semis.sort((a,b)=>(st[b]?.wins||0)-(st[a]?.wins||0))[0];
      }
    }
  } else if(t.format==='league' && t.groupData?.[0]){
    const s = computeStandings(t, t.groupData[0]);
    champ = s[0]?.playerId; runner = s[1]?.playerId; third = s[2]?.playerId;
  }
  if(runner && runner===champ) runner = null;
  if(third && (third===champ || third===runner)) third = null;
  const options = sel => `<option value="">— Select —</option>` + (t.registrations||[]).map(r=>`<option value="${r.playerId}" ${r.playerId===sel?'selected':''}>${esc(playerName(r.playerId))}</option>`).join('');
  openModal(`
    <div class="modal-head"><div class="modal-title">Complete Tournament</div><button class="btn btn-ghost btn-icon" onclick="closeModal()" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="text-sm text-muted mb-16">Placings are filled in from the results. ${t.format!=='league'?'Third place defaults to the losing semi-finalist with more wins; change it if you play a third-place match.':''}</div>
      <div class="form-group"><label class="form-label" for="ct_champ">Champion</label><select class="form-select ct-pick" id="ct_champ" onchange="syncPlacings()">${options(champ)}</select></div>
      <div class="form-group"><label class="form-label" for="ct_runner">Runner-up</label><select class="form-select ct-pick" id="ct_runner" onchange="syncPlacings()">${options(runner)}</select></div>
      <div class="form-group"><label class="form-label" for="ct_third">Third place</label><select class="form-select ct-pick" id="ct_third" onchange="syncPlacings()">${options(third)}</select></div>
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
  const c = document.getElementById('ct_champ').value || null, r = document.getElementById('ct_runner').value || null, th = document.getElementById('ct_third').value || null;
  if(!c){ toast('Choose a champion', true); return }
  const picks = [c,r,th].filter(Boolean);
  if(new Set(picks).size !== picks.length){ toast('Each placing needs a different player', true); return }
  const {all, t} = getT(tid);
  t.champion = c; t.runnerUp = r; t.thirdPlace = th;
  t.status = 'completed';
  t.completedAt = new Date().toISOString();
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
    const me1 = f.team1===pid, played = hasScore(f.score1) && hasScore(f.score2);
    const my = me1?f.score1:f.score2, opp = me1?f.score2:f.score1;
    list.push({stage: t.format==='league'?`Matchday ${f.matchday}`:`Group ${f.group}`, opponent: me1?f.team2:f.team1, score: played?`${my} - ${opp}`:null, goals: played?[my,opp]:null, result: !played?null: my>opp?'win':my<opp?'loss':'draw'});
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
  const fixtures = getPlayerFixtures(t, selectedId);
  const done = fixtures.filter(f=>f.result);
  let gf=0, ga=0; done.forEach(f=>{ if(f.goals){ gf+=f.goals[0]; ga+=f.goals[1] } });
  const wins = done.filter(f=>f.result==='win').length;
  const resBadge = r => r==='win' ? '<span class="badge badge-completed">Win</span>' : r==='loss' ? '<span class="badge" style="background:var(--danger-tint);color:var(--danger-ink)">Loss</span>' : r==='draw' ? '<span class="badge badge-draft">Draw</span>' : '<span class="badge badge-pending">Pending</span>';
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
      ${statTile('ball','tint-blue','Played', done.length, `${fixtures.length-done.length} to play`)}
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
    <div class="rules-block">
      <h3>Rules</h3>
      ${lines.length ? `<ol class="rules-list">${lines.map(l=>`<li>${esc(l)}</li>`).join('')}</ol>` : `<p class="rules-empty">No rules added yet.</p>`}
    </div>
    <div class="rules-block">
      <h3>Match settings</h3>
      ${settings.length ? `<dl class="settings-grid">${settings.map(x=>`<div><dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd></div>`).join('')}</dl>` : `<p class="rules-empty">No match settings added yet.</p>`}
    </div>
    ${sec.key==='ko' ? `<div class="rules-block">
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

function exportRulesSheet(tid, key){
  const t = STORE.tournaments.find(x=>x.id===tid);
  const secs = ruleSections(t).filter(s=>!key || s.key===key).filter(s=>key || stageHasContent(t, s.key));
  if(!secs.length){ toast('Nothing to export yet', true); return }
  // The tie-breaker match always gets a page of its own.
  const groupsOfSecs = [secs.filter(s=>s.key!=='tb'), secs.filter(s=>s.key==='tb')].filter(g=>g.length);
  const cols = Math.max(...groupsOfSecs.map(g=>g.length));
  const width = cols*560 + (cols-1)*18 + 56;
  const pages = groupsOfSecs.map((list, i)=>{
    const body = `<div class="xs-grid" style="grid-template-columns:repeat(${list.length}, 560px)">${list.map(sec=>rulesSectionHTML(t, sec, false)).join('')}</div>`;
    const dlBits = [];
    if(list.some(s=>s.key==='group') && t.groupDeadline) dlBits.push(`${t.format==='league'?'League':'Group stage'} deadline ${fmtDateTime(t.groupDeadline)}`);
    if(list.some(s=>s.key==='ko')){ const d = t.rules?.roundDeadlines||{}; const fin = d['Final']; if(fin) dlBits.push(`Final by ${fmtDateTime(fin)}`) }
    if(list.some(s=>s.key==='tb')) dlBits.push('Used when a 2-leg tie is level on aggregate');
    return sheetHeader(t, t.name, dlBits.join(' · ')) + body + sheetFoot(i+1, groupsOfSecs.length);
  });
  return renderSheets(pages, width, `${slug(t.name)}_${key ? slug(secs[0].title) + '_' : ''}rules`);
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
let hofFilter = {org:'all', player:'all'};

function hofPlayer(h){ return h.playerId ? (STORE.players.find(p=>p.id===h.playerId) || {name: h.playerName || 'Unknown player'}) : {name: h.playerName || 'Unknown player'} }
function hofTitle(h){ return h.type==='award' ? (h.title || 'Award') : (h.title || HOF_TYPES[h.type]?.label || 'Achievement') }
function hofDate(h){ if(!h.date) return ''; const [y,m] = String(h.date).split('-'); return m ? `${MONTHS[+m-1]||''} ${y}` : y }
function hofOrg(h){ return h.organizer==='other' ? (h.organizerName || 'Other organiser') : titleCase(commName()) }
function hofKey(h){ return h.playerId || 'name:'+String(h.playerName||'').toLowerCase() }

function hofRow(h){
  const t = HOF_TYPES[h.type] || HOF_TYPES.award, p = hofPlayer(h);
  return `<div class="row-grid hof-row">
    <span class="hof-medal ${t.cls}">${t.medal}</span>
    ${renderAvatar(p, 30)}
    <span class="row-stack"><b>${esc(p.name)}</b><span>${esc(hofTitle(h))} · ${esc(h.tournament||'')}</span></span>
    <span class="row-date">${esc(hofDate(h)) || '—'}</span>
  </div>`;
}

function hofCard(h, admin){
  const t = HOF_TYPES[h.type] || HOF_TYPES.award, p = hofPlayer(h);
  return `<article class="hof-card ${t.cls}">
    <div class="hof-card-top">
      <span class="hof-medal big ${t.cls}">${t.medal}</span>
      <div style="min-width:0;flex:1">
        <div class="hof-title">${esc(hofTitle(h))}</div>
        <div class="hof-tournament">${esc(h.tournament||'')}</div>
      </div>
      ${admin ? `<div class="flex gap-8 no-export">
        <button type="button" class="btn btn-ghost btn-icon" onclick="openHofModal('${h.id}')" aria-label="Edit achievement"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button type="button" class="btn btn-ghost btn-icon" style="color:var(--danger-ink)" onclick="deleteHof('${h.id}')" aria-label="Delete achievement"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>` : ''}
    </div>
    <div class="hof-player">${renderAvatar(p, 40)}<div style="min-width:0"><b>${esc(p.name)}</b>${!h.playerId?'<span class="text-xs text-muted">Not in the player list</span>':''}</div></div>
    <div class="hof-meta">
      <span class="badge ${h.organizer==='other'?'badge-format':'badge-open'}">${esc(hofOrg(h))}</span>
      ${h.date ? `<span class="text-sm text-muted">${esc(hofDate(h))}</span>` : ''}
    </div>
    ${h.note ? `<p class="hof-note">${esc(h.note)}</p>` : ''}
  </article>`;
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
  // most decorated
  const tally = {};
  all.forEach(h=>{ const k = hofKey(h); const t = tally[k] = tally[k] || {key:k, h, champion:0, runner_up:0, third:0, award:0, total:0}; t[h.type in t ? h.type : 'award']++; t.total++ });
  const ranked = Object.values(tally).sort((a,b)=> b.champion-a.champion || b.runner_up-a.runner_up || b.third-a.third || b.award-a.award);
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
      <h2 class="card-title">Most decorated</h2>
      <div class="decorated">
        ${ranked.slice(0,6).map((t,i)=>{ const p = hofPlayer(t.h); return `
          <button type="button" class="decorated-item ${hofFilter.player===t.key?'active':''}" data-key="${esc(hofFilter.player===t.key?'all':t.key)}" onclick="setHofFilter('player', this.dataset.key)" aria-pressed="${hofFilter.player===t.key}">
            <span class="rank-badge ${rankClass(i)}">${i+1}</span>${renderAvatar(p,36)}
            <span class="grow"><b>${esc(p.name)}</b><span class="decorated-counts">${t.champion?`<i class="gold">${t.champion}×1st</i>`:''}${t.runner_up?`<i class="silver">${t.runner_up}×2nd</i>`:''}${t.third?`<i class="bronze">${t.third}×3rd</i>`:''}${t.award?`<i class="award">${t.award} award${t.award>1?'s':''}</i>`:''}</span></span>
          </button>`}).join('')}
      </div>
    </section>` : ''}

    <div class="hof-bar">
      <div class="hof-bar-filters">
        ${seg('org', [['all','All'],['ours',esc(titleCase(commName()))],['other','Other organisers']])}
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
      years.map(y=>`<section class="hof-year"><div class="hof-year-label">${esc(y)}</div><div class="grid grid-3">${byYear[y].map(h=>hofCard(h, admin)).join('')}</div></section>`).join('')}
    </div>`;
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
          ${Object.entries(HOF_TYPES).filter(([k])=>k!=='award').map(([k,t])=>`<label class="hof-type ${t.cls}"><input type="radio" name="h_type" value="${k}" ${h.type===k?'checked':''} onchange="hofTypeChanged()"><span class="hof-medal ${t.cls}">${t.medal}</span>${t.label}</label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="h_tournament">Tournament</label>
        <input class="form-input" id="h_tournament" maxlength="80" value="${esc(h.tournament||'')}" placeholder="e.g. Milandhoo Champions League Season 4">
      </div>
      <div class="form-group">
        <span class="form-label">Organised by</span>
        <div class="flex gap-8" style="flex-wrap:wrap">
          <label class="radio-pill"><input type="radio" name="h_org" value="ours" ${h.organizer!=='other'?'checked':''} onchange="document.getElementById('h_orgname_wrap').classList.add('hidden')">${esc(titleCase(commName()))}</label>
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
const HOF_PER_PAGE = 15;
function exportHofSheet(){
  const list = hofFiltered();
  const parts = chunk(list, HOF_PER_PAGE);
  const pages = parts.map((part, i)=>{
    const body = `<div class="xs-grid" style="grid-template-columns:repeat(${Math.max(1,Math.min(3,part.length))}, 330px)">${part.map(h=>hofCard(h,false)).join('')}</div>`;
    return sheetHeader(null, 'Hall of Fame', `${list.length} achievement${list.length===1?'':'s'}${parts.length>1?` · Page ${i+1} of ${parts.length}`:''} · ${fmtDate(new Date())}`) + body + sheetFoot(i+1, parts.length);
  });
  return renderSheets(pages, 3*330 + 2*18 + 56, 'hall_of_fame');
}

/* =========================
   LEADERBOARD
   ========================= */
function renderLeaderboard(){
  const stats = calculateAllStats();
  const enriched = rankPlayers(stats);
  const totalMatches = Math.round(enriched.reduce((s,x)=>s+x.s.matches,0)/2);
  const totalGoals = enriched.reduce((s,x)=>s+x.s.gf,0);
  setHeader('Community', 'Leaderboard');
  document.getElementById('main').innerHTML = `
    <div class="grid grid-4">
      ${statTile('users','tint-blue','Players', STORE.players.length)}
      ${statTile('ball','tint-purple','Matches played', totalMatches)}
      ${statTile('goal','tint-green','Goals scored', totalGoals)}
      ${statTile('trophy','tint-gold','Completed tournaments', STORE.tournaments.filter(t=>t.status==='completed').length)}
    </div>
    <section id="leaderboardExport" class="export-container" style="display:flex;flex-direction:column;gap:14px" aria-label="Community leaderboard">
      <div class="export-header"><div class="export-title">${esc(titleCase(commName()))} · Leaderboard</div><div class="export-subtitle">Rankings as of ${fmtDate(new Date())}</div></div>
      <div class="flex-between no-export">
        <div class="flex gap-8" style="align-items:center;flex-wrap:wrap">${STORE.mode==='shared' ? `<span class="admin-indicator live-indicator">Live</span>` : ''}<span class="page-sub">Ranked by titles, then wins, then win rate</span></div>
        <button type="button" class="export-btn" onclick="exportAsJPEG('leaderboardExport','milandhoo_leaderboard')">${ICON_DL} Export leaderboard</button>
      </div>
      <div class="table-wrap">${lbTable(enriched, 0)}</div>
      <div class="table-hint no-export">Turn your phone sideways to see draws, losses, goal difference and podium finishes.</div>
    </section>`;
}

/* The leaderboard table: used on the page and, 10 players per page, in the export. */
function lbTable(rows, offset){
  return `
        <table class="group-table lb-table">
          <thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">P</th><th scope="col">W</th><th scope="col">D</th><th scope="col">L</th><th scope="col">GD</th><th scope="col">Win %</th><th scope="col">2nd</th><th scope="col">3rd</th><th scope="col">Titles</th></tr></thead>
          <tbody>
            ${rows.length===0 ? `<tr><td colspan="11" class="t-center text-muted" style="padding:40px">No players yet</td></tr>` :
              rows.map((x,j)=>{ const i = offset + j; const gd = x.s.gf-x.s.ga; return `
                <tr class="${i<3 && x.s.matches?'qualify':''}">
                  <td><span class="rank-badge ${rankClass(i)}">${i+1}</span></td>
                  <td><span class="who">${renderAvatar(x.p, 34)}<span style="min-width:0">${esc(x.p.name)}</span></span></td>
                  <td>${x.s.matches}</td><td>${x.s.wins}</td><td>${x.s.draws}</td><td>${x.s.losses}</td>
                  <td style="color:var(--text-2)">${gd>0?'+':''}${gd}</td>
                  <td style="color:var(--primary-dark);font-weight:700">${x.s.winPct}%</td>
                  <td>${x.s.tourneyRunnerUp}</td>
                  <td>${x.s.tourneyThird}</td>
                  <td>${x.s.tourneyWins>0 ? `<span class="badge badge-draft">${x.s.tourneyWins}</span>` : '0'}</td>
                </tr>`}).join('')}
          </tbody>
        </table>`;
}
const LB_PER_PAGE = 10;
function exportLeaderboardSheet(){
  const enriched = rankPlayers(calculateAllStats());
  const parts = chunk(enriched, LB_PER_PAGE);
  const pages = parts.map((part, i)=> sheetHeader(null, 'Community Leaderboard', `Ranked by titles, then wins, then win rate · ${fmtDate(new Date())}${parts.length>1?` · Page ${i+1} of ${parts.length}`:''}`)
    + `<div class="xs-card">${lbTable(part, i*LB_PER_PAGE)}</div>` + sheetFoot(i+1, parts.length));
  return renderSheets(pages, 900, 'milandhoo_leaderboard');
}

/* =========================
   ADMIN
   ========================= */
function renderAdmin(){
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

/* Init */
boot();
setInterval(()=>{ if(isAdmin()) STORE.tournaments.filter(t=>t.status==='active').forEach(t=>processDeadline(t.id)) }, 30000);
