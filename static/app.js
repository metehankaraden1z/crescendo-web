"use strict";

/* ===================================================================
   Crescendo — single-page front end (no build step, no framework)
   =================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  me: null,
  renderId: 0,
  onRated: null,      // page-level hook called after a rating is saved
  reviews: {},        // "album:<id>" / "artist:<id>" -> current review text
};

/* ---------- small helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

const fmt = (v) => (v == null ? "–" : (v / 2).toFixed(1));
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const num = (n) => Number(n || 0).toLocaleString("en-US");

function fmtLen(ms) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function timeAgo(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function initials(text) {
  const words = String(text || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}

const coverUrl = (id, size = 250) => `https://coverartarchive.org/release-group/${id}/front-${size}`;

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 4h12v17l-6-4-6 4z"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  disc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  stars: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.6l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
  dna: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M9 20V4M14 20v-7M19 20V8"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/></svg>',
};
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.75 5.75 6.3.8-4.62 4.36 1.16 6.24L12 16.7l-5.59 3.05 1.16-6.24L2.95 9.15l6.3-.8z"/></svg>';
const LOGO = '<svg class="logo-mark" viewBox="0 0 28 20" aria-hidden="true"><path d="M3 10 25 3M3 10l22 7"/></svg>';

/* ---------- API ---------- */

