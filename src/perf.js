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
async function syncAppIcons(){
  const st = STORE.settings || {}, logo = st.logo;
  if(iconsRunning || !isAdmin() || !AUTH.sb) return;
  if(!logo){ if(st.appIcons) saveSettings({appIcons:null}); return }
  if(!isMediaUrl(logo) || (st.appIcons && st.appIcons.from===logo)) return;
  iconsRunning = true;
  try{
    // Redraw from the original picture and saved crop for sharp large icons; fall back to the logo itself.
    let art;
    try{
      if(!st.logoSrc || !st.logoCrop) throw new Error('no source');
      const img = await loadImage(st.logoSrc);
      art = document.createElement('canvas'); art.width = art.height = 1024;
      paintCrop({img, opts:LOGO_OPTS, zoom:st.logoCrop.zoom||1, x:st.logoCrop.x||0, y:st.logoCrop.y||0, ready:true}, art.getContext('2d'), 1024, null);
    }catch{ art = await loadImage(logo) }
    const draw = (size, scale)=>{
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d'); g.fillStyle = '#0B1B3F'; g.fillRect(0, 0, size, size);
      g.imageSmoothingQuality = 'high';
      const s = size*scale; g.drawImage(art, (size-s)/2, (size-s)/2, s, s);
      return c.toDataURL('image/png');
    };
    const icons = {from:logo};
    for(const [key, size, scale] of [['192',192,1], ['512',512,1], ['mask',512,0.8], ['180',180,1], ['32',32,1]]){
      icons[key] = await uploadDataUrl(draw(size, scale), 'app');
    }
    if((STORE.settings||{}).logo===logo) saveSettings({appIcons:icons});
  }catch(e){ console.warn('Home-screen icon not updated', e) }
  finally{ iconsRunning = false }
}
