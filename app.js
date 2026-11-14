// ConditionChecklist PWA - Phase 1: inspections, rooms, items, photos; everything offline in IndexedDB.
"use strict";
const VERSION = "0.1";
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
const putInsp = i => { i.updatedAt = new Date().toISOString(); return tx("inspections", "readwrite", s => req(s.put(i))); };
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
        <div class="row"><span class="badge ${i.type === "Move-in" ? "in" : "out"}">${esc(i.type)}</span><b class="grow">${esc(short(i.address))}</b><span class="muted">${esc(i.date)}</span></div>
        <div class="muted">${esc(i.unit ? "Unit " + i.unit + " · " : "")}${esc(i.tenant || "")}</div>
        <div class="prog">${done} / ${all.length} items checked</div><div class="bar"><i style="width:${all.length ? 100 * done / all.length : 0}%"></i></div></div>`;
    }).join("")}
    <p class="muted" style="text-align:center">v${VERSION}</p>`;
}

async function viewNew() {
  setHeader("New inspection", "#/");
  const ins = (await getAll()).filter(i => i.type === "Move-in");
  const opt = CHECKLIST.filter(t => t.optional);
  $("#view").innerHTML = `<div class="card">
    <label>Type</label><div class="seg" id="type"><button data-v="Move-in" class="on" style="background:var(--accent);color:#fff">Move-in</button><button data-v="Move-out">Move-out</button></div>
    <label>Property address</label><input id="address" placeholder="401 Hermosa Way, Oxnard, CA 93036" autocomplete="street-address">
    <label>Unit (optional)</label><input id="unit">
    <label>Tenant name(s)</label><input id="tenant">
    <label>Inspected by</label><input id="inspector" value="${esc(localStorage.getItem("inspector") || "")}">
    <label>Date</label><input id="date" type="date" value="${today()}">
    <div class="row"><div class="grow"><label>Bedrooms</label><input id="bedrooms" type="number" min="0" max="10" value="3" inputmode="numeric"></div>
    <div class="grow"><label>Bathrooms</label><input id="bathrooms" type="number" min="0" max="10" value="2" inputmode="numeric"></div></div>
    <label>Also include</label><div class="seg" id="opt">${opt.map(t => `<button data-v="${t.type}" class="${t.type === "dining" || t.type === "garage" ? "on" : ""}">${esc(t.name)}</button>`).join("")}</div>
    <div id="linkbox" hidden><label>Compare with move-in inspection</label><select id="link"><option value="">(none)</option>
      ${ins.map(i => `<option value="${i.id}">${esc(short(i.address))} · ${esc(i.date)} · ${esc(i.tenant || "")}</option>`).join("")}</select></div>
    <div class="row" style="margin-top:14px"><button class="primary grow" id="create">Start inspection</button></div></div>`;
  const paint = () => document.querySelectorAll("#opt button").forEach(b => b.style.cssText = b.classList.contains("on") ? "background:var(--accent);color:#fff" : "");
  paint();
  $("#opt").onclick = e => { if (e.target.dataset.v) { e.target.classList.toggle("on"); paint(); } };
  $("#type").onclick = e => {
    if (!e.target.dataset.v) return;
    document.querySelectorAll("#type button").forEach(b => { b.classList.toggle("on", b === e.target); b.style.cssText = b === e.target ? "background:var(--accent);color:#fff" : ""; });
    $("#linkbox").hidden = e.target.dataset.v !== "Move-out";
  };
  $("#link").onchange = async () => { // copy room layout from the move-in so items line up
    const m = await getInsp($("#link").value); if (!m) return;
    $("#address").value = m.address; $("#unit").value = m.unit || ""; $("#tenant").value = m.tenant || "";
    $("#bedrooms").value = m.rooms.filter(r => r.type === "bedroom").length; $("#bathrooms").value = m.rooms.filter(r => r.type === "bathroom").length;
  };
  $("#create").onclick = async () => {
    const address = $("#address").value.trim(); if (!address) return toast("Enter the property address");
    const type = $("#type .on").dataset.v, link = type === "Move-out" ? $("#link").value : "";
    const include = {}; document.querySelectorAll("#opt .on").forEach(b => include[b.dataset.v] = true);
    localStorage.setItem("inspector", $("#inspector").value.trim());
    let rooms;
    const m = link && await getInsp(link);
    if (m) rooms = m.rooms.map(r => ({ ...r, id: uid(), linkRoom: r.id, items: r.items.map(i => ({ id: uid(), linkItem: i.id, name: i.name, cond: "", note: "", cost: "", photos: [] })) }));
    else rooms = buildRooms({ bedrooms: $("#bedrooms").value, bathrooms: $("#bathrooms").value, include });
    const insp = { id: uid(), app: "ConditionChecklist", version: VERSION, type, address, unit: $("#unit").value.trim(), tenant: $("#tenant").value.trim(),
      inspector: $("#inspector").value.trim(), date: $("#date").value, linkedMoveIn: link || "", rooms, createdAt: new Date().toISOString(), status: "open" };
    await putInsp(insp); location.hash = `#/i/${insp.id}`;
  };
}

