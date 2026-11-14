// ConditionChecklist PWA - Phase 1: inspections, rooms, items, photos; everything offline in IndexedDB.
"use strict";
const VERSION = "0.5";
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }; // local date, not UTC

// ---------------------------------------------------------------- storage (IndexedDB)
let dbp;
function db() {
  return dbp ??= new Promise((ok, bad) => {
    const r = indexedDB.open("condition-checklist", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("inspections", { keyPath: "id" });
      d.createObjectStore("photos", { keyPath: "id" }).createIndex("insp", "inspectionId");
    };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((ok, bad) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store); let out;
    Promise.resolve(fn(s)).then(v => out = v);
    t.oncomplete = () => ok(out); t.onerror = () => bad(t.error);
  });
}
const req = r => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
const getAll = () => tx("inspections", "readonly", s => req(s.getAll()));
const getInsp = id => tx("inspections", "readonly", s => req(s.get(id)));
const putInsp = i => { i.updatedAt = new Date().toISOString(); return tx("inspections", "readwrite", s => req(s.put(i))).then(r => { scheduleSync(); return r; }); };
const rawPut = i => tx("inspections", "readwrite", s => req(s.put(i))); // save without counting as an edit
const getPhoto = id => tx("photos", "readonly", s => req(s.get(id)));
const putPhoto = p => tx("photos", "readwrite", s => req(s.put(p)));
const delPhoto = id => tx("photos", "readwrite", s => req(s.delete(id)));
const photosOf = iid => tx("photos", "readonly", s => req(s.index("insp").getAll(iid)));