async function api(method, path, body, signal) {
  const opts = { method, headers: {}, credentials: "same-origin", signal };
  if (method !== "GET") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body || {});
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw Object.assign(new Error("Can't reach the server. Is it running?"), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/* ---------- hover prefetch ----------
   Hovering an album/artist link starts loading its data, so the click usually opens instantly.
   Entries are used once and expire quickly, so a page never shows stale personal ratings. */

const prefetched = new Map(); // api path -> { promise, at }
let prefetchesInFlight = 0;

function apiPathForHref(href) {
  const m = /^#\/(album|artist)\/([0-9a-f-]{36})$/.exec(href || "");
  return m ? `/api/${m[1]}/${m[2]}` : null;
}

function prefetch(path) {
  const hit = prefetched.get(path);
  if ((hit && Date.now() - hit.at < 30000) || prefetchesInFlight >= 3) return;
  prefetchesInFlight++;
  const promise = api("GET", path).catch(() => null).finally(() => prefetchesInFlight--);
  prefetched.set(path, { promise, at: Date.now() });
}

async function getData(path) {
  const hit = prefetched.get(path);
  prefetched.delete(path);
  if (hit && Date.now() - hit.at < 30000) {
    const data = await hit.promise;
    if (data) return data;
  }
  return api("GET", path);
}

let hoverTimer = null;
document.addEventListener("pointerover", (e) => {
  const a = e.target.closest && e.target.closest("a[href^='#/album/'], a[href^='#/artist/']");
  clearTimeout(hoverTimer);
  if (!a) return;
  const path = apiPathForHref(a.getAttribute("href"));
  if (path) hoverTimer = setTimeout(() => prefetch(path), e.pointerType === "touch" ? 0 : 90);
});
document.addEventListener("focusin", (e) => {
  const path = e.target.matches && e.target.matches("a[href]") && apiPathForHref(e.target.getAttribute("href"));
  if (path) prefetch(path);
});

function toast(msg, err = false) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.textContent = msg;
  $("#toast-root").append(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------- reusable markup ---------- */

function coverHTML(id, title, size = 250, cls = "") {
  return `<div class="cover ${cls}" style="--h:${hue(title || id)}">
    <span class="cover-fallback">${esc(initials(title))}</span>
    ${id ? `<img class="cover-img" src="${coverUrl(id, size)}" alt="" loading="lazy" decoding="async">` : ""}
  </div>`;
}

function avatarHTML(name, cls = "") {
  return `<span class="avatar ${cls}" style="--h:${hue(name)}" aria-hidden="true">${esc(String(name || "?")[0])}</span>`;
}

function starsHTML(value, { size = "md", kind, id, album, label, interactive: local = false } = {}) {
  const v = value || 0;
  const interactive = kind || local
    ? ` data-interactive ${kind ? `data-kind="${kind}" data-id="${esc(id)}"` : ""} ${album ? `data-album="${esc(album)}"` : ""}
        data-value="${value || ""}" role="slider" tabindex="0" aria-label="${esc(label || "Your rating")}"
        aria-valuemin="1" aria-valuemax="10" aria-valuenow="${v}" aria-valuetext="${value ? fmt(value) + " stars" : "Not rated"}"`
    : ` role="img" aria-label="${value ? fmt(value) + " out of 5 stars" : "No rating"}"`;
  return `<span class="stars stars-${size}"${interactive}><span class="stars-track">${STAR_SVG.repeat(5)}</span><span class="stars-fill" style="width:${v * 10}%">${STAR_SVG.repeat(5)}</span></span>`;
}

function ratingLine(kind, id, value, { album, size = "md", label } = {}) {
  return `<div class="rating-line">
    ${starsHTML(value, { kind, id, album, size, label })}
    <span class="score-num ${value ? "" : "empty"}">${value ? fmt(value) : "—"}</span>
    <button class="clear-x" data-clear aria-label="Clear rating" title="Clear rating">${ICON.x}</button>
  </div>`;
}

function commHTML(avg, count, style = "bar") {
  if (style === "big") {
    return `<div class="big">${avg ? fmt(avg) : "—"}<small>${plural(count || 0, "rating")}</small></div>
      <div style="margin-top:8px">${starsHTML(avg ? Math.round(avg) : 0, { size: "md" })}</div>`;
  }
  return `<span class="bar"><span style="width:${avg ? avg * 10 : 0}%"></span></span>
    <b>${avg ? fmt(avg) : "–"}</b><span class="nowrap" data-tip="${plural(count || 0, "rating")} on Crescendo">${count ? "(" + count + ")" : ""}</span>`;
}

function albumCard(a, { showMine = true } = {}) {
  const score = showMine && a.my ? `<span class="badge badge-score">★ ${fmt(a.my)}</span>` : "";
  const meta = [a.year, a.type && a.type !== "Album" ? a.type : null].filter(Boolean).join(" · ");
  return `<a class="album-card" href="#/album/${a.id}">
    <div style="position:relative">${score}${coverHTML(a.id, a.title)}</div>
    <div>
      <div class="t">${esc(a.title)}</div>
      ${a.artist ? `<div class="a">${esc(a.artist)}</div>` : ""}
      <div class="meta">${a.avg ? `<span style="color:var(--gold-2)">★ ${fmt(a.avg)}</span>` : ""}${meta ? `<span>${esc(meta)}</span>` : ""}</div>
    </div>
  </a>`;
}

function feedItem(e) {
  let what;
  const user = `<a href="#/u/${encodeURIComponent(e.username)}"><b>${esc(e.username)}</b></a>`;
  const albumLink = e.album_id ? `<a class="item" href="#/album/${e.album_id}">${esc(e.album_title)}</a>` : "";
  if (e.kind === "songs") {
    what = e.n > 1
      ? `${user} rated ${e.n} tracks from ${albumLink}`
      : `${user} rated <a class="item" href="#/album/${e.album_id}">${esc(e.first_title)}</a> <span class="muted">from</span> ${albumLink}`;
  } else if (e.kind === "album") {
    what = `${user} rated the album ${albumLink}`;
  } else {
    what = `${user} rated the artist <a class="item" href="#/artist/${e.item_id}">${esc(e.item_title)}</a>`;
  }
  const sub = e.kind !== "artist" && e.artist ? ` · ${esc(e.artist)}` : "";
  return `<div class="feed-item">
    ${avatarHTML(e.username)}
    <div class="what">${what}
      <div class="when">${starsHTML(Math.round(e.score), { size: "sm" })}<span>${e.kind === "songs" && e.n > 1 ? "avg " : ""}${fmt(e.score)}</span><span>·</span><span>${timeAgo(e.at)}${sub}</span></div>
      ${e.review ? `<div class="review">“${esc(e.review.length > 180 ? e.review.slice(0, 180) + "…" : e.review)}”</div>` : ""}
    </div>
    ${e.album_id ? `<a href="#/album/${e.album_id}" aria-label="Open album">${coverHTML(e.album_id, e.album_title)}</a>` : avatarHTML(e.item_title)}
  </div>`;
}

function loadingHTML(msg = "Loading…") {
  return `<div class="loading"><div class="eq"><span></span><span></span><span></span><span></span><span></span></div><div>${esc(msg)}</div></div>`;
}

function errorHTML(err) {
  return `<div class="wrap"><div class="loading"><h2>Hit a wrong note.</h2><p class="muted">${esc(err.message)}</p>
    <button class="btn btn-ghost" onclick="render()">Try again</button></div></div>`;
}

/* ---------- star widget behaviour ---------- */

function setStarsValue(el, v, { pop = true } = {}) {
  el.dataset.value = v || "";
  $(".stars-fill", el).style.width = (v || 0) * 10 + "%";
  el.setAttribute("aria-valuenow", v || 0);
  el.setAttribute("aria-valuetext", v ? `${fmt(v)} stars` : "Not rated");
  const n = el.parentElement && $(".score-num", el.parentElement);
  if (n && n.parentElement === el.parentElement) {
    n.textContent = v ? fmt(v) : "—";
    n.classList.toggle("empty", !v);
  }
  if (pop && v) {
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  }
}

function wireStars(el, onPick) {
  if (el._wired) return;
  el._wired = true;
  const fill = $(".stars-fill", el);
  const scoreEl = () => el.parentElement && $(".score-num", el.parentElement);
  const valueAt = (x) => {
    const r = el.getBoundingClientRect();
    return Math.min(10, Math.max(1, Math.ceil(((x - r.left) / r.width) * 10)));
  };
  const preview = (v) => {
    el.classList.add("previewing");
    fill.style.width = v * 10 + "%";
    const n = scoreEl();
    if (n) { n.textContent = fmt(v); n.classList.remove("empty"); }
  };
  const restore = () => {
    el.classList.remove("previewing");
    const v = Number(el.dataset.value) || 0;
    fill.style.width = v * 10 + "%";
    const n = scoreEl();
    if (n) { n.textContent = v ? fmt(v) : "—"; n.classList.toggle("empty", !v); }
  };
  el.addEventListener("pointermove", (e) => preview(valueAt(e.clientX)));
  el.addEventListener("pointerleave", restore);
  el.addEventListener("click", (e) => { el.classList.remove("previewing"); onPick(valueAt(e.clientX)); });
  let timer;
  el.addEventListener("keydown", (e) => {
    const cur = Number(el.dataset.value) || 0;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(10, cur + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(1, cur - 1);
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 10;
    else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); onPick(null); return; }
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    setStarsValue(el, next, { pop: false });
    clearTimeout(timer);
    timer = setTimeout(() => onPick(next), 450);
  });
  const clear = el.parentElement && $("[data-clear]", el.parentElement);
  if (clear) clear.addEventListener("click", () => onPick(null));
}

function wireRatingStars(root = document) {
  $$(".stars[data-kind]", root).forEach((el) => {
    wireStars(el, (v) => rate(el.dataset.kind, el.dataset.id, el.dataset.album, v, el));
  });
}

async function rate(kind, id, album, score, el) {
  if (!state.me) {
    if (el) setStarsValue(el, Number(el.dataset.value) || 0, { pop: false });
    if (score == null) return;
    sessionStorage.setItem("pendingRating", JSON.stringify({ kind, id, album, score }));
    openAuth("join", "rate");
    return false;
  }
  const same = $$(`.stars[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
  const before = el ? Number(el.dataset.value) || null : null;
  same.forEach((s) => setStarsValue(s, score, { pop: s === el }));
  const body = { score };
  if (kind === "song") Object.assign(body, { song: id, album });
  else body[kind] = id;
  if (kind !== "song") body.review = state.reviews[`${kind}:${id}`] || "";
  try {
    const res = await api("PUT", `/api/ratings/${kind}`, body);
    $$(`[data-comm="${kind}:${CSS.escape(id)}"]`).forEach((n) => (n.innerHTML = commHTML(res.avg, res.count, n.dataset.style)));
    prefetched.clear();
    if (state.onRated) state.onRated(kind, id, score, res);
    return true;
  } catch (err) {
    same.forEach((s) => setStarsValue(s, before, { pop: false }));
    toast(err.message, true);
    if (err.status === 401) { state.me = null; renderTopbar(); }
    return false;
  }
}

async function applyPendingRating() {
  const raw = sessionStorage.getItem("pendingRating");
  if (!raw) return;
  sessionStorage.removeItem("pendingRating");
  try {
    const p = JSON.parse(raw);
    await rate(p.kind, p.id, p.album, p.score, null);
    toast("Rating saved — welcome to Crescendo ✦");
  } catch { /* ignore */ }
}

/* ---------- tooltip & image fallbacks ---------- */

document.addEventListener("load", (e) => {
  if (e.target.classList && e.target.classList.contains("cover-img")) e.target.classList.add("loaded");
}, true);
document.addEventListener("error", (e) => {
  if (e.target.classList && (e.target.classList.contains("cover-img") || e.target.classList.contains("bd-img"))) e.target.classList.add("broken");
}, true);

const tip = $("#tip");
document.addEventListener("pointerover", (e) => {
  const t = e.target.closest && e.target.closest("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip; // only ever built from escaped/numeric content
  const r = t.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - 80, Math.max(80, r.left + r.width / 2)) + "px";
  tip.style.top = r.top + "px";
  tip.hidden = false;
});
window.addEventListener("scroll", () => (tip.hidden = true), { passive: true });

/* ---------- modal & auth ---------- */

function openModal(html, { onClose } = {}) {
  closeModal();
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">
    <button class="icon-btn close" data-close aria-label="Close">${ICON.x}</button>${html}</div></div>`;
  const backdrop = $(".modal-backdrop", root);
  const close = () => { closeModal(); if (onClose) onClose(); };
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  $("[data-close]", root).addEventListener("click", close);
  root._esc = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", root._esc);
  const first = $("input, textarea, button:not([data-close])", root);
  if (first) setTimeout(() => first.focus(), 30);
  return $(".modal", root);
}

function closeModal() {
  const root = $("#modal-root");
  if (root._esc) document.removeEventListener("keydown", root._esc);
  root.innerHTML = "";
}

function openAuth(mode = "join", reason = "") {
  const join = mode === "join";
  const lede = reason === "rate"
    ? "Your rating is ready to save. Create a free account and it's yours — along with every rating after it."
    : join ? "Rate every track you love (and the ones you don't). Your taste profile builds itself." : "Good to have you back.";
  const m = openModal(`
    <span class="eyebrow">${join ? "Free forever · 10 seconds" : "Welcome back"}</span>
    <h2 style="margin-top:8px">${join ? "Claim your taste." : "Log in"}</h2>
    <p class="lede">${lede}</p>
    ${join ? `<div class="perks"><span>✦ Rate albums song by song, in half-stars</span><span>✦ Get your Taste DNA — genres, habits, all-time favorites</span><span>✦ See your match % with every listener</span></div>` : ""}
    <form id="auth-form" novalidate>
      <div class="field"><label for="au-user">Username</label>
        <input id="au-user" name="username" autocomplete="username" required maxlength="24" spellcheck="false">
        ${join ? `<span class="hint">3–24 characters: letters, numbers, dots, underscores.</span>` : ""}</div>
      <div class="field"><label for="au-pass">Password</label>
        <input id="au-pass" name="password" type="password" autocomplete="${join ? "new-password" : "current-password"}" required minlength="${join ? 8 : 1}">
        ${join ? `<span class="hint">At least 8 characters.</span>` : ""}</div>
      <div class="form-error" id="au-err" role="alert"></div>
      <button class="btn btn-gold btn-lg" style="width:100%" type="submit">${join ? "Create my account" : "Log in"}</button>
    </form>
    <div class="switch">${join ? `Already have an account? <button data-switch="login">Log in</button>` : `New here? <button data-switch="join">Create an account</button>`}</div>
  `, { onClose: () => sessionStorage.removeItem("pendingRating") });
  $("[data-switch]", m).addEventListener("click", (e) => openAuth(e.target.dataset.switch, reason));
  $("#auth-form", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $("button[type=submit]", f);
    btn.disabled = true;
    $("#au-err").textContent = "";
    try {
      const { user } = await api("POST", join ? "/api/auth/register" : "/api/auth/login", {
        username: f.username.value.trim(), password: f.password.value,
      });
      state.me = user;
      prefetched.clear();
      $("#modal-root").innerHTML = "";
      await applyPendingRating();
      if (join && reason !== "rate") toast(`Welcome, ${user.username}! Search an album to start rating.`);
      if (session) { session.stale = true; renderTopbar(); } else render();
    } catch (err) {
      $("#au-err").textContent = err.message;
      btn.disabled = false;
    }
  });
}

async function logout() {
  await api("POST", "/api/auth/logout").catch(() => {});
  state.me = null;
  location.hash = "#/";
  render();
}

/* ---------- top bar ---------- */

function renderTopbar(route = parseRoute()) {
  const me = state.me;
  const hideSearch = route.name === "search" || (route.name === "home" && !me);
  $("#topbar").innerHTML = `<div class="wrap topbar-inner">
    <a class="brand" href="#/" aria-label="Crescendo home">${LOGO}<span>Crescendo</span></a>
    ${hideSearch ? '<div style="flex:1"></div>' : `<form class="nav-search" role="search" id="nav-search">${ICON.search}
      <input name="q" placeholder="Search albums or artists…" aria-label="Search albums or artists" autocomplete="off"></form>`}
    <nav class="nav-links">
      <a class="nav-link hide-sm ${route.name === "people" ? "active" : ""}" href="#/people">People</a>
      ${me
        ? `<a class="nav-me" href="#/u/${encodeURIComponent(me.username)}">${avatarHTML(me.username)}<span class="name">${esc(me.username)}</span></a>`
        : `<button class="nav-link" style="background:none;border:0;cursor:pointer" data-auth="login">Log in</button>
           <button class="btn btn-gold btn-sm" data-auth="join">Join free</button>`}
    </nav></div>`;
  const form = $("#nav-search");
  if (form) attachTypeahead(form);
  $$("[data-auth]").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
}

/* ---------- type-ahead ----------
   Local matches (albums already on Crescendo) show instantly; MusicBrainz suggestions
   replace them a moment later. Stale responses are cancelled, never rendered. */

const suggestCache = new Map(); // query -> MusicBrainz suggestions

function attachTypeahead(form) {
  const input = form.q;
  const box = document.createElement("div");
  box.className = "ta";
  box.hidden = true;
  box.setAttribute("role", "listbox");
  form.append(box);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  let seq = 0, timer = null, controller = null, active = -1, local = null, remote = null, pending = false;

  const goSearch = (q) => { box.hidden = true; if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`; };
  const items = () => $$("[data-ta-item]", box);
  const setActive = (i) => {
    const list = items();
    active = list.length ? (i + list.length) % list.length : -1;
    list.forEach((el, n) => el.classList.toggle("on", n === active));
    if (active >= 0) {
      const href = list[active].getAttribute("href");
      const path = apiPathForHref(href);
      if (path) prefetch(path);
    }
  };

  const draw = (q) => {
    const albums = [], seen = new Set();
    for (const a of [...((remote && remote.albums) || []), ...((local && local.albums) || [])]) {
      if (!seen.has(a.id) && albums.length < 7) { seen.add(a.id); albums.push(a); }
    }
    const artists = [], seenA = new Set();
    for (const a of [...((remote && remote.artists) || []), ...((local && local.artists) || [])]) {
      if (!seenA.has(a.id) && artists.length < 4) { seenA.add(a.id); artists.push(a); }
    }
    box.innerHTML = `
      ${albums.length ? `<div class="ta-label">Albums</div>${albums.map((a) => `<a class="ta-item" data-ta-item href="#/album/${a.id}" role="option">
          ${coverHTML(a.id, a.title)}<span class="ta-text"><b>${esc(a.title)}</b><span>${esc([a.artist, a.year, a.type && a.type !== "Album" ? a.type : null].filter(Boolean).join(" · "))}</span></span>
          ${a.avg ? `<span class="ta-score">★ ${fmt(a.avg)}</span>` : ""}</a>`).join("")}` : ""}
      ${artists.length ? `<div class="ta-label">Artists</div>${artists.map((a) => `<a class="ta-item" data-ta-item href="#/artist/${a.id}" role="option">
          ${avatarHTML(a.name)}<span class="ta-text"><b>${esc(a.name)}</b><span>${esc([a.type, a.country, a.disambiguation].filter(Boolean).join(" · "))}</span></span></a>`).join("")}` : ""}
      ${!albums.length && !artists.length && !pending ? `<div class="ta-empty">No matches for “${esc(q)}”.</div>` : ""}
      ${pending ? `<div class="ta-status"><span class="eq eq-sm"><span></span><span></span><span></span></span>Searching MusicBrainz…</div>` : ""}
      <a class="ta-all" data-ta-item href="#/search?q=${encodeURIComponent(q)}" role="option">See all results for “${esc(q)}” →</a>`;
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };

  const run = async (q) => {
    const my = ++seq;
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    remote = suggestCache.get(q.toLowerCase()) || null;
    pending = !remote;
    local = null;
    try {
      local = await api("GET", `/api/search/local?q=${encodeURIComponent(q)}`, null, signal);
    } catch { /* local is best-effort */ }
    if (my !== seq) return;
    draw(q);
    if (remote) return;
    try {
      remote = await api("GET", `/api/suggest?q=${encodeURIComponent(q)}`, null, signal);
      suggestCache.set(q.toLowerCase(), remote);
    } catch (err) {
      if (err.name === "AbortError") return;
    }
    if (my !== seq) return;
    pending = false;
    draw(q);
  };

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { seq++; if (controller) controller.abort(); box.hidden = true; return; }
    timer = setTimeout(() => run(q), 160);
  });
  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Escape") { box.hidden = true; }
    else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const href = items()[active].getAttribute("href");
      box.hidden = true;
      location.hash = href;
    }
  });
  input.addEventListener("focus", () => { if (input.value.trim().length >= 2 && box.innerHTML) box.hidden = false; });
  input.addEventListener("blur", () => setTimeout(() => { box.hidden = true; input.setAttribute("aria-expanded", "false"); }, 180));
  box.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus so clicks land
  box.addEventListener("click", (e) => { if (e.target.closest("a")) { box.hidden = true; input.blur(); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); goSearch(input.value.trim()); });
}

/* ---------- router ---------- */

function parseRoute() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  const params = new URLSearchParams(qs || "");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { name: "home", params };
  const [a, b] = parts;
  if (a === "album" && b) return { name: "album", id: b, params };
  if (a === "artist" && b) return { name: "artist", id: b, params };
  if (a === "u" && b) return { name: "user", id: b, params };
  if (a === "search") return { name: "search", params };
  if (a === "people") return { name: "people", params };
  if (a === "join" || a === "login") return { name: "home", params, auth: a };
  return { name: "home", params };
}

const VIEWS = {};

async function render() {
  const route = parseRoute();
  const id = ++state.renderId;
  state.onRated = null;
  closeSession();
  renderTopbar(route);
  const view = $("#view");
  try {
    await VIEWS[route.name](view, route, () => id === state.renderId);
  } catch (err) {
    if (id === state.renderId) view.innerHTML = errorHTML(err);
  }
  if (route.auth && !state.me) openAuth(route.auth);
}

let lastPath = null;
window.addEventListener("hashchange", () => {
  const path = location.hash.split("?")[0];
  if (path !== lastPath) window.scrollTo(0, 0);
  lastPath = path;
  render();
});

/* ===================================================================
   Views
   =================================================================== */

/* ---------- home ---------- */

const DEMO_ALBUM = "08aa7a6c-3e43-4459-87b2-e47faf3a088a"; // Tame Impala — Currents

VIEWS.home = async (view, route, alive) => {
  view.innerHTML = state.me ? loadingHTML() : landingHTML(null);
  if (!state.me) bindHeroSearch(view);
  const data = await api("GET", "/api/home");
  if (!alive()) return;
  if (state.me) {
    view.innerHTML = welcomeHTML(data);
    bindHeroSearch(view);
  } else {
    view.innerHTML = landingHTML(data);
    bindHeroSearch(view);
  }
};

function bindHeroSearch(root) {
  const form = $("#hero-search", root);
  if (!form) return;
  attachTypeahead(form);
  $$("[data-try]", root).forEach((b) => b.addEventListener("click", () => (location.hash = `#/search?q=${encodeURIComponent(b.dataset.try)}`)));
  $$("[data-auth]", root).forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
}

function heroSearchHTML(placeholder = "Search any album — try “In Rainbows”") {
  return `<form class="hero-search" id="hero-search" role="search">${ICON.search}
    <input name="q" placeholder="${esc(placeholder)}" aria-label="Search albums" autocomplete="off">
    <button class="btn btn-gold" type="submit">Find album</button></form>`;
}

function landingHTML(data) {
  const s = data ? data.stats : null;
  const covers = data ? data.trending : [];
  const marquee = covers.length >= 5
    ? `<div class="marquee" aria-label="Albums people are rating"><div class="marquee-track">${[...covers, ...covers].map((a) =>
        `<a href="#/album/${a.id}" title="${esc(a.title)} — ${esc(a.artist)}">${coverHTML(a.id, a.title)}</a>`).join("")}</div></div>`
    : "";
  const demoTracks = [["Let It Happen", 10], ["Nangs", 7], ["The Moment", 9], ["Yes I'm Changing", 8], ["Eventually", 6]];
  return `
  <section class="hero"><div class="wrap">
    <div class="hero-grid">
      <div>
        <span class="eyebrow">The track-by-track music diary</span>
        <h1 style="margin-top:18px">Every song<br>deserves a <em>verdict.</em></h1>
        <p class="hero-sub">Search any album on MusicBrainz, rate it song by song in half-stars, and watch Crescendo turn your ratings into a living portrait of your taste.</p>
        ${heroSearchHTML()}
        <div class="hero-try"><span>Popular:</span>
          ${["Blonde", "Kid A", "Rumours", "To Pimp a Butterfly", "Currents"].map((t) => `<button data-try="${esc(t)}">${esc(t)}</button>`).join("")}
        </div>
      </div>
      <div class="demo" aria-hidden="true">
        <div class="float-chip one"><span class="ring" style="--p:92"><span>92%</span></span> taste match with elif_k</div>
        <div class="demo-card">
          <div class="demo-head">${coverHTML(DEMO_ALBUM, "Currents")}
            <div><span class="eyebrow">Album · 2015</span><h3 style="margin-top:6px">Currents</h3><div class="muted">Tame Impala</div></div>
          </div>
          <div>${demoTracks.map(([t, v], i) => `<div class="demo-row"><span class="n">${i + 1}</span><span>${esc(t)}</span>
            <span class="stars stars-sm"><span class="stars-track">${STAR_SVG.repeat(5)}</span><span class="stars-fill" style="--w:${v * 10}%">${STAR_SVG.repeat(5)}</span></span></div>`).join("")}</div>
          <div class="demo-foot"><span>Your track average</span><span>★ 4.0</span></div>
        </div>
        <div class="float-chip two">${ICON.dna.replace("<svg", '<svg width="18" height="18" style="color:var(--gold-2)"')} Top genre: <span style="color:var(--gold-2)">neo-psychedelia</span></div>
      </div>
    </div>
    ${s && s.ratings >= 25 ? `<div class="statband">
      <div><b>${s ? num(s.ratings) : "—"}</b><span>ratings logged</span></div>
      <div><b>${s ? num(s.albums) : "—"}</b><span>albums rated</span></div>
      <div><b>${s ? num(s.users) : "—"}</b><span>listeners</span></div>
    </div>` : ""}
  </div></section>

  ${marquee ? `<section style="padding-top:8px"><div class="wrap"><div class="section-head"><div><span class="eyebrow">Live on Crescendo</span><h2>What people are rating</h2></div></div></div>${marquee}</section>` : ""}

  <section class="section"><div class="wrap">
    <div class="section-head"><div><span class="eyebrow">How it works</span><h2>Three steps to your sound.</h2></div></div>
    <div class="steps">
      <div class="card step"><span class="num">1</span><div class="step-ico">${ICON.search}</div><h3>Find any album</h3><p>Millions of releases straight from MusicBrainz — the open music encyclopedia. Full tracklists, every edition.</p></div>
      <div class="card step"><span class="num">2</span><div class="step-ico">${ICON.stars}</div><h3>Rate it track by track</h3><p>A focused, keyboard-fast flow walks you through the album one song at a time. Half-stars welcome.</p></div>
      <div class="card step"><span class="num">3</span><div class="step-ico">${ICON.dna}</div><h3>Meet your Taste DNA</h3><p>Your top genres, all-time favorite songs, how harsh a critic you are — and who out there hears music like you.</p></div>
    </div>
  </div></section>

  <section class="section"><div class="wrap split">
    <div>
      <span class="eyebrow">Taste DNA</span>
      <h2 style="margin-top:12px">Your ratings,<br><em>decoded.</em></h2>
      <p>Every star you give sharpens your profile. Crescendo weighs the albums you love by their genres and shows you what your ears are really into.</p>
      <ul class="ticks"><li>Genre fingerprint built from every song you rate</li><li>Rating curve: generous fan or tough critic?</li><li>Top albums, songs and artists — always up to date</li></ul>
      <div class="actions" style="margin-top:30px"><button class="btn btn-gold btn-lg" data-auth="join">Build my profile</button></div>
    </div>
    <div class="card" style="padding:26px" aria-label="Example taste profile">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><h3 style="font-size:22px">Example profile</h3><span class="chip chip-gold">Taste DNA</span></div>
      ${[["neo-psychedelia", 1], ["art rock", .82], ["alternative r&b", .7], ["trip hop", .55], ["indie folk", .41]].map(([g, w]) =>
        `<div class="gbar"><span class="name">${g}</span><div class="track-bg"><div class="fill" style="width:${w * 100}%"></div></div><span class="pct">${Math.round(w * 31)}%</span></div>`).join("")}
      <div class="verdict">✦ Generous ear — 68% of your ratings are 4★ or higher</div>
    </div>
  </div></section>

  <section class="section"><div class="wrap split">
    <div class="card" style="padding:30px;display:grid;gap:14px" aria-hidden="true">
      ${[["elif_k", 92, "neo-psychedelia, trip hop"], ["mustafa", 78, "art rock, alternative"], ["can.polat", 61, "hip hop, r&b"]].map(([n, p, g]) =>
        `<div style="display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center">${avatarHTML(n)}<div><b>${n}</b><div class="muted" style="font-size:13px">${g}</div></div><span class="ring" style="--p:${p}"><span>${p}</span></span></div>`).join("")}
    </div>
    <div>
      <span class="eyebrow">Taste matching</span>
      <h2 style="margin-top:12px">Find people who<br><em>hear what you hear.</em></h2>
      <p>Crescendo compares your ratings and genre fingerprint with every listener and ranks your closest matches. Follow them and their ratings land in your feed.</p>
      <div class="actions" style="margin-top:30px"><a class="btn btn-ghost btn-lg" href="#/people">${ICON.people} Browse listeners</a></div>
    </div>
  </div></section>

  ${data && data.recent.length ? `<section class="section"><div class="wrap two-col">
    <div><div class="section-head"><div><span class="eyebrow">Right now</span><h2>Fresh ratings</h2></div></div><div class="feed">${data.recent.slice(0, 8).map(feedItem).join("")}</div></div>
    <div>${data.top_rated.length ? `<div class="section-head"><div><span class="eyebrow">Community favorites</span><h2>Highest rated</h2></div></div>
      <div class="album-grid" style="grid-template-columns:repeat(2,1fr)">${data.top_rated.slice(0, 4).map((a) => albumCard(a)).join("")}</div>` : ""}</div>
  </div></section>` : ""}

  <section class="section"><div class="wrap"><div class="cta-final">
    <span class="eyebrow">Free. No ads. No algorithm telling you what to like.</span>
    <h2 style="margin-top:16px">Start your first album<br>in under a minute.</h2>
    <p>Pick a record you know by heart and give every track the score it deserves.</p>
    <button class="btn btn-gold btn-lg" data-auth="join">Create my free account</button>
  </div></div></section>`;
}

function welcomeHTML(d) {
  const me = state.me;
  const c = d.my_counts || {};
  const hour = new Date().getHours();
  const greet = hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const fresh = !c.songs && !c.albums;
  return `
  <section class="welcome page-top"><div class="hero" style="position:absolute;inset:0;padding:0;z-index:-1"></div><div class="wrap">
    <span class="eyebrow">${greet}</span>
    <h1 style="margin:12px 0 26px">${fresh ? `Let's rate your <em>first album</em>, ${esc(me.username)}.` : `What are we rating <em>today</em>, ${esc(me.username)}?`}</h1>
    ${heroSearchHTML("Search an album to rate…")}
    <div class="my-stats">
      <a class="chip" href="#/u/${encodeURIComponent(me.username)}"><b>${num(c.songs)}</b> songs rated</a>
      <a class="chip" href="#/u/${encodeURIComponent(me.username)}"><b>${num(c.albums)}</b> albums</a>
      <a class="chip" href="#/u/${encodeURIComponent(me.username)}"><b>${num(c.artists)}</b> artists</a>
      <a class="chip chip-gold" href="#/u/${encodeURIComponent(me.username)}">See my Taste DNA →</a>
    </div>
  </div></section>

  ${d.in_progress && d.in_progress.length ? `<section class="section" style="padding-bottom:0"><div class="wrap">
    <div class="section-head"><div><span class="eyebrow">Pick up where you left off</span><h2>Continue rating</h2></div></div>
    <div class="progress-grid">${d.in_progress.map(progressCard).join("")}</div>
  </div></section>` : ""}

  ${d.trending.length ? `<section class="section"><div class="wrap">
    <div class="section-head"><div><span class="eyebrow">Trending</span><h2>Hot on Crescendo</h2></div></div>
    <div class="scroller">${d.trending.map((a) => albumCard(a)).join("")}</div>
  </div></section>` : `<section class="section"><div class="wrap"><div class="empty-state">Nothing trending yet — your ratings could start it.</div></div></section>`}

  <section class="section" style="padding-top:0"><div class="wrap two-col">
    <div>
      <div class="section-head"><div><span class="eyebrow">Your circle</span><h2>From people you follow</h2></div></div>
      ${d.following_feed && d.following_feed.length ? `<div class="feed">${d.following_feed.map(feedItem).join("")}</div>`
        : `<div class="empty-state">You're not following anyone yet.<br><a class="btn btn-ghost btn-sm" style="margin-top:14px" href="#/people">Find your taste twins</a></div>`}
    </div>
    <div>
      <div class="section-head"><div><span class="eyebrow">Everyone</span><h2>Latest</h2></div></div>
      <div class="feed">${d.recent.slice(0, 10).map(feedItem).join("") || '<div class="empty-state">No ratings yet.</div>'}</div>
    </div>
  </div></section>`;
}

function progressCard(p) {
  return `<a class="card progress-card" href="#/album/${p.id}">${coverHTML(p.id, p.title)}
    <div style="min-width:0"><div class="t">${esc(p.title)}</div><div class="muted" style="font-size:13px">${esc(p.artist)} · ${p.rated}/${p.total} tracks</div>
    <div class="progress-bar"><span style="width:${(p.rated / Math.max(1, p.total)) * 100}%"></span></div></div></a>`;
}

/* ---------- search ---------- */

VIEWS.search = async (view, route, alive) => {
  const q = route.params.get("q") || "";
  const type = route.params.get("type") === "artist" ? "artist" : "album";
  view.innerHTML = `<div class="wrap"><div class="search-head">
      <form class="hero-search" id="search-form" role="search">${ICON.search}
        <input name="q" value="${esc(q)}" placeholder="Album or artist name…" aria-label="Search" autocomplete="off">
        <button class="btn btn-gold" type="submit">Search</button></form>
      <div class="tabs" role="tablist">
        <button role="tab" class="${type === "album" ? "on" : ""}" data-type="album" aria-selected="${type === "album"}">Albums</button>
        <button role="tab" class="${type === "artist" ? "on" : ""}" data-type="artist" aria-selected="${type === "artist"}">Artists</button>
      </div></div>
    <div id="search-status" class="search-status" aria-live="polite"></div>
    <div id="results"></div></div>`;
  const form = $("#search-form", view);
  const input = form.q;
  const hashFor = (nq) => `#/search?q=${encodeURIComponent(nq)}${type === "artist" ? "&type=artist" : ""}`;
  form.addEventListener("submit", (e) => { e.preventDefault(); runSearch(input.value.trim()); });
  $$("[data-type]", view).forEach((b) => b.addEventListener("click", () => {
    location.hash = `#/search?q=${encodeURIComponent(input.value.trim())}${b.dataset.type === "artist" ? "&type=artist" : ""}`;
  }));
  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => runSearch(input.value.trim()), 380); });
  if (!q) input.focus();

  let seq = 0, controller = null;
  async function runSearch(term) {
    const my = ++seq;
    if (controller) controller.abort();
    controller = new AbortController();
    history.replaceState(null, "", hashFor(term)); // keep the URL shareable without re-rendering
    const results = $("#results", view), status = $("#search-status", view);
    if (term.length < 2) {
      status.innerHTML = "";
      results.innerHTML = `<div class="empty-state">Type an album or artist name to search MusicBrainz.</div>`;
      return;
    }
    // 1) instant: what Crescendo already knows
    try {
      const local = await api("GET", `/api/search/local?q=${encodeURIComponent(term)}`, null, controller.signal);
      if (my !== seq || !alive()) return;
      const list = type === "artist" ? local.artists : local.albums;
      results.innerHTML = list.length ? renderResults(list) : skeletonGrid();
    } catch (err) {
      if (err.name === "AbortError") return;
      results.innerHTML = skeletonGrid();
    }
    status.innerHTML = `<span class="eq eq-sm"><span></span><span></span><span></span></span>Searching all of MusicBrainz…`;
    // 2) complete: MusicBrainz
    try {
      const data = await api("GET", `/api/search?q=${encodeURIComponent(term)}&type=${type}`, null, controller.signal);
      if (my !== seq || !alive()) return;
      status.innerHTML = "";
      if (type === "album" && data.artist) results.innerHTML = artistAndAlbumsHTML(data);
      else results.innerHTML = data.results.length ? renderResults(data.results)
        : `<div class="empty-state">No ${type}s found for “${esc(term)}”. Try fewer words or check the spelling.</div>`;
    } catch (err) {
      if (err.name === "AbortError" || my !== seq) return;
      status.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span> <button class="btn btn-quiet btn-sm" data-retry>Retry</button>`;
      $("[data-retry]", status).addEventListener("click", () => runSearch(term));
    }
  }

  function renderResults(list) {
    if (type === "artist") {
      return `<div class="artist-grid">${list.map((a) => `<a class="card artist-result" href="#/artist/${a.id}">
        ${avatarHTML(a.name)}<div style="min-width:0"><b>${esc(a.name)}</b>
        <div class="muted" style="font-size:13px">${esc([a.type, a.country, a.begin && "since " + a.begin].filter(Boolean).join(" · "))}</div>
        ${a.disambiguation ? `<div class="muted" style="font-size:13px;font-style:italic">${esc(a.disambiguation)}</div>` : ""}</div></a>`).join("")}</div>`;
    }
    return `<div class="album-grid">${list.map((a) => albumCard(a, { showMine: false })).join("")}</div>`;
  }

  // "eminem" → Eminem's albums first, then everything else that matched.
  function artistAndAlbumsHTML(data) {
    const ar = data.artist;
    const studio = data.artist_albums.filter((a) => a.type !== "EP");
    const eps = data.artist_albums.filter((a) => a.type === "EP");
    const meta = [ar.type, ar.country, ar.begin && "since " + ar.begin, ar.disambiguation].filter(Boolean).join(" · ");
    const grid = (list) => `<div class="album-grid">${list.map((a) => albumCard({ ...a, artist: null })).join("")}</div>`;
    const artistBlock = `<section class="card sr-artist">
      <a class="sr-artist-head" href="#/artist/${ar.id}">
        ${avatarHTML(ar.name, "avatar-md")}
        <div style="min-width:0"><span class="eyebrow">Artist</span><h2>${esc(ar.name)}</h2>${meta ? `<div class="muted">${esc(meta)}</div>` : ""}</div>
        <span class="btn btn-ghost btn-sm">Artist page →</span>
      </a>
      ${studio.length ? `<h3 class="sr-sub">Albums <span class="muted">${studio.length}</span></h3>${grid(studio)}` : ""}
      ${eps.length ? `<h3 class="sr-sub">EPs <span class="muted">${eps.length}</span></h3>${grid(eps)}` : ""}
    </section>`;
    const others = data.results.length ? `<section class="sr-others">
      <div class="section-head"><div><span class="eyebrow">${data.albums_first ? "Best matches" : "Also matching"}</span>
      <h2>${data.albums_first ? "Albums" : "Other results"}</h2></div></div>
      ${renderResults(data.results)}</section>` : "";
    return data.albums_first ? others + artistBlock : artistBlock + others;
  }

  function skeletonGrid() {
    return type === "artist"
      ? `<div class="artist-grid">${'<div class="skeleton" style="height:86px"></div>'.repeat(6)}</div>`
      : `<div class="album-grid">${'<div><div class="skeleton" style="aspect-ratio:1"></div><div class="skeleton" style="height:14px;margin-top:12px;width:80%"></div><div class="skeleton" style="height:12px;margin-top:8px;width:50%"></div></div>'.repeat(12)}</div>`;
  }

  if (q) await runSearch(q);
};

/* ---------- album ---------- */

VIEWS.album = async (view, route, alive) => {
  view.innerHTML = loadingHTML("Pulling the tracklist from MusicBrainz…");
  const d = await getData(`/api/album/${encodeURIComponent(route.id)}`);
  if (!alive()) return;
  const a = d.album;
  state.reviews[`album:${a.id}`] = d.mine ? d.mine.review : "";
  document.title = `${a.title} — ${a.artist} · Crescendo`;

  const discs = new Set(d.tracks.map((t) => t.disc)).size;
  let lastDisc = null;
  const trackRows = d.tracks.map((t, i) => {
    let head = "";
    if (discs > 1 && t.disc !== lastDisc) head = `<div class="disc-label">Disc ${t.disc}</div>`;
    lastDisc = t.disc;
    return head + `<div class="track ${t.my ? "rated" : ""}" data-track="${t.id}">
      <span class="n">${t.position}</span>
      <div style="min-width:0"><div class="title">${esc(t.title)}</div>${t.artist_credit ? `<div class="credit">${esc(t.artist_credit)}</div>` : ""}</div>
      <span class="len">${fmtLen(t.length_ms)}</span>
      <div class="comm" data-comm="song:${t.id}">${commHTML(t.avg, t.count)}</div>
      <div class="mine">${ratingLine("song", t.id, t.my, { album: a.id, label: `Rate ${t.title}` })}</div>
    </div>`;
  }).join("");

  const meta = [a.type || "Release", ...(a.secondary || []), a.year].filter(Boolean).join(" · ");
  view.innerHTML = `
  <div class="page-top">
    <div class="backdrop"><img class="bd-img" src="${coverUrl(a.id, 250)}" alt=""></div>
    <div class="wrap album-hero">
      ${coverHTML(a.id, a.title, 500)}
      <div style="min-width:0">
        <span class="eyebrow">${esc(meta)}</span>
        <h1>${esc(a.title)}</h1>
        <div class="by">by ${a.artist_id ? `<a href="#/artist/${a.artist_id}">${esc(a.artist)}</a>` : esc(a.artist)}</div>
        ${a.genres.length ? `<div class="chips" style="margin-top:16px">${a.genres.slice(0, 6).map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>` : ""}
        <div class="score-panel">
          <div class="card score-box"><div class="lbl">Crescendo average</div><div data-comm="album:${a.id}" data-style="big">${commHTML(d.stats.avg, d.stats.count, "big")}</div></div>
          <div class="card score-box"><div class="lbl">Your album rating</div>
            <div style="margin-top:6px">${ratingLine("album", a.id, d.mine && d.mine.score, { size: "lg", label: `Rate the album ${a.title}` })}</div>
            <div class="muted" style="font-size:13px;margin-top:8px" id="track-avg-hint"></div>
          </div>
        </div>
        <div class="actions">
          ${d.tracks.length ? `<button class="btn btn-gold btn-lg" id="start-session">${ICON.play} Rate track by track</button>` : ""}
          <button class="btn btn-ghost btn-lg ${d.mine && d.mine.listen_later ? "on" : ""}" id="listen-later">${ICON.bookmark} <span>${d.mine && d.mine.listen_later ? "In Listen Later" : "Listen later"}</span></button>
        </div>
      </div>
    </div>
  </div>

  <section class="wrap" style="padding-top:12px">
    <div id="album-progress"></div>
    ${d.tracks.length ? `<div class="tracklist">
      <div class="track track-head"><span class="n">#</span><span>Title</span><span>Length</span><span>Community</span><span>Your rating</span></div>
      ${trackRows}</div>` : `<div class="empty-state">MusicBrainz doesn't have a tracklist for this release yet. You can still rate the album as a whole.</div>`}
  </section>

  <section class="wrap section two-col">
    <div>
      <div class="section-head"><div><span class="eyebrow">Reviews</span><h2>What listeners say</h2></div></div>
      <div id="reviews">${reviewsHTML(d.reviews)}</div>
    </div>
    <div>
      <div class="section-head"><div><span class="eyebrow">Your take</span><h2>Write a review</h2></div></div>
      <div class="card review-box" style="padding:20px">
        <textarea id="review-text" maxlength="2000" placeholder="${state.me ? "What makes this album work (or not)?" : "Log in to write a review."}">${esc(d.mine ? d.mine.review : "")}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:12px">
          <span class="muted" style="font-size:13px">Saved with your album rating.</span>
          <button class="btn btn-quiet btn-sm" id="save-review">Save review</button>
        </div>
      </div>
    </div>
  </section>`;

  wireRatingStars(view);
  const model = d;
  const updateProgress = () => {
    const rated = model.tracks.filter((t) => t.my);
    const total = model.tracks.length;
    const avg = rated.length ? rated.reduce((s, t) => s + t.my, 0) / rated.length : null;
    $("#track-avg-hint").textContent = avg ? `Your track average: ★ ${fmt(avg)}` : "";
    const box = $("#album-progress");
    if (!state.me || !total) { box.innerHTML = ""; return; }
    box.innerHTML = rated.length === total
      ? `<div class="card album-progress"><span>✦ <b>Album complete.</b> You rated all ${total} tracks — average ★ ${fmt(avg)}.</span></div>`
      : `<div class="card album-progress"><span class="nowrap"><b>${rated.length}</b> / ${total} rated</span><div class="progress-bar"><span style="width:${(rated.length / total) * 100}%"></span></div>
         <button class="btn btn-quiet btn-sm" data-resume>${rated.length ? "Continue" : "Start"}</button></div>`;
    const resume = $("[data-resume]", box);
    if (resume) resume.addEventListener("click", () => openSession(model, model.tracks.findIndex((t) => !t.my)));
  };
  updateProgress();

  state.onRated = (kind, id, score) => {
    if (kind === "song") {
      model.tracks.filter((t) => t.id === id).forEach((t) => (t.my = score));
      $$(`[data-track="${CSS.escape(id)}"]`, view).forEach((r) => r.classList.toggle("rated", !!score));
      updateProgress();
    } else if (kind === "album" && model.mine) {
      model.mine.score = score;
    }
  };

  const start = $("#start-session");
  if (start) start.addEventListener("click", () => {
    const firstUnrated = model.tracks.findIndex((t) => !t.my);
    openSession(model, firstUnrated < 0 ? 0 : firstUnrated);
  });

  $("#listen-later").addEventListener("click", async (e) => {
    if (!state.me) return openAuth("join");
    const btn = e.currentTarget;
    const on = btn.classList.contains("on");
    try {
      await api(on ? "DELETE" : "POST", `/api/listen-later/${a.id}`);
      btn.classList.toggle("on", !on);
      $("span", btn).textContent = on ? "Listen later" : "In Listen Later";
      toast(on ? "Removed from Listen Later" : "Saved to Listen Later");
    } catch (err) { toast(err.message, true); }
  });

  $("#save-review").addEventListener("click", async () => {
    if (!state.me) return openAuth("join");
    const text = $("#review-text").value.trim();
    const score = model.mine && model.mine.score;
    if (!score) { toast("Give the album a star rating first, then save your review.", true); $(".stars[data-kind=album]").focus(); return; }
    try {
      await api("PUT", "/api/ratings/album", { album: a.id, score, review: text });
      state.reviews[`album:${a.id}`] = text;
      toast("Review saved");
      const fresh = await api("GET", `/api/album/${a.id}`);
      if (alive()) $("#reviews").innerHTML = reviewsHTML(fresh.reviews);
    } catch (err) { toast(err.message, true); }
  });

  if (route.params.get("rate") === "1" && model.tracks.length) openSession(model, Math.max(0, model.tracks.findIndex((t) => !t.my)));
};

function reviewsHTML(list) {
  if (!list.length) return `<div class="empty-state">No written reviews yet. Be the first.</div>`;
  return list.map((r) => `<div class="review"><div class="review-head">${avatarHTML(r.username)}
    <div><a href="#/u/${encodeURIComponent(r.username)}"><b>${esc(r.username)}</b></a><div class="muted" style="font-size:13px">${timeAgo(r.updated_at)}</div></div>
    <div style="margin-left:auto">${starsHTML(r.score, { size: "sm" })}</div></div><p>${esc(r.review)}</p></div>`).join("");
}

/* ---------- track-by-track session ---------- */

let session = null;

function openSession(model, startIndex = 0) {
  if (!model.tracks.length) return;
  closeSession();
  const a = model.album;
  const el = document.createElement("div");
  el.className = "session";
  el.tabIndex = -1;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", `Rate ${a.title} track by track`);
  el.innerHTML = `<div class="backdrop"><img class="bd-img" src="${coverUrl(a.id, 250)}" alt=""></div>
    <div class="session-top">
      <div class="session-album">${coverHTML(a.id, a.title)}<div><b>${esc(a.title)}</b><span>${esc(a.artist)}</span></div></div>
      <button class="icon-btn" data-exit aria-label="Close">${ICON.x}</button>
    </div>
    <div class="session-body" id="session-body"></div>
    <div class="session-dots" id="session-dots"></div>
    <div class="session-keys"><kbd>1</kbd>–<kbd>5</kbd> rate · <kbd>Shift</kbd>+number adds a half star · <kbd>←</kbd> <kbd>→</kbd> move · <kbd>Esc</kbd> close</div>`;
  document.body.append(el);
  document.body.style.overflow = "hidden";
  session = { model, idx: Math.max(0, startIndex), el, final: false, advanceTimer: null, albumScore: null };
  $("[data-exit]", el).addEventListener("click", () => closeSession({ user: true }));
  session.onKey = (e) => sessionKey(e);
  document.addEventListener("keydown", session.onKey);
  renderSession();
}

function closeSession({ user = false } = {}) {
  if (!session) return;
  const stale = session.stale;
  clearTimeout(session.advanceTimer);
  document.removeEventListener("keydown", session.onKey);
  session.el.remove();
  session = null;
  document.body.style.overflow = "";
  if (user && stale) render();
}

function renderSession() {
  const { model, idx, el } = session;
  const tracks = model.tracks;
  $("#session-dots", el).innerHTML = tracks.map((t, i) =>
    `<button class="${t.my ? "done" : ""} ${!session.final && i === idx ? "cur" : ""}" data-go="${i}" aria-label="Track ${i + 1}: ${esc(t.title)}${t.my ? ", rated " + fmt(t.my) : ""}"></button>`).join("")
    + `<button class="${session.final ? "cur" : ""}" data-go="final" aria-label="Album rating" style="width:40px"></button>`;
  $$("[data-go]", el).forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.go === "final") { session.final = true; } else { session.final = false; session.idx = Number(b.dataset.go); }
    renderSession();
  }));
  const body = $("#session-body", el);
  if (session.final) return renderSessionFinal(body);

  const t = tracks[idx];
  body.innerHTML = `
    <div class="session-count">Track ${idx + 1} of ${tracks.length}</div>
    <h2 class="session-title">${esc(t.title)}</h2>
    <div class="session-meta">${[fmtLen(t.length_ms), t.artist_credit, t.count ? `community ★ ${fmt(t.avg)} (${t.count})` : "no community ratings yet"].filter(Boolean).map(esc).join(" · ")}</div>
    <div style="margin-top:12px">${starsHTML(t.my, { kind: "song", id: t.id, album: model.album.id, size: "xl", label: `Rate ${t.title}` })}</div>
    <div class="session-score ${t.my ? "" : "empty"}" id="session-score">${t.my ? `${fmt(t.my)} <span style="font-size:.6em;color:var(--muted)">/ 5</span>` : "Tap a star — or press 1 to 5"}</div>
    <div class="session-nav">
      <button class="btn btn-ghost" data-prev ${idx === 0 ? "disabled" : ""}>${ICON.left} Previous</button>
      <button class="btn btn-quiet" data-next>${t.my ? "Next" : "Skip"} ${ICON.right}</button>
    </div>`;
  wireStars($(".stars", body), (v) => sessionRate(v));
  if (!el.contains(document.activeElement) || document.activeElement.closest("#session-body")) el.focus({ preventScroll: true });
  $("[data-prev]", body).addEventListener("click", () => sessionMove(-1));
  $("[data-next]", body).addEventListener("click", () => sessionMove(1));
}

async function sessionRate(v) {
  if (!session || session.final) return;
  const t = session.model.tracks[session.idx];
  const el = $(".stars", session.el);
  const ok = await rate("song", t.id, session.model.album.id, v, el);
  if (!ok || !session) return;
  t.my = v;
  const scoreEl = $("#session-score", session.el);
  if (scoreEl) {
    scoreEl.classList.toggle("empty", !v);
    scoreEl.innerHTML = v ? `${fmt(v)} <span style="font-size:.6em;color:var(--muted)">/ 5</span>` : "Tap a star — or press 1 to 5";
  }
  $$("#session-dots button", session.el)[session.idx].classList.toggle("done", !!v);
  if (v) {
    clearTimeout(session.advanceTimer);
    session.advanceTimer = setTimeout(() => sessionMove(1), 520);
  }
}

function sessionMove(dir) {
  if (!session) return;
  clearTimeout(session.advanceTimer);
  if (session.final) {
    if (dir < 0) { session.final = false; session.idx = session.model.tracks.length - 1; renderSession(); }
    return;
  }
  const next = session.idx + dir;
  if (next < 0) return;
  if (next >= session.model.tracks.length) { session.final = true; } else { session.idx = next; }
  renderSession();
}

function renderSessionFinal(body) {
  const { model } = session;
  const rated = model.tracks.filter((t) => t.my);
  const avg = rated.length ? rated.reduce((s, t) => s + t.my, 0) / rated.length : null;
  const current = model.mine && model.mine.score;
  const suggestion = current || (avg ? Math.round(avg) : null);
  session.albumScore = suggestion;
  const best = [...rated].sort((x, y) => y.my - x.my)[0];
  body.classList.add("session-final");
  body.innerHTML = `
    <div class="session-count">${rated.length === model.tracks.length ? "Album complete" : `${rated.length} of ${model.tracks.length} tracks rated`}</div>
    <h2 class="session-title">Now, the album as a whole.</h2>
    <div class="suggest">${avg ? `Your track average is <b style="color:var(--gold-2)">★ ${fmt(avg)}</b>${best ? ` · favorite: <b>${esc(best.title)}</b>` : ""}` : "You skipped every track — you can still rate the album."}</div>
    <div>${starsHTML(suggestion, { size: "xl", label: "Album rating", interactive: true })}</div>
    <div class="session-score ${suggestion ? "" : "empty"}" id="final-score">${suggestion ? fmt(suggestion) : "Pick a score"}</div>
    <textarea id="final-review" maxlength="2000" placeholder="Add a short review (optional)">${esc(state.reviews[`album:${model.album.id}`] || "")}</textarea>
    <div class="session-nav">
      <button class="btn btn-ghost" data-back>${ICON.left} Back to tracks</button>
      <button class="btn btn-gold btn-lg" data-save>Save album rating</button>
    </div>`;
  const stars = $(".stars", body);
  wireStars(stars, (v) => {
    session.albumScore = v;
    setStarsValue(stars, v);
    const s = $("#final-score", body);
    s.textContent = v ? fmt(v) : "Pick a score";
    s.classList.toggle("empty", !v);
  });
  $("[data-back]", body).addEventListener("click", () => sessionMove(-1));
  $("[data-save]", body).addEventListener("click", async () => {
    if (!state.me) { openAuth("join"); return; }
    if (!session.albumScore) { toast("Pick a star rating for the album first.", true); stars.focus(); return; }
    const review = $("#final-review", body).value.trim();
    try {
      const res = await api("PUT", "/api/ratings/album", { album: model.album.id, score: session.albumScore, review });
      state.reviews[`album:${model.album.id}`] = review;
      if (model.mine) model.mine.score = session.albumScore;
      $$(`.stars[data-kind="album"][data-id="${CSS.escape(model.album.id)}"]`).forEach((s) => setStarsValue(s, session.albumScore, { pop: false }));
      $$(`[data-comm="album:${CSS.escape(model.album.id)}"]`).forEach((n) => (n.innerHTML = commHTML(res.avg, res.count, n.dataset.style)));
      celebrate();
      const me = state.me.username;
      body.innerHTML = `<div class="session-count">Saved</div><h2 class="session-title">That's a wrap. ✦</h2>
        <div class="suggest">${esc(model.album.title)} is now part of your Taste DNA.</div>
        <div class="session-nav" style="margin-top:12px">
          <a class="btn btn-gold btn-lg" href="#/u/${encodeURIComponent(me)}">See my Taste DNA</a>
          <a class="btn btn-ghost btn-lg" href="#/search">Rate another album</a>
          <button class="btn btn-quiet btn-lg" data-done>Back to album</button></div>`;
      $("[data-done]", body).addEventListener("click", () => { closeSession(); render(); });
      $$("a", body).forEach((l) => l.addEventListener("click", closeSession));
    } catch (err) { toast(err.message, true); }
  });
}

function sessionKey(e) {
  if (!session) return;
  if ($("#modal-root").children.length) return;
  const typing = e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT";
  if (e.key === "Escape") { closeSession({ user: true }); return; }
  if (typing) return;
  const digit = /^(Digit|Numpad)([0-5])$/.exec(e.code);
  if (digit && !session.final) {
    e.preventDefault();
    const d = Number(digit[2]);
    const v = Math.min(10, d * 2 + (e.shiftKey ? 1 : 0));
    if (v >= 1) sessionRate(v);
    return;
  }
  if (e.target.closest && e.target.closest(".stars")) return; // let the widget handle arrows
  if (e.key === "Enter" && e.target.closest && e.target.closest("button, a")) return;
  if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); sessionMove(1); }
  if (e.key === "ArrowLeft") { e.preventDefault(); sessionMove(-1); }
}

function celebrate() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#F4D66A", "#E9B54A", "#F3EBDD", "#E7745F"];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement("span");
    p.className = "burst";
    const ang = Math.random() * Math.PI * 2, dist = 160 + Math.random() * 320;
    p.style.cssText = `left:50%;top:45%;background:${colors[i % colors.length]};--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px;--r:${Math.random() * 720}deg;animation-delay:${Math.random() * 0.12}s`;
    document.body.append(p);
    setTimeout(() => p.remove(), 1400);
  }
}

/* ---------- artist ---------- */

VIEWS.artist = async (view, route, alive) => {
  view.innerHTML = loadingHTML("Loading the discography from MusicBrainz…");
  const d = await getData(`/api/artist/${encodeURIComponent(route.id)}`);
  if (!alive()) return;
  const ar = d.artist;
  state.reviews[`artist:${ar.id}`] = d.mine ? d.mine.review : "";
  document.title = `${ar.name} · Crescendo`;
  const studio = d.albums.filter((a) => a.type === "Album" && !a.secondary.length);
  const eps = d.albums.filter((a) => a.type === "EP" && !a.secondary.length);
  const mosaic = (studio.length ? studio : d.albums).slice(-4);
  const years = ar.begin ? `${ar.begin}${ar.end ? "–" + ar.end : "–present"}` : null;
  const section = (title, list, eyebrow, limit = Infinity) => list.length ? `<section class="section" style="padding-top:28px;padding-bottom:20px">
      <div class="section-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><span class="muted">${list.length}</span></div>
      <div class="album-grid">${list.map((a, i) => albumCard({ ...a, artist: null }).replace("<a ", i >= limit ? "<a hidden " : "<a ")).join("")}</div>
      ${list.length > limit ? `<div style="text-align:center;margin-top:26px"><button class="btn btn-ghost" data-show-all>Show all ${list.length}</button></div>` : ""}</section>` : "";

  view.innerHTML = `
  <div class="page-top">
    <div class="artist-bg"><div class="artist-mosaic">${mosaic.map((a) => `<img class="bd-img" src="${coverUrl(a.id, 250)}" alt="" style="width:100%;height:100%;object-fit:cover">`).join("")}</div></div><div class="fade"></div>
    <div class="wrap artist-hero">
      <span class="eyebrow">${esc(ar.type || "Artist")}</span>
      <h1 style="margin-top:14px">${esc(ar.name)}</h1>
      <div class="meta-line">${[ar.country, years, ar.disambiguation].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</div>
      ${ar.genres.length ? `<div class="chips" style="margin-top:18px">${ar.genres.slice(0, 6).map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>` : ""}
      <div class="score-panel">
        <div class="card score-box"><div class="lbl">Crescendo average</div><div data-comm="artist:${ar.id}" data-style="big">${commHTML(d.stats.avg, d.stats.count, "big")}</div></div>
        <div class="card score-box"><div class="lbl">Your artist rating</div><div style="margin-top:6px">${ratingLine("artist", ar.id, d.mine && d.mine.score, { size: "lg", label: `Rate ${ar.name}` })}</div></div>
      </div>
    </div>
  </div>
  <div class="wrap">
    ${d.top_songs.length ? `<section class="section" style="padding-bottom:10px"><div class="section-head"><div><span class="eyebrow">Community picks</span><h2>Top-rated songs</h2></div></div>
      <div class="song-list">${d.top_songs.map((s, i) => `<a class="song-row" href="#/album/${s.album_id}"><span class="i">${i + 1}</span>
        <div style="min-width:0"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.album_title)}</div></div>
        <span class="rating-line">${starsHTML(Math.round(s.avg), { size: "sm" })}<span class="score-num">${fmt(s.avg)}</span><span class="muted" style="font-size:13px">(${s.count})</span></span></a>`).join("")}</div></section>` : ""}
    ${section("Albums", studio, "Discography")}
    ${section("EPs", eps, "Shorter releases")}
    <section class="section" id="other-releases" style="padding-top:28px;padding-bottom:20px">
      <div class="section-head"><div><span class="eyebrow">Everything else</span><h2>Live, compilations &amp; more</h2></div></div>
      <button class="btn btn-ghost" data-load-other>Show live albums, compilations &amp; more</button>
    </section>
    ${!d.albums.length ? `<div class="empty-state" style="margin-top:30px">MusicBrainz lists no albums or EPs for this artist.</div>` : ""}
  </div>`;
  wireRatingStars(view);
  const wireShowAll = (root) => $$("[data-show-all]", root).forEach((b) => b.addEventListener("click", () => {
    $$("a[hidden]", b.closest("section")).forEach((a) => (a.hidden = false));
    b.remove();
  }));
  const loadOther = $("[data-load-other]", view);
  loadOther.addEventListener("click", async () => {
    const box = $("#other-releases", view);
    loadOther.disabled = true;
    loadOther.innerHTML = `<span class="eq eq-sm"><span></span><span></span><span></span></span> Loading from MusicBrainz…`;
    try {
      const more = await api("GET", `/api/artist/${encodeURIComponent(ar.id)}/other`);
      if (!alive()) return;
      box.outerHTML = section("Live, compilations & more", more.albums, "Everything else", 12)
        || `<section class="section" style="padding-top:28px"><div class="empty-state">No live albums or compilations listed.</div></section>`;
      wireShowAll(view);
    } catch (err) {
      loadOther.disabled = false;
      loadOther.textContent = "Try again";
      toast(err.message, true);
    }
  });
};

/* ---------- profile ---------- */

VIEWS.user = async (view, route, alive) => {
  view.innerHTML = loadingHTML();
  const d = await api("GET", `/api/users/${encodeURIComponent(route.id)}`);
  if (!alive()) return;
  const u = d.user, c = d.counts;
  document.title = `${u.username} · Crescendo`;
  const totalSongs = d.distribution.reduce((s, n) => s + n, 0);
  const maxBar = Math.max(1, ...d.distribution);
  const highShare = totalSongs ? d.distribution.slice(7).reduce((s, n) => s + n, 0) / totalSongs : 0;
  const lowShare = totalSongs ? d.distribution.slice(0, 4).reduce((s, n) => s + n, 0) / totalSongs : 0;
  const mode = d.distribution.indexOf(maxBar) + 1;
  let verdict = "";
  if (totalSongs >= 5) {
    if (c.avg >= 7.6) verdict = `✦ Generous ear — ${Math.round(highShare * 100)}% of song ratings are 4★ or higher`;
    else if (c.avg <= 5.2) verdict = `✦ Tough critic — ${Math.round(lowShare * 100)}% of song ratings are 2★ or lower`;
    else verdict = `✦ Balanced listener — most often rates songs ★ ${fmt(mode)}`;
  }
  const gsum = d.genres.reduce((s, g) => s + g.weight, 0) || 1;
  const me = d.is_me;
  const empty = !c.songs && !c.albums && !c.artists;

  view.innerHTML = `<div class="page-top"><div class="hero" style="position:absolute;inset:0;padding:0;z-index:-1"></div>
  <div class="wrap profile-hero">
    ${avatarHTML(u.username, "avatar-lg")}
    <div style="min-width:0">
      <span class="eyebrow">Listener since ${new Date(u.joined * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
      <h1 style="margin-top:10px">${esc(u.username)}</h1>
      <p class="bio" id="bio">${u.bio ? esc(u.bio) : me ? '<span class="muted">Add a bio so people know what you\'re into.</span>' : ""}</p>
      <div class="profile-stats">
        <div><b>${num(c.songs)}</b><span>Songs</span></div>
        <div><b>${num(c.albums)}</b><span>Albums</span></div>
        <div><b>${num(c.artists)}</b><span>Artists</span></div>
        <div><b>${num(c.followers)}</b><span>Followers</span></div>
        <div><b>${num(c.following)}</b><span>Following</span></div>
      </div>
    </div>
    <div class="match-box">
      ${me ? `<button class="btn btn-ghost btn-sm" id="edit-bio">Edit bio</button><button class="btn btn-quiet btn-sm" id="logout">Log out</button>`
        : d.match ? `<div class="ring ring-lg" style="--p:${d.match.percent}"><span>${d.match.percent}%<small>match</small></span></div>
          <div class="why">${d.match.shared_genres.length ? "You both love " + d.match.shared_genres.slice(0, 3).map(esc).join(", ") : "Rate more to sharpen this"}${d.match.common ? ` · ${plural(d.match.common, "rating")} in common` : ""}</div>`
        : !state.me ? `<button class="btn btn-ghost btn-sm" data-auth="join">See your match %</button>` : ""}
      ${!me && state.me ? `<button class="btn ${d.following ? "btn-ghost on" : "btn-gold"} btn-sm" id="follow">${d.following ? "Following" : "Follow"}</button>` : ""}
    </div>
  </div></div>

  <div class="wrap">
    ${empty ? `<div class="empty-state" style="margin-top:20px">${me ? `Your Taste DNA appears once you start rating.<br><a class="btn btn-gold" style="margin-top:16px" href="#/search">Rate your first album</a>` : "No ratings yet."}</div>` : `
    <section class="section" style="padding-top:20px">
      <div class="section-head"><div><span class="eyebrow">Taste DNA</span><h2>${me ? "What your ears are into" : `What ${esc(u.username)} is into`}</h2></div></div>
      <div class="dna">
        <div class="card"><h3>Genre fingerprint</h3><p class="sub">Share of taste by genre, weighted toward what's rated highest.</p>
          ${d.genres.length ? d.genres.map((g, i) => `<div class="gbar" data-tip="<b>${esc(g.name)}</b> · ${Math.round((g.weight / gsum) * 100)}% of taste">
            <span class="name">${esc(g.name)}</span><div class="track-bg"><div class="fill" style="width:${g.weight * 100}%;animation-delay:${i * 60}ms"></div></div>
            <span class="pct">${Math.round((g.weight / gsum) * 100)}%</span></div>`).join("") : '<p class="muted">No genre data yet for the rated albums.</p>'}
        </div>
        <div class="card"><h3>Song ratings</h3><p class="sub">How ${plural(totalSongs, "song rating")} are spread across the 5-star scale.</p>
          <div class="histo" role="img" aria-label="Rating distribution: ${d.distribution.map((n, i) => `${fmt(i + 1)} stars ${n}`).join(", ")}">
            ${d.distribution.map((n, i) => `<div class="col ${n ? "" : "zero"}" data-tip="<b>★ ${fmt(i + 1)}</b> · ${plural(n, "song")}"><span style="height:${(n / maxBar) * 100}%;animation-delay:${i * 40}ms"></span></div>`).join("")}
          </div>
          <div class="histo-axis">${d.distribution.map((_, i) => `<span>${i % 2 ? `${(i + 1) / 2}★` : ""}</span>`).join("")}</div>
          <div class="histo-note"><span>Average <b style="color:var(--gold-2)">★ ${fmt(c.avg)}</b></span><span>${plural(totalSongs, "song")}</span></div>
          ${verdict ? `<div class="verdict">${verdict}</div>` : ""}
        </div>
      </div>
    </section>

    ${me && d.in_progress.length ? `<section class="section" style="padding-top:10px"><div class="section-head"><div><span class="eyebrow">Unfinished</span><h2>Continue rating</h2></div></div>
      <div class="progress-grid">${d.in_progress.map(progressCard).join("")}</div></section>` : ""}

    ${d.top_albums.length ? `<section class="section" style="padding-top:10px"><div class="section-head"><div><span class="eyebrow">Hall of fame</span><h2>Top albums</h2></div></div>
      <div class="album-grid">${d.top_albums.map((a) => albumCard({ ...a, my: a.score })).join("")}</div></section>` : ""}

    <section class="section two-col" style="padding-top:10px">
      <div>${d.top_songs.length ? `<div class="section-head"><div><span class="eyebrow">On repeat</span><h2>Top songs</h2></div></div>
        <div class="song-list">${d.top_songs.map((s, i) => `<a class="song-row" href="#/album/${s.album_id}"><span class="i">${i + 1}</span>
          <div style="min-width:0"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.artist)} · ${esc(s.album_title)}</div></div>
          <span class="rating-line">${starsHTML(s.score, { size: "sm" })}</span></a>`).join("")}</div>` : ""}</div>
      <div>${d.top_artists.length ? `<div class="section-head"><div><span class="eyebrow">Most loved</span><h2>Top artists</h2></div></div>
        <div>${d.top_artists.map((a) => `<a class="artist-row" href="#/artist/${a.id}">${a.cover_album ? coverHTML(a.cover_album, a.name) : avatarHTML(a.name)}
          <div style="min-width:0"><b>${esc(a.name)}</b><div class="muted" style="font-size:13px">${plural(a.n, "rating")}</div></div>
          <span class="rating-line">${starsHTML(Math.round(a.explicit || a.avg), { size: "sm" })}<span class="score-num">${fmt(a.explicit || a.avg)}</span></span></a>`).join("")}</div>` : ""}</div>
    </section>

    ${d.recent.length ? `<section class="section" style="padding-top:10px"><div class="section-head"><div><span class="eyebrow">Diary</span><h2>Recent activity</h2></div></div>
      <div class="feed" style="max-width:760px">${d.recent.map(feedItem).join("")}</div></section>` : ""}`}

    ${d.listen_later.length ? `<section class="section" style="padding-top:10px"><div class="section-head"><div><span class="eyebrow">Queued up</span><h2>Listen later</h2></div></div>
      <div class="album-grid">${d.listen_later.map((a) => albumCard(a)).join("")}</div></section>` : ""}
  </div>`;

  $$("[data-auth]", view).forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
  const follow = $("#follow", view);
  if (follow) follow.addEventListener("click", async () => {
    const on = follow.classList.contains("on");
    try {
      await api(on ? "DELETE" : "POST", `/api/users/${encodeURIComponent(u.username)}/follow`);
      render();
    } catch (err) { toast(err.message, true); }
  });
  const lo = $("#logout", view);
  if (lo) lo.addEventListener("click", logout);
  const eb = $("#edit-bio", view);
  if (eb) eb.addEventListener("click", () => {
    const m = openModal(`<h2>Edit bio</h2><p class="lede">A line or two about what you listen to.</p>
      <div class="field"><textarea id="bio-text" maxlength="280" style="min-height:110px;padding:14px;border-radius:12px;border:1px solid var(--line-2);background:var(--bg-2);outline:none">${esc(u.bio)}</textarea></div>
      <button class="btn btn-gold" id="bio-save" style="width:100%">Save</button>`);
    $("#bio-save", m).addEventListener("click", async () => {
      try { await api("PUT", "/api/me", { bio: $("#bio-text", m).value }); closeModal(); render(); }
      catch (err) { toast(err.message, true); }
    });
  });
};

/* ---------- people ---------- */

VIEWS.people = async (view, route, alive) => {
  view.innerHTML = loadingHTML("Comparing tastes…");
  const d = await api("GET", "/api/people");
  if (!alive()) return;
  document.title = "People · Crescendo";
  view.innerHTML = `<div class="wrap">
    <div class="welcome" style="padding-bottom:30px"><span class="eyebrow">Taste matching</span>
      <h1 style="margin-top:12px">${state.me ? "People who hear <em>what you hear.</em>" : "Meet the <em>listeners.</em>"}</h1>
      <p class="dim" style="max-width:620px;margin-top:14px">${state.me
        ? "Ranked by how closely their ratings and genre fingerprint line up with yours. The more you rate, the sharper this gets."
        : "Create an account and rate a few albums — Crescendo will rank everyone here by how closely they match your taste."}</p>
      ${!state.me ? `<div class="actions"><button class="btn btn-gold" data-auth="join">Find my matches</button></div>` : ""}
    </div>
    ${d.people.length ? `<div class="people">${d.people.map((p) => `<a class="card person" href="#/u/${encodeURIComponent(p.username)}">
      ${avatarHTML(p.username)}
      <div style="min-width:0"><div class="n">${esc(p.username)}</div>
        <div class="g">${p.top_genres.length ? p.top_genres.map(esc).join(" · ") : "—"}</div>
        <div class="muted" style="font-size:13px;margin-top:2px">${plural(p.ratings, "rating")}${p.following ? " · following" : ""}</div></div>
      ${p.match ? `<span class="ring" style="--p:${p.match.percent}" data-tip="${p.match.percent}% taste match${p.match.common ? " · " + p.match.common + " in common" : ""}"><span>${p.match.percent}</span></span>` : ""}
    </a>`).join("")}</div>` : `<div class="empty-state">No other listeners have rated anything yet.</div>`}
  </div>`;
  $$("[data-auth]", view).forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
};

/* ---------- boot ---------- */

(async function boot() {
  try {
    const { user } = await api("GET", "/api/me");
    state.me = user;
  } catch { /* offline: render anyway */ }
  lastPath = location.hash.split("?")[0];
  render();
})();
