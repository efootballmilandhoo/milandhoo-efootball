/* EduMaldives web adapter: provides the same window.claude.use(...) API the portal uses inside Claude,
   backed by Supabase (auth, database, storage) and a Supabase Edge Function for AI. */
(function () {
  var SB_URL = "https://pnzchmpvcucoctfbvvit.supabase.co";
  var SB_KEY = "sb_publishable_zSDb_cKWsRnOQKjqW2a1cA_kz6bP-tE";
  var REF = "pnzchmpvcucoctfbvvit";
  var sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  window.__SB = sb;
  window.__WEB = true;
  // No Supabase session => the app must show the login page.
  try { if (!localStorage.getItem("sb-" + REF + "-auth-token")) localStorage.removeItem("em-user"); } catch (e) {}

  var sessionP = sb.auth.getSession().then(function (r) { return r.data && r.data.session; }).catch(function () { return null; });
  var uidP = sessionP.then(function (s) { return s && s.user ? s.user.id : null; });
  var adminP = uidP.then(function (u) { return u ? sb.rpc("is_admin").then(function (r) { return !!r.data; }) : false; }).catch(function () { return false; });

  /* ---------------- database ---------------- */
  var listeners = new Set();
  var notify = function () { listeners.forEach(function (f) { try { f(); } catch (e) {} }); };
  var clone = function (x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); };
  var mkSnap = function (path, row) { return { id: path.split("/").pop(), exists: !!row, data: function () { return row ? clone(row.data) : undefined; }, metadata: { fromCache: false, hasPendingWrites: false } }; };
  var err = function (e) { var x = new Error((e && e.message) || "Database error"); x.code = e && e.code === "42501" ? "permission_denied" : "unavailable"; return x; };
  var getRow = async function (path) { var r = await sb.from("docs").select("path,data").eq("path", path).maybeSingle(); if (r.error) throw err(r.error); return r.data; };
  /* Built-in content (analysed papers, questions, study packs) ships as static files under /seed.
     Rows saved in Supabase override it; a deleted built-in row is kept as a {_del:true} marker. */
  var SEEDED = { papers: 1, pqp: 1, rgrp: 1, study: 1 };
  var seedCache = {};
  var getJSON = function (u) { if (!seedCache[u]) seedCache[u] = fetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); return seedCache[u]; };
  var isSeeded = function (path) { var a = path.split("/"); return a.length === 2 && SEEDED[a[0]]; };
  var seedDoc = async function (path) { if (!isSeeded(path) || path.indexOf("pqp/") === 0) return null; var d = await getJSON("/seed/" + path.split("/").map(encodeURIComponent).join("/") + ".json"); return d ? { path: path, data: d } : null; };
  var seedCol = async function (col, filters) {
    if (!SEEDED[col]) return [];
    var sub = null; filters.forEach(function (f) { if (f[0] === "sub" && (f[1] === "==" || f[1] === "eq")) sub = f[2]; });
    var rows = sub != null ? await getJSON("/seed/" + col + "/_sub/" + String(sub).replace(/[^A-Za-z0-9]+/g, "_") + ".json") : col === "papers" ? await getJSON("/seed/papers/_all.json") : null;
    return (rows || []).map(function (r) { return { path: col + "/" + r[0], data: r[1] }; });
  };
  var dbRow = getRow;
  getRow = async function (path) { var r = await dbRow(path); if (r) return r.data && r.data._del ? null : r; return seedDoc(path); };
  var fetchCol = async function (col) {
    var depth = col.split("/").length + 1, out = [], from = 0;
    for (;;) {
      var q = sb.from("docs").select("path,data").like("path", col.replace(/[%_]/g, "\\$&") + "/%").range(from, from + 999);
      var r = await q; if (r.error) throw err(r.error);
      out = out.concat(r.data || []); if (!r.data || r.data.length < 1000) break; from += 1000;
    }
    return out.filter(function (x) { return x.path.split("/").length === depth; });
  };
  var docRef = function (path) {
    return {
      id: path.split("/").pop(), path: path,
      get: async function () { return mkSnap(path, await getRow(path)); },
      set: async function (d) { var r = await sb.from("docs").upsert({ path: path, data: clone(d) }); if (r.error) throw err(r.error); notify(); },
      update: async function (d) { var cur = await getRow(path); var r = await sb.from("docs").upsert({ path: path, data: Object.assign({}, cur ? cur.data : {}, clone(d)) }); if (r.error) throw err(r.error); notify(); },
      delete: async function () {
        var r = isSeeded(path) ? await sb.from("docs").upsert({ path: path, data: { _del: true } }) : await sb.from("docs").delete().eq("path", path);
        if (r.error) throw err(r.error); notify();
      },
      onSnapshot: function (fn, onErr) {
        var alive = true, run = function () { getRow(path).then(function (row) { if (alive) fn(mkSnap(path, row)); }).catch(function (e) { if (alive && onErr) onErr(err(e)); }); };
        run(); listeners.add(run); var t = setInterval(run, 20000);
        return function () { alive = false; listeners.delete(run); clearInterval(t); };
      },
      collection: function (p) { return coll(path + "/" + p); }
    };
  };
  var test = function (data, f) {
    var x = (data || {})[f[0]], op = f[1], v = f[2];
    return op === "==" || op === "eq" ? x === v : op === "in" ? (v || []).indexOf(x) >= 0 : op === "array-contains" ? (x || []).indexOf(v) >= 0 : op === ">=" ? x >= v : op === "<=" ? x <= v : op === ">" ? x > v : op === "<" ? x < v : op === "!=" ? x !== v : op === "not-in" ? (v || []).indexOf(x) < 0 : true;
  };
  var query = function (col, filters, ord, lim) {
    var run = async function () {
      var live = await fetchCol(col), seen = {}, rows = [];
      live.forEach(function (r) { seen[r.path] = 1; if (!(r.data && r.data._del)) rows.push(r); });
      (await seedCol(col, filters)).forEach(function (r) { if (!seen[r.path]) rows.push(r); });
      var docs = rows.map(function (r) { return mkSnap(r.path, r); }).filter(function (d) { var dd = d.data(); return filters.every(function (f) { return test(dd, f); }); });
      if (ord) docs.sort(function (a, b) { var x = a.data()[ord[0]], y = b.data()[ord[0]]; return (x > y ? 1 : x < y ? -1 : 0) * (ord[1] === "desc" ? -1 : 1); });
      docs = docs.slice(0, lim);
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
    };
    return {
      where: function (f, op, v) { return query(col, filters.concat([[f, op, v]]), ord, lim); },
      orderBy: function (f, dir) { return query(col, filters, [f, dir || "asc"], lim); },
      limit: function (n) { return query(col, filters, ord, n); },
      get: run,
      onSnapshot: function (fn, onErr) {
        var alive = true, go = function () { run().then(function (s) { if (alive) fn(s); }).catch(function (e) { if (alive && onErr) onErr(e); }); };
        go(); listeners.add(go); var t = setInterval(go, 30000);
        return function () { alive = false; listeners.delete(go); clearInterval(t); };
      }
    };
  };
  var rid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); };
  var coll = function (p) {
    var q = query(p, [], null, 1000);
    q.path = p;
    q.doc = function (id) { return docRef(p + "/" + (id || rid())); };
    q.add = async function (d) { var r = docRef(p + "/" + rid()); await r.set(d); return r; };
    return q;
  };
  var db = { doc: docRef, collection: coll };

  /* ---------------- user ---------------- */
  var user = {
    id: function () { return uidP; },
    canEdit: function () { return adminP; },
    isOwner: function () { return false; },
    can: function () { return null; },
    me: async function () { var s = await sessionP; var m = (s && s.user && s.user.user_metadata) || {}; return { id: s && s.user ? s.user.id : null, name: m.name || "" }; },
    profiles: async function (ids) {
      var out = {}; if (!ids || !ids.length) return out;
      var r = await sb.rpc("member_names", { ids: ids });
      (r.data || []).forEach(function (x) { out[x.id] = { id: x.id, name: x.name || "" }; });
      return out;
    }
  };

  /* ---------------- files ---------------- */
  var assets = {
    upload: async function (blob) {
      var u = await uidP; if (!u) throw new Error("Log in to upload files.");
      var ext = ((blob.name || "").match(/\.[a-z0-9]+$/i) || [""])[0];
      var path = u + "/" + rid() + ext;
      var r = await sb.storage.from("files").upload(path, blob, { contentType: blob.type || "application/octet-stream" });
      if (r.error) throw new Error(r.error.message);
      var s = await sb.storage.from("files").createSignedUrl(path, 3600);
      return { id: "sb:" + path, url: s.data && s.data.signedUrl, sizeBytes: blob.size, contentType: blob.type };
    },
    delete: async function (id) { await sb.storage.from("files").remove([String(id).replace(/^sb:/, "")]); },
    list: async function () { return { assets: [], usage: {} }; }
  };
  window.__sbFileUrl = async function (id) { var s = await sb.storage.from("files").createSignedUrl(String(id).replace(/^sb:/, ""), 3600); return s.data && s.data.signedUrl; };

  var downloads = {
    save: async function (o) {
      var b = o.data instanceof Blob ? o.data : new Blob([o.data]);
      var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = o.filename || "download"; document.body.appendChild(a); a.click(); a.remove();
      return "saved";
    }
  };

  /* ---------------- AI ---------------- */
  var b64 = function (blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(",")[1]); }; r.onerror = rej; r.readAsDataURL(blob); }); };
  var sample = async function (input, opts) {
    opts = opts || {};
    var imgs = [];
    if (opts.images && opts.images.length) for (var i = 0; i < opts.images.length; i++) imgs.push({ mime: opts.images[i].type || "image/jpeg", b64: await b64(opts.images[i]) });
    var r = await sb.functions.invoke("ai", { body: { input: input, images: imgs, tier: opts.modelTier || "default" } });
    if (r.error) {
      var body = null; try { body = await r.error.context.json(); } catch (e) {}
      var x = new Error((body && body.message) || "AI is not available right now."); x.code = (body && body.code) || "unavailable"; x.message = x.message; throw x;
    }
    var text = (r.data && r.data.text) || "";
    if (opts.onText) try { opts.onText({ text: text, delta: text }); } catch (e) {}
    return { text: text, truncated: !!(r.data && r.data.truncated) };
  };
  sample.json = async function (input, opts) {
    var t = (await sample(input, opts)).text;
    try { return JSON.parse(t); } catch (e) {}
    var a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("The AI reply could not be read. Please try again.");
  };
  sample.limits = async function () { return { images: { maxCount: 4 } }; };

  window.claude = {
    use: function (name) {
      return uidP.then(function (u) {
        if (name === "db") return u ? db : null;
        if (name === "user") return user;
        if (name === "assets") return u ? assets : null;
        if (name === "downloads") return downloads;
        if (name === "sample") return u ? sample : null;
        return null;
      });
    }
  };
})();