// ---------------------------------------------------------------- helpers
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2200); }
function setHeader(title, back) { $("#title").textContent = title; const b = $("#back"); b.hidden = !back; b.onclick = () => location.hash = back; }
const urlCache = new Map();
async function photoURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const p = await getPhoto(id); if (!p) return "";
  const u = URL.createObjectURL(p.blob); urlCache.set(id, u); return u;
}
// shrink camera photos (often 4-12 MB) to max 1600 px JPEG so a whole house fits on the phone
async function compress(file) {
  const img = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!img) return { blob: file, w: 0, h: 0 };
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.8));
  return { blob, w: c.width, h: c.height };
}
// Property list = company list (private Google Sheet on ewpm805, via Apps Script, cached on the phone for offline)
// + the phone's own list (Settings) + every address used before. Nothing private is in this public code:
// the Apps Script id + key arrive once per phone through a "connect" link (#/connect/<id>/<key>).
function savedProps() { try { return JSON.parse(localStorage.getItem("properties") || "[]"); } catch { return []; } }
function companyProps() { try { return JSON.parse(localStorage.getItem("companyProps") || "[]"); } catch { return []; } }
function cloud() { try { return JSON.parse(localStorage.getItem("cloud") || "null"); } catch { return null; } }
async function callCloud(action, data = {}) {
  const c = cloud(); if (!c) throw new Error("not connected");
  const r = await fetch(`https://script.google.com/macros/s/${c.id}/exec`, { method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: c.key, action, ...data }) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j;
}
async function refreshCompany(force) {
  if (!cloud() || !navigator.onLine) return false;
  const last = +localStorage.getItem("companyAt") || 0;
  if (!force && Date.now() - last < 6 * 3600e3) return false;
  const j = await callCloud("properties");
  localStorage.setItem("companyProps", JSON.stringify(j.properties)); localStorage.setItem("companyAt", Date.now());
  return j.properties.length;
}
function tenantFor(address) {
  const m = companyProps().find(p => p.a.toLowerCase() === (address || "").trim().toLowerCase()); return m ? m.t : "";
}
function propertyList(inspections = []) {
  const seen = new Map();
  for (const a of [...companyProps().map(p => p.a), ...savedProps(), ...inspections.map(i => i.address)]) {
    const t = (a || "").trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function rememberProperty(a) {
  if (companyProps().some(p => p.a.toLowerCase() === a.toLowerCase())) return;
  const list = savedProps();
  if (!list.some(x => x.toLowerCase() === a.toLowerCase())) { list.push(a); localStorage.setItem("properties", JSON.stringify(list)); }
}
async function connect(id, key) {
  localStorage.setItem("cloud", JSON.stringify({ id, key }));
  history.replaceState(null, "", location.pathname + "#/settings"); // don't leave the key in the address bar
  try { const n = await refreshCompany(true); toast(`Connected - ${n} company properties loaded`); }
  catch (e) { localStorage.removeItem("cloud"); toast("Connect failed: " + e.message); }
  route();
}

async function viewSettings() {
  setHeader("Settings", "#/");
  const c = cloud(), at = +localStorage.getItem("companyAt");
  $("#view").innerHTML = `<div class="card"><b>Company property list</b>
    <p class="muted">${c ? `Connected ✓ - ${companyProps().length} properties${at ? ", updated " + new Date(at).toLocaleString() : ""}. Works offline; refreshes itself when online.`
      : "Not connected. Copy the connect link from the ConditionChecklist Google Sheet (tab Connect, cell B3), paste it below and tap Connect. (On Android you can also just tap the link.)"}</p>
    ${c ? `<div class="row"><button class="grow" id="crefresh">Refresh now</button></div>`
      : `<input id="clink" placeholder="Paste the connect link here" autocomplete="off"><div class="row" style="margin-top:8px"><button class="primary grow" id="cgo">Connect</button></div>`}</div>
    <div class="card"><b>My extra properties</b>
    <p class="muted">One address per line, for properties not in the company list. Saved on this phone only. Addresses you type in an inspection are added automatically.</p>
    <textarea id="plist" style="min-height:160px">${esc(savedProps().join("\n"))}</textarea>
    <div class="row" style="margin-top:8px"><button class="primary grow" id="psave">Save list</button></div></div>`;
  if (!c) $("#cgo").onclick = () => {
    const m = $("#clink").value.trim().match(/#\/connect\/([\w-]+)\/(\w+)/);
    if (!m) return toast("That is not the connect link - copy cell B3 of the Connect tab");
    connect(m[1], m[2]);
  };
  if (c) $("#crefresh").onclick = async () => {
    try { const n = await refreshCompany(true); toast(n === false ? "Offline - try later" : `${n} properties loaded`); viewSettings(); }
    catch (e) { toast("Refresh failed: " + e.message); }
  };
  $("#psave").onclick = () => {
    const list = [...new Set($("#plist").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    localStorage.setItem("properties", JSON.stringify(list)); toast(`${list.length} properties saved`); location.hash = "#/";
  };
}

// Typed-in values are remembered on the phone and offered as suggestions next time.
function typed(kind) { try { return JSON.parse(localStorage.getItem("typed_" + kind) || "[]"); } catch { return []; } }
function rememberTyped(kind, v) { v = (v || "").trim(); if (!v) return; const l = typed(kind).filter(x => x.toLowerCase() !== v.toLowerCase()); l.unshift(v); localStorage.setItem("typed_" + kind, JSON.stringify(l.slice(0, 50))); }
function datalist(id, values) { return `<datalist id="${id}">${[...new Set(values)].map(v => `<option value="${esc(v)}">`).join("")}</datalist>`; }
const GENERIC_ITEMS = ["Floor / Coverings", "Walls / Coverings", "Ceiling", WIN, "Lighting", "Electrical outlets"];
function customRoom(name) { return { id: uid(), type: "custom", name, items: GENERIC_ITEMS.map(n => ({ id: uid(), name: n, cond: "", note: "", cost: "", photos: [] })) }; }
const hasCost = i => i.type !== "Move-in";
// Export status: "never" (nothing exported yet), "changed" (edited after the last export), "ok".
function exportState(i) { return !i.exportedAt ? "never" : (i.updatedAt > i.exportedAt ? "changed" : "ok"); }
function fmtTime(iso) { return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }); }

function itemsDone(room) { return room.items.filter(i => i.cond).length; }
function allItems(insp) { return insp.rooms.flatMap(r => r.items.map(i => ({ room: r, item: i }))); }
function short(addr) { return (addr || "").split(",")[0]; }

function buildRooms(o) {
  const rooms = [];
  for (const t of CHECKLIST) {
    if (t.optional && !o.include[t.type]) continue;
    const n = t.repeat ? Math.max(0, +o[t.repeat] || 0) : 1;
    for (let k = 1; k <= n; k++)
      rooms.push({ id: uid(), type: t.type, name: t.repeat ? `${t.name} ${k}` : t.name,
        items: t.items.map(name => ({ id: uid(), name, cond: "", note: "", cost: "", photos: [] })) });
  }
  return rooms;
}

// ---------------------------------------------------------------- views
async function viewList() {
  setHeader("Condition Checklist");
  const list = (await getAll()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $("#view").innerHTML = `
    <div class="row" style="margin-bottom:12px"><button class="primary grow" onclick="location.hash='#/new'">+ New inspection</button></div>
    ${list.length ? "" : `<p class="muted">No inspections yet. Everything you enter is saved on this phone, even with no internet.</p>`}
    ${list.map(i => {
      const all = allItems(i), done = all.filter(x => x.item.cond).length;
      return `<div class="card" onclick="location.hash='#/i/${i.id}'" style="cursor:pointer">
        <div class="row"><span class="badge ${i.type === "Move-in" ? "in" : "out"}">${esc(i.type)}</span><b class="grow">${esc(short(i.address))}</b><span class="muted">${cloud() ? (synced(i) ? "☁✓ " : "☁… ") : ""}${esc(i.date)}</span></div>
        <div class="muted">${esc(i.unit ? "Unit " + i.unit + " · " : "")}${esc(i.tenant || "")}</div>
        <div class="prog">${done} / ${all.length} items checked</div><div class="bar"><i style="width:${all.length ? 100 * done / all.length : 0}%"></i></div></div>`;
    }).join("")}
    <p class="muted" style="text-align:center"><a href="#/settings" style="color:inherit">Settings (property list)</a> · v${VERSION}</p>`;
}

async function viewNew() {
  setHeader("New inspection", "#/");
  const all = await getAll(), ins = all.filter(i => i.type === "Move-in");
  const opt = CHECKLIST.filter(t => t.optional);
  const props = propertyList(all), lastInsp = localStorage.getItem("inspector") || "";
  $("#view").innerHTML = `<div class="card">
    <label>Type</label><div class="seg" id="type"><button data-v="Move-in" class="on" style="background:var(--accent);color:#fff">Move-in</button><button data-v="Move-out">Move-out</button><button data-v="__other">Other…</button></div>
    <input id="typeother" list="dl-type" placeholder="Type of inspection, e.g. Periodic / Annual" hidden style="margin-top:6px">${datalist("dl-type", ["Periodic", "Annual", "Pre-listing", ...typed("type")])}
    <label>Property address</label>
    <select id="addrpick"><option value="">${props.length ? "Select a property…" : "No property list yet - type below"}</option>${props.map(a => `<option>${esc(a)}</option>`).join("")}</select>
    ${cloud() ? "" : `<p class="muted" style="margin:4px 0">Company list not connected on this phone. Open the link in the ConditionChecklist Sheet (tab Connect) once. <a href="#/settings">Settings</a></p>`}
    <input id="address" list="addrlist" placeholder="…or type the address" autocomplete="street-address" style="margin-top:6px">
    <datalist id="addrlist">${props.map(a => `<option value="${esc(a)}">`).join("")}</datalist>
    <label>Unit (optional)</label><input id="unit">
    <label>Tenant name(s)</label><input id="tenant">
    <label>Inspected by</label>
    <select id="inspsel">${STAFF.map(s => `<option ${s === lastInsp ? "selected" : ""}>${esc(s)}</option>`).join("")}<option value="__other" ${lastInsp && !STAFF.includes(lastInsp) ? "selected" : ""}>Other…</option></select>
    <input id="inspector" placeholder="Name" value="${esc(lastInsp && !STAFF.includes(lastInsp) ? lastInsp : "")}" ${lastInsp && !STAFF.includes(lastInsp) ? "" : "hidden"} style="margin-top:6px">
    <label>Date</label><input id="date" type="date" value="${today()}">
    <div class="row"><div class="grow"><label>Bedrooms</label><input id="bedrooms" type="number" min="0" max="10" value="3" inputmode="numeric"></div>
    <div class="grow"><label>Bathrooms</label><input id="bathrooms" type="number" min="0" max="10" value="2" inputmode="numeric"></div></div>
    <label>Also include</label><div class="seg" id="opt">${opt.map(t => `<button data-v="${t.type}" class="${t.type === "dining" || t.type === "garage" ? "on" : ""}">${esc(t.name)}</button>`).join("")}</div>
    <input id="otherrooms" list="dl-room" placeholder="Other rooms - type, separate with commas (e.g. Den, Loft)" style="margin-top:6px">${datalist("dl-room", ["Den", "Loft", "Office", "Bonus room", "Hallway", "Balcony", "Patio", "Basement", "Attic", "Storage", ...typed("room")])}
    <div id="linkbox" hidden><label>Compare with move-in inspection</label><select id="link"><option value="">(none)</option>
      ${ins.map(i => `<option value="${i.id}">${esc(short(i.address))} · ${esc(i.date)} · ${esc(i.tenant || "")}</option>`).join("")}</select></div>
    <div class="row" style="margin-top:14px"><button class="primary grow" id="create">Start inspection</button></div></div>`;
  const fillTenant = () => { const t = tenantFor($("#address").value); if (t && !$("#tenant").value.trim()) $("#tenant").value = t; };
  $("#addrpick").onchange = e => { if (e.target.value) { $("#address").value = e.target.value; fillTenant(); } };
  $("#address").onchange = fillTenant;
  $("#inspsel").onchange = e => { const other = e.target.value === "__other"; $("#inspector").hidden = !other; if (other) $("#inspector").focus(); };
  const paint = () => document.querySelectorAll("#opt button").forEach(b => b.style.cssText = b.classList.contains("on") ? "background:var(--accent);color:#fff" : "");
  paint();
  $("#opt").onclick = e => { if (e.target.dataset.v) { e.target.classList.toggle("on"); paint(); } };
  $("#type").onclick = e => {
    if (!e.target.dataset.v) return;
    document.querySelectorAll("#type button").forEach(b => { b.classList.toggle("on", b === e.target); b.style.cssText = b === e.target ? "background:var(--accent);color:#fff" : ""; });
    $("#linkbox").hidden = e.target.dataset.v !== "Move-out";
    $("#typeother").hidden = e.target.dataset.v !== "__other"; if (e.target.dataset.v === "__other") $("#typeother").focus();
  };
  $("#link").onchange = async () => { // copy room layout from the move-in so items line up
    const m = await getInsp($("#link").value); if (!m) return;
    $("#address").value = m.address; $("#unit").value = m.unit || ""; $("#tenant").value = m.tenant || "";
    $("#bedrooms").value = m.rooms.filter(r => r.type === "bedroom").length; $("#bathrooms").value = m.rooms.filter(r => r.type === "bathroom").length;
  };
  $("#create").onclick = async () => {
    const address = $("#address").value.trim(); if (!address) return toast("Select or type the property address");
    const inspector = $("#inspsel").value === "__other" ? $("#inspector").value.trim() : $("#inspsel").value;
    if (!inspector) return toast("Enter who is inspecting");
    let type = $("#type .on").dataset.v;
    if (type === "__other") { type = $("#typeother").value.trim(); if (!type) return toast("Type the kind of inspection"); rememberTyped("type", type); }
    const link = type === "Move-out" ? $("#link").value : "";
    const include = {}; document.querySelectorAll("#opt .on").forEach(b => include[b.dataset.v] = true);
    localStorage.setItem("inspector", inspector);
    rememberProperty(address);
    let rooms;
    const m = link && await getInsp(link);
    if (m) rooms = m.rooms.map(r => ({ ...r, id: uid(), linkRoom: r.id, items: r.items.map(i => ({ id: uid(), linkItem: i.id, name: i.name, cond: "", note: "", cost: "", photos: [] })) }));
    else rooms = buildRooms({ bedrooms: $("#bedrooms").value, bathrooms: $("#bathrooms").value, include });
    for (const n of $("#otherrooms").value.split(",").map(x => x.trim()).filter(Boolean)) { rooms.push(customRoom(n)); rememberTyped("room", n); }
    const insp = { id: uid(), app: "ConditionChecklist", version: VERSION, type, address, unit: $("#unit").value.trim(), tenant: $("#tenant").value.trim(),
      inspector, date: $("#date").value, linkedMoveIn: link || "", rooms, createdAt: new Date().toISOString(), status: "open" };
    await putInsp(insp); location.hash = `#/i/${insp.id}`;
  };
}

async function viewInspection(id) {
  const i = await getInsp(id); if (!i) return location.hash = "#/";
  setHeader(`${i.type} · ${short(i.address)}`, "#/");
  $("#view").innerHTML = `<div class="card"><div class="row"><span class="badge ${i.type === "Move-in" ? "in" : "out"}">${esc(i.type)}</span><b class="grow">${esc(i.address)}</b></div>
      <div class="muted">${esc(i.date)} · ${esc(i.tenant || "no tenant name")} · by ${esc(i.inspector || "?")}${i.linkedMoveIn ? " · compared with move-in" : ""}</div>
      ${cloud() ? `<div id="drive" class="noprint">${driveLine(i)}</div>` : exportState(i) === "changed" ? `<div class="warn noprint">Changed since last export (${esc(fmtTime(i.exportedAt))}) - export again so the office has the latest.</div>`
        : exportState(i) === "ok" ? `<div class="muted noprint">Exported ${esc(fmtTime(i.exportedAt))} ✓</div>` : `<div class="muted noprint">Not exported yet.</div>`}
      <div class="row noprint" style="margin-top:8px"><button class="grow" onclick="location.hash='#/i/${i.id}/report'">Report</button><button class="grow" id="export2">Export .zip</button></div></div>
    ${i.rooms.map(r => { const d = itemsDone(r), n = r.items.length;
      return `<div class="card room" onclick="location.hash='#/i/${i.id}/r/${r.id}'" style="cursor:pointer"><div class="grow"><b>${esc(r.name)}</b>
        <div class="prog">${d} / ${n}${r.items.some(x => x.photos.length) ? " · 📷 " + r.items.reduce((a, x) => a + x.photos.length, 0) : ""}</div><div class="bar"><i style="width:${100 * d / n}%"></i></div></div><span>›</span></div>`; }).join("")}
    <div class="card noprint"><div class="row"><select id="addtype" class="grow">${CHECKLIST.map(t => `<option value="${t.type}">${esc(t.name)}</option>`).join("")}<option value="__other">Other (type a name)…</option></select><button id="addroom">+ Add room</button></div>
      <input id="roomother" list="dl-room" placeholder="Room name, e.g. Den" hidden style="margin-top:6px">${datalist("dl-room", ["Den", "Loft", "Office", "Bonus room", "Hallway", "Balcony", "Patio", "Basement", "Attic", "Storage", ...typed("room")])}</div>
    <div class="row noprint"><button class="primary grow" onclick="location.hash='#/i/${i.id}/report'">Report</button><button id="export">Export .zip</button></div>
    <div class="row noprint" style="margin-top:24px"><button class="danger" id="del">Delete inspection</button></div>`;
  $("#addtype").onchange = e => { $("#roomother").hidden = e.target.value !== "__other"; if (!$("#roomother").hidden) $("#roomother").focus(); };
  $("#addroom").onclick = async () => {
    if ($("#addtype").value === "__other") {
      const n = $("#roomother").value.trim(); if (!n) return toast("Type the room name");
      rememberTyped("room", n); i.rooms.push(customRoom(n)); await putInsp(i); return viewInspection(id);
    }
    const t = CHECKLIST.find(x => x.type === $("#addtype").value);
    const same = i.rooms.filter(r => r.type === t.type).length;
    i.rooms.push({ id: uid(), type: t.type, name: same ? `${t.name} ${same + 1}` : t.name, items: t.items.map(name => ({ id: uid(), name, cond: "", note: "", cost: "", photos: [] })) });
    await putInsp(i); viewInspection(id);
  };
  $("#export").onclick = $("#export2").onclick = () => exportZip(i);
  if ($("#syncnow")) $("#syncnow").onclick = () => syncAll(true);
  $("#del").onclick = async () => {
    if (prompt(`Type DELETE to remove this inspection and its photos from this phone.`) !== "DELETE") return;
    for (const p of await photosOf(i.id)) await delPhoto(p.id);
    await tx("inspections", "readwrite", s => req(s.delete(i.id))); location.hash = "#/";
  };
}

async function viewRoom(id, rid) {
  const i = await getInsp(id), r = i?.rooms.find(x => x.id === rid); if (!r) return location.hash = `#/i/${id}`;
  setHeader(r.name, `#/i/${id}`);
  const m = i.linkedMoveIn && await getInsp(i.linkedMoveIn);
  const prior = it => m && m.rooms.flatMap(x => x.items).find(x => x.id === it.linkItem);
  const idx = i.rooms.indexOf(r), next = i.rooms[idx + 1];
  $("#view").innerHTML = `<div class="card">
    <div class="row noprint" style="margin-bottom:6px"><input id="rname" class="grow" value="${esc(r.name)}"><button id="allgood">All Good</button></div>
    ${r.items.map(it => { const p = prior(it); return `<div class="item" data-id="${it.id}">
      <div class="row"><input class="grow itemname" data-f="name" value="${esc(it.name)}" aria-label="Item name"><button class="icon" data-del="1" title="Remove item">✕</button></div>
      ${p ? `<div class="prior">Move-in: <b>${esc(p.cond || "not checked")}</b>${p.note ? " · " + esc(p.note) : ""}<div class="thumbs">${p.photos.map(ph => `<img data-ph="${ph}">`).join("")}</div></div>` : ""}
      <div class="seg">${CONDITIONS.map(c => `<button data-c="${c}" class="${it.cond === c ? "on" : ""}">${c}</button>`).join("")}<button data-c="__other" class="${it.cond && !CONDITIONS.includes(it.cond) ? "on" : ""}">${it.cond && !CONDITIONS.includes(it.cond) ? esc(it.cond) : "Other…"}</button></div>
      <input class="condother" list="dl-cond" data-f="cond" placeholder="Type the condition, e.g. Stained / Missing / New" value="${it.cond && !CONDITIONS.includes(it.cond) ? esc(it.cond) : ""}" ${it.cond && !CONDITIONS.includes(it.cond) ? "" : "hidden"} style="margin-top:6px">
      <textarea placeholder="Notes" data-f="note">${esc(it.note)}</textarea>
      ${hasCost(i) ? `<input placeholder="Cost to correct $" inputmode="decimal" data-f="cost" value="${esc(it.cost)}" style="margin-top:6px">` : ""}
      <div class="thumbs">${it.photos.map(ph => `<img data-ph="${ph}" data-own="1">`).join("")}<label class="add">📷<input type="file" accept="image/*" capture="environment" multiple hidden></label></div>
    </div>`; }).join("")}
    <div class="row noprint" style="margin-top:10px">${next ? `<button class="primary grow" onclick="location.hash='#/i/${id}/r/${next.id}'">Next: ${esc(next.name)} ›</button>` : `<button class="primary grow" onclick="location.hash='#/i/${id}'">Done ›</button>`}</div>
    <div class="row noprint" style="margin-top:10px"><input id="newitem" list="dl-item" class="grow" placeholder="Add an item to this room"><button id="additem">+</button></div>
    ${datalist("dl-item", [...typed("item"), ...CHECKLIST.flatMap(t => t.items)])}${datalist("dl-cond", ["Stained", "Missing", "Broken", "Dirty", "Worn", "Scratched", "Dented", "Not working", "New", ...typed("cond")])}
    <div class="row noprint" style="margin-top:18px"><button class="danger" id="delroom">Remove this room</button></div></div>`;
  document.querySelectorAll("img[data-ph]").forEach(async im => im.src = await photoURL(im.dataset.ph));
  const save = () => putInsp(i);
  $("#rname").onchange = e => { r.name = e.target.value.trim() || r.name; save(); };
  $("#allgood").onclick = async () => { r.items.forEach(it => it.cond ||= "Good"); await save(); viewRoom(id, rid); };
  $("#delroom").onclick = async () => {
    const ph = r.items.reduce((a, x) => a + x.photos.length, 0);
    if (!confirm(`Remove "${r.name}"${ph ? ` and its ${ph} photo(s)` : ""}?`)) return;
    for (const it of r.items) for (const p of it.photos) await delPhoto(p);
    i.rooms = i.rooms.filter(x => x !== r); await save(); location.hash = `#/i/${id}`;
  };
  $("#additem").onclick = async () => { const n = $("#newitem").value.trim(); if (!n) return; rememberTyped("item", n); r.items.push({ id: uid(), name: n, cond: "", note: "", cost: "", photos: [] }); await save(); viewRoom(id, rid); };
  $("#view").onclick = async e => {
    const box = e.target.closest(".item"); if (!box) return;
    const it = r.items.find(x => x.id === box.dataset.id);
    if (e.target.dataset.del) {
      if ((it.photos.length || it.note || it.cond) && !confirm(`Remove "${it.name}"${it.photos.length ? ` and its ${it.photos.length} photo(s)` : ""}?`)) return;
      for (const p of it.photos) await delPhoto(p);
      r.items = r.items.filter(x => x !== it); await save(); return viewRoom(id, rid);
    }
    if (e.target.dataset.c === "__other") { const o = box.querySelector(".condother"); o.hidden = false; o.focus(); return; }
    if (e.target.dataset.c) { it.cond = it.cond === e.target.dataset.c ? "" : e.target.dataset.c;
      const o = box.querySelector(".condother"); o.hidden = true; o.value = "";
      box.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.c === it.cond));
      box.querySelector('[data-c="__other"]').textContent = "Other…"; save(); }
    if (e.target.dataset.ph) showPhoto(e.target.dataset.ph, e.target.dataset.own && (async () => {
      it.photos = it.photos.filter(x => x !== e.target.dataset.ph); await delPhoto(e.target.dataset.ph); await save(); viewRoom(id, rid); }));
  };
  $("#view").oninput = e => { const box = e.target.closest(".item"); if (!box || !e.target.dataset.f) return;
    r.items.find(x => x.id === box.dataset.id)[e.target.dataset.f] = e.target.value; clearTimeout(viewRoom.t); viewRoom.t = setTimeout(save, 400); };
  $("#view").onchange = async e => {
    if (e.target.classList.contains("condother")) { // typed condition (value already saved by oninput)
      const box = e.target.closest(".item"), v = e.target.value.trim(); rememberTyped("cond", v);
      box.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", !!v && b.dataset.c === "__other"));
      box.querySelector('[data-c="__other"]').textContent = v || "Other…"; return;
    }
    if (e.target.classList.contains("itemname")) {
      const it = r.items.find(x => x.id === e.target.closest(".item").dataset.id);
      if (!e.target.value.trim()) e.target.value = it.name = "Item";
      rememberTyped("item", e.target.value.trim()); save(); return;
    }
    if (e.target.type !== "file") return;
    const box = e.target.closest(".item"), it = r.items.find(x => x.id === box.dataset.id);
    for (const f of e.target.files) {
      const { blob, w, h } = await compress(f);
      const pid = uid(); await putPhoto({ id: pid, inspectionId: i.id, itemId: it.id, blob, w, h, takenAt: new Date().toISOString() });
      it.photos.push(pid); if (!it.cond) it.cond = "";
    }
    await save(); toast(`${e.target.files.length} photo(s) saved`); viewRoom(id, rid);
  };
}

async function showPhoto(pid, onDelete) {
  const v = document.createElement("div"); v.className = "viewer";
  v.innerHTML = `<img src="${await photoURL(pid)}"><div class="row">${onDelete ? `<button class="danger" id="pdel">Delete photo</button>` : ""}<button id="pclose">Close</button></div>`;
  document.body.append(v);
  v.querySelector("#pclose").onclick = () => v.remove();
  if (onDelete) v.querySelector("#pdel").onclick = () => { v.remove(); onDelete(); };
}

async function viewReport(id) {
  const i = await getInsp(id); if (!i) return location.hash = "#/";
  setHeader("Report", `#/i/${id}`);
  const m = i.linkedMoveIn && await getInsp(i.linkedMoveIn);
  const prior = it => m && m.rooms.flatMap(x => x.items).find(x => x.id === it.linkItem);
  const total = allItems(i).reduce((a, x) => a + (parseFloat(x.item.cost) || 0), 0);
  $("#view").innerHTML = `<div class="card"><h2 style="margin:0">${esc(i.type)} Inspection</h2>
    <p>${esc(i.address)}${i.unit ? ", Unit " + esc(i.unit) : ""}<br>Tenant: ${esc(i.tenant)}<br>Date: ${esc(i.date)} · Inspected by: ${esc(i.inspector)}${m ? `<br>Move-in inspection: ${esc(m.date)}` : ""}</p>
    ${hasCost(i) ? `<p><b>Total cost to correct: $${total.toFixed(2)}</b></p>` : ""}
    <div class="row noprint"><button class="primary" onclick="print()">Print / Save as PDF</button><button id="rexport">Export .zip</button></div>${i.reportUrl ? `<p class="noprint"><a href="${esc(i.reportUrl)}" target="_blank" rel="noopener">Open the report PDF</a> (office review, then print, sign and mail)</p>` : ""}</div>
    ${i.rooms.map(r => `<div class="card"><h3>${esc(r.name)}</h3>${r.items.map(it => { const p = prior(it); return `<div class="item"><b>${esc(it.name)}</b>: ${esc(it.cond || "—")}
      ${p ? ` <span class="muted">(move-in: ${esc(p.cond || "—")})</span>` : ""}${it.note ? `<div>${esc(it.note)}</div>` : ""}${it.cost ? `<div>Cost: $${esc(it.cost)}</div>` : ""}
      <div class="thumbs">${it.photos.map(ph => `<img data-ph="${ph}">`).join("")}</div></div>`; }).join("")}</div>`).join("")}`;
  document.querySelectorAll("img[data-ph]").forEach(async im => im.src = await photoURL(im.dataset.ph));
  $("#rexport").onclick = () => exportZip(i);
}

// one .zip per inspection: inspection.json + photos/<room>/<item>-n.jpg (Phase 2 uploads the same to Google Drive)
async function exportZip(i) {
  if (!window.JSZip) return toast("Export not available");
  toast("Building zip…");
  const z = new JSZip(), safe = s => s.replace(/[\\/:*?"<>|]+/g, "-").trim();
  const map = {};
  for (const r of i.rooms) for (const it of r.items) it.photos.forEach((pid, n) => map[pid] = `photos/${safe(r.name)}/${safe(it.name)}-${n + 1}.jpg`);
  for (const p of await photosOf(i.id)) if (map[p.id]) z.file(map[p.id], p.blob);
  z.file("inspection.json", JSON.stringify({ ...i, photoFiles: map }, null, 2));
  const blob = await z.generateAsync({ type: "blob" });
  const now = new Date(), hhmm = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  const name = `${i.date}-${i.type.toLowerCase()} condition - ${safe(short(i.address))} (exported ${hhmm}).zip`;
  const file = new File([blob], name, { type: "application/zip" });
  const mark = async () => { // remember when it was exported (without counting as an edit)
    const cur = await getInsp(i.id); cur.exportedAt = new Date().toISOString();
    await tx("inspections", "readwrite", st => req(st.put(cur))); i.exportedAt = cur.exportedAt;
    if (location.hash === `#/i/${i.id}`) viewInspection(i.id);
  };
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); await mark(); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); await mark();
}

// ---------------------------------------------------------------- Phase 2: upload to Google Drive (ewpm805 / My Drive / ConditionCheck)
// Each inspection -> ConditionCheck/<address>/<date> <type> (<id>)/: inspection.json, photos/<room>/<item>-n.jpg,
// and a Google Docs report. Uploads run when online, ~1 min after the last edit, on app open and on "Upload now".
// Nothing is ever sent to tenants: the office reviews, confirms, signs, prints and mails.
let syncing = false, syncTimer = null, syncMsg = {};
function synced(i) { return !!i.syncedAt && i.updatedAt <= i.syncedAt; }
function scheduleSync(ms = 60000) { if (!cloud()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncAll(), ms); }
function driveLine(i) {
  if (syncMsg[i.id]) return `<div class="muted">${esc(syncMsg[i.id])}</div>`;
  if (synced(i)) return `<div class="muted">Saved to Google Drive ✓ ${esc(fmtTime(i.syncedOn))}${i.driveUrl ? ` · <a href="${esc(i.driveUrl)}" target="_blank" rel="noopener">Folder</a>` : ""}${i.reportUrl ? ` · <a href="${esc(i.reportUrl)}" target="_blank" rel="noopener">Report</a>` : ""}</div>`;
  const why = !navigator.onLine ? "Waiting for internet to upload to Google Drive." : i.syncError ? `Upload problem (${esc(i.syncError)}) - will retry.` : "Will upload to Google Drive shortly.";
  return `<div class="warn">${why} <button id="syncnow" style="margin-left:6px;padding:2px 10px">Upload now</button></div>`;
}
function paintDrive(id) {
  const el = document.getElementById("drive"); if (!el || !location.hash.startsWith(`#/i/${id}`)) return;
  getInsp(id).then(i => { if (!i) return; el.innerHTML = driveLine(i); const b = document.getElementById("syncnow"); if (b) b.onclick = () => syncAll(true); });
}
const blobToB64 = b => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = () => bad(r.error); r.readAsDataURL(b); });
async function payloadOf(i) {
  const safe = s => String(s).replace(/[\\/:*?"<>|#]+/g, "-").trim() || "-";
  const photoFiles = {};
  for (const r of i.rooms) for (const it of r.items) it.photos.forEach((pid, n) => photoFiles[pid] = `${safe(r.name)}/${safe(it.name)}-${n + 1}.jpg`);
  const out = { ...i, photoFiles };
  delete out.syncError; delete out.syncedAt; delete out.syncedOn;
  const m = i.linkedMoveIn && await getInsp(i.linkedMoveIn);
  if (m) {
    const prior = Object.fromEntries(m.rooms.flatMap(r => r.items).map(x => [x.id, x]));
    out.linkedMoveInDate = m.date;
    out.rooms = i.rooms.map(r => ({ ...r, items: r.items.map(it => { const p = prior[it.linkItem]; return p ? { ...it, priorCond: p.cond || "", priorNote: p.note || "" } : it; }) }));
  }
  return out;
}
async function syncOne(i) {
  const startedAt = i.updatedAt, say = t => { syncMsg[i.id] = t; paintDrive(i.id); };
  say("Uploading to Google Drive…");
  const p = await payloadOf(i);
  const r = await callCloud("saveInspection", { insp: p });
  let n = 0;
  for (const pid of r.missing) {
    say(`Uploading photos to Google Drive… ${++n} / ${r.missing.length}`);
    const ph = await getPhoto(pid); if (!ph) continue;
    await callCloud("uploadPhoto", { folderId: r.folderId, pid, path: p.photoFiles[pid], data: await blobToB64(ph.blob) });
  }
  say("Building the report PDF…");
  const rep = await callCloud("report", { folderId: r.folderId });
  const cur = await getInsp(i.id); if (!cur) return;
  Object.assign(cur, { driveFolderId: r.folderId, driveUrl: r.folderUrl, reportUrl: rep.reportUrl || cur.reportUrl, syncedAt: startedAt, syncedOn: new Date().toISOString() });
  delete cur.syncError; await rawPut(cur);
}
async function syncAll(manual) {
  if (syncing || !cloud()) return;
  if (!navigator.onLine) { if (manual) toast("No internet - it will upload when you are back online"); return; }
  syncing = true; let failed = false;
  try {
    for (const i of await getAll()) {
      if (synced(i)) continue;
      try { await syncOne(i); }
      catch (e) { failed = true; const cur = await getInsp(i.id); if (cur) { cur.syncError = String(e.message || e).slice(0, 80); await rawPut(cur); } }
      finally { delete syncMsg[i.id]; paintDrive(i.id); }
    }
  } finally { syncing = false; }
  if (manual) toast(failed ? "Some uploads failed - will retry" : "Saved to Google Drive ✓");
  const left = (await getAll()).some(i => !synced(i));
  if (left) scheduleSync(failed ? 5 * 60000 : 60000);
  if (location.hash === "#/" || location.hash === "") route();
}

// ---------------------------------------------------------------- router, offline, install
async function route() {
  const p = location.hash.replace(/^#\/?/, "").split("/");
  window.scrollTo(0, 0);
  if (p[0] === "new") return viewNew();
  if (p[0] === "settings") return viewSettings();
  if (p[0] === "connect" && p[1] && p[2]) return connect(p[1], p[2]);
  if (p[0] === "i" && p[2] === "r") return viewRoom(p[1], p[3]);
  if (p[0] === "i" && p[2] === "report") return viewReport(p[1]);
  if (p[0] === "i") return viewInspection(p[1]);
  return viewList();
}
function net() { $("#net").textContent = navigator.onLine ? "● online" : "○ offline"; }
addEventListener("hashchange", route); addEventListener("online", net); addEventListener("offline", net);
net(); route();
refreshCompany().catch(() => {}); addEventListener("online", () => { refreshCompany().catch(() => {}); syncAll(); });
setTimeout(() => syncAll(), 3000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") syncAll(); }); // closing the app
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
navigator.storage?.persist?.(); // ask the browser not to evict saved inspections/photos