async function viewInspection(id) {
  const i = await getInsp(id); if (!i) return location.hash = "#/";
  setHeader(`${i.type} · ${short(i.address)}`, "#/");
  $("#view").innerHTML = `<div class="card"><div class="row"><span class="badge ${i.type === "Move-in" ? "in" : "out"}">${esc(i.type)}</span><b class="grow">${esc(i.address)}</b></div>
      <div class="muted">${esc(i.date)} · ${esc(i.tenant || "no tenant name")} · by ${esc(i.inspector || "?")}${i.linkedMoveIn ? " · compared with move-in" : ""}</div></div>
    ${i.rooms.map(r => { const d = itemsDone(r), n = r.items.length;
      return `<div class="card room" onclick="location.hash='#/i/${i.id}/r/${r.id}'" style="cursor:pointer"><div class="grow"><b>${esc(r.name)}</b>
        <div class="prog">${d} / ${n}${r.items.some(x => x.photos.length) ? " · 📷 " + r.items.reduce((a, x) => a + x.photos.length, 0) : ""}</div><div class="bar"><i style="width:${100 * d / n}%"></i></div></div><span>›</span></div>`; }).join("")}
    <div class="card noprint"><div class="row"><select id="addtype" class="grow">${CHECKLIST.map(t => `<option value="${t.type}">${esc(t.name)}</option>`).join("")}</select><button id="addroom">+ Add room</button></div></div>
    <div class="row noprint"><button class="primary grow" onclick="location.hash='#/i/${i.id}/report'">Report</button><button id="export">Export .zip</button></div>
    <div class="row noprint" style="margin-top:24px"><button class="danger" id="del">Delete inspection</button></div>`;
  $("#addroom").onclick = async () => {
    const t = CHECKLIST.find(x => x.type === $("#addtype").value);
    const same = i.rooms.filter(r => r.type === t.type).length;
    i.rooms.push({ id: uid(), type: t.type, name: same ? `${t.name} ${same + 1}` : t.name, items: t.items.map(name => ({ id: uid(), name, cond: "", note: "", cost: "", photos: [] })) });
    await putInsp(i); viewInspection(id);
  };
  $("#export").onclick = () => exportZip(i);
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
      <h3>${esc(it.name)}</h3>
      ${p ? `<div class="prior">Move-in: <b>${esc(p.cond || "not checked")}</b>${p.note ? " · " + esc(p.note) : ""}<div class="thumbs">${p.photos.map(ph => `<img data-ph="${ph}">`).join("")}</div></div>` : ""}
      <div class="seg">${CONDITIONS.map(c => `<button data-c="${c}" class="${it.cond === c ? "on" : ""}">${c}</button>`).join("")}</div>
      <textarea placeholder="Notes" data-f="note">${esc(it.note)}</textarea>
      ${i.type === "Move-out" ? `<input placeholder="Cost to correct $" inputmode="decimal" data-f="cost" value="${esc(it.cost)}" style="margin-top:6px">` : ""}
      <div class="thumbs">${it.photos.map(ph => `<img data-ph="${ph}" data-own="1">`).join("")}<label class="add">📷<input type="file" accept="image/*" capture="environment" multiple hidden></label></div>
    </div>`; }).join("")}
    <div class="row noprint" style="margin-top:10px">${next ? `<button class="primary grow" onclick="location.hash='#/i/${id}/r/${next.id}'">Next: ${esc(next.name)} ›</button>` : `<button class="primary grow" onclick="location.hash='#/i/${id}'">Done ›</button>`}</div>
    <div class="row noprint" style="margin-top:10px"><input id="newitem" class="grow" placeholder="Add an item to this room"><button id="additem">+</button></div></div>`;
  document.querySelectorAll("img[data-ph]").forEach(async im => im.src = await photoURL(im.dataset.ph));
  const save = () => putInsp(i);
  $("#rname").onchange = e => { r.name = e.target.value.trim() || r.name; save(); };
  $("#allgood").onclick = async () => { r.items.forEach(it => it.cond ||= "Good"); await save(); viewRoom(id, rid); };
  $("#additem").onclick = async () => { const n = $("#newitem").value.trim(); if (!n) return; r.items.push({ id: uid(), name: n, cond: "", note: "", cost: "", photos: [] }); await save(); viewRoom(id, rid); };
  $("#view").onclick = async e => {
    const box = e.target.closest(".item"); if (!box) return;
    const it = r.items.find(x => x.id === box.dataset.id);
    if (e.target.dataset.c) { it.cond = it.cond === e.target.dataset.c ? "" : e.target.dataset.c;
      box.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.c === it.cond)); save(); }
    if (e.target.dataset.ph) showPhoto(e.target.dataset.ph, e.target.dataset.own && (async () => {
      it.photos = it.photos.filter(x => x !== e.target.dataset.ph); await delPhoto(e.target.dataset.ph); await save(); viewRoom(id, rid); }));
  };
  $("#view").oninput = e => { const box = e.target.closest(".item"); if (!box || !e.target.dataset.f) return;
    r.items.find(x => x.id === box.dataset.id)[e.target.dataset.f] = e.target.value; clearTimeout(viewRoom.t); viewRoom.t = setTimeout(save, 400); };
  $("#view").onchange = async e => {
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
    ${i.type === "Move-out" ? `<p><b>Total cost to correct: $${total.toFixed(2)}</b></p>` : ""}
    <div class="row noprint"><button class="primary" onclick="print()">Print / Save as PDF</button></div></div>
    ${i.rooms.map(r => `<div class="card"><h3>${esc(r.name)}</h3>${r.items.map(it => { const p = prior(it); return `<div class="item"><b>${esc(it.name)}</b>: ${esc(it.cond || "—")}
      ${p ? ` <span class="muted">(move-in: ${esc(p.cond || "—")})</span>` : ""}${it.note ? `<div>${esc(it.note)}</div>` : ""}${it.cost ? `<div>Cost: $${esc(it.cost)}</div>` : ""}
      <div class="thumbs">${it.photos.map(ph => `<img data-ph="${ph}">`).join("")}</div></div>`; }).join("")}</div>`).join("")}`;
  document.querySelectorAll("img[data-ph]").forEach(async im => im.src = await photoURL(im.dataset.ph));
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
  const name = `${i.date}-${i.type.toLowerCase()} condition - ${safe(short(i.address))}.zip`;
  const file = new File([blob], name, { type: "application/zip" });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch {} }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
}

// ---------------------------------------------------------------- router, offline, install
async function route() {
  const p = location.hash.replace(/^#\/?/, "").split("/");
  window.scrollTo(0, 0);
  if (p[0] === "new") return viewNew();
  if (p[0] === "i" && p[2] === "r") return viewRoom(p[1], p[3]);
  if (p[0] === "i" && p[2] === "report") return viewReport(p[1]);
  if (p[0] === "i") return viewInspection(p[1]);
  return viewList();
}
function net() { $("#net").textContent = navigator.onLine ? "● online" : "○ offline"; }
addEventListener("hashchange", route); addEventListener("online", net); addEventListener("offline", net);
net(); route();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
navigator.storage?.persist?.(); // ask the browser not to evict saved inspections/photos
