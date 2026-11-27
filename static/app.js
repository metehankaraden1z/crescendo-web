"use strict";

/* ===================================================================
   Crescendo — single-page front end (no build step, no framework)
   =================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  me: null,
  config: {},         // { google_client_id, turnstile_sitekey } from /api/config
  renderId: 0,
  onRated: null,      // page-level hook called after a rating is saved
  reviews: {},        // "album:<id>" / "artist:<id>" -> current review text
};

/* ---------- small helpers ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.75 5.75 6.3.8-4.62 4.36 1.16 6.24L12 16.7l-5.59 3.05 1.16-6.24L2.95 9.15l6.3-.8z"/></svg>';
// a record with its orange centre label
const LOGO = '<svg class="logo-mark" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="#F2EFE8"/><circle cx="13" cy="13" r="8.5" fill="none" stroke="#121110" stroke-opacity=".18"/><circle cx="13" cy="13" r="4.6" fill="#FF6A2B"/><circle cx="13" cy="13" r="1.3" fill="#121110"/></svg>';

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

// toast("Saved") or toast("Changed", false, { label: "Undo", onClick })
function toast(msg, err = false, action = null) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  const text = document.createElement("span");
  text.textContent = msg;
  el.append(text);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => { el.remove(); action.onClick(); });
    el.append(b);
  }
  $("#toast-root").append(el);
  setTimeout(() => el.remove(), action ? 6000 : 3200);
}

/* ---------- reusable markup ---------- */

// A sleeve: the 250px thumbnail (usually cached from the grid) shows first; a 500px copy fades in over it
// when asked for. Until any art arrives the sleeve is plain, with the title typed on it.
function coverHTML(id, title, size = 250, cls = "", sticker = "") {
  return `<div class="cover ${cls}">
    <span class="cover-fallback">${esc(title || "")}</span>
    ${id ? `<img class="cover-img" src="${coverUrl(id, 250)}" alt="" loading="lazy" decoding="async">` : ""}
    ${id && size > 250 ? `<img class="cover-img" src="${coverUrl(id, size)}" alt="" decoding="async">` : ""}
    ${sticker}
  </div>`;
}

function stickerHTML(value, { mine = false, label } = {}) {
  if (!value) return "";
  const text = label || (mine ? `Their score ${fmt(value)} of 5` : `Average ${fmt(value)} of 5`);
  return `<span class="sticker ${mine ? "mine" : ""}" role="img" aria-label="${esc(text)}" title="${esc(text)}">${fmt(value)}</span>`;
}

function avatarHTML(name, cls = "") {
  return `<span class="avatar ${cls}" aria-hidden="true">${esc(String(name || "?")[0])}</span>`;
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
    return avg
      ? `<div class="big"><span class="sticker-inline">${fmt(avg)}</span><span>${plural(count || 0, "rating")}</span></div>`
      : `<div class="big"><span>No ratings yet</span></div>`;
  }
  return `<span class="k">Avg</span><span class="bar"><span style="width:${avg ? avg * 10 : 0}%"></span></span>
    <b>${avg ? fmt(avg) : "–"}</b><span class="nowrap" data-tip="${plural(count || 0, "rating")} on Crescendo">${count ? "(" + count + ")" : ""}</span>`;
}

// A record in the bin: the community average is its price sticker; your own score is a labelled line under it.
function albumCard(a, { showMine = true, stickerMine = false } = {}) {
  const meta = [a.year, a.type && a.type !== "Album" ? a.type : null].filter(Boolean).join(" · ");
  const sticker = stickerMine ? stickerHTML(a.my, { mine: true }) : stickerHTML(a.avg);
  const you = showMine && a.my && !stickerMine ? `<span class="you">You: ${fmt(a.my)}</span>` : "";
  return `<a class="album-card" href="#/album/${a.id}">
    ${coverHTML(a.id, a.title, 250, "", sticker)}
    <div>
      <div class="t">${esc(a.title)}</div>
      ${a.artist ? `<div class="a">${esc(a.artist)}</div>` : ""}
      ${you || meta ? `<div class="meta">${you}${meta ? `<span>${esc(meta)}</span>` : ""}</div>` : ""}
    </div>
  </a>`;
}

function feedItem(e) {
  let what, detail = "";
  const user = `<a href="#/u/${encodeURIComponent(e.username)}"><b>${esc(e.username)}</b></a>`;
  const albumLink = e.album_id ? `<a class="item" href="#/album/${e.album_id}">${esc(e.album_title)}</a>` : "";
  if (e.kind === "songs") {
    what = e.n > 1
      ? `${user} rated ${e.n} tracks from ${albumLink}`
      : `${user} rated <a class="item" href="#/album/${e.album_id}">${esc(e.first_title)}</a> <span class="muted">from</span> ${albumLink}`;
    if (e.n > 1) detail = "track average";
  } else if (e.kind === "album") {
    what = `${user} rated ${albumLink}`;
    if (e.n) detail = `album · ${plural(e.n, "track")} rated`;
  } else {
    what = `${user} rated the artist <a class="item" href="#/artist/${e.item_id}">${esc(e.item_title)}</a>`;
  }
  const sub = e.kind !== "artist" && e.artist ? ` · ${esc(e.artist)}` : "";
  return `<div class="feed-item">
    ${avatarHTML(e.username)}
    <div class="what">${what}
      <div class="when">${starsHTML(Math.round(e.score), { size: "sm" })}<span class="score-num">${fmt(e.score)}</span>${detail ? `<span>${detail}</span>` : ""}<span>${timeAgo(e.at)}${sub}</span></div>
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
    <button class="btn btn-ghost" data-retry-render>Try again</button></div></div>`;
}

// Inline onclick handlers are blocked by the Content-Security-Policy, so wire it here.
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("[data-retry-render]")) render();
});

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
    toast("Rating saved. Welcome to Crescendo.");
  } catch { /* ignore */ }
}

/* ---------- tooltip & image fallbacks ---------- */

document.addEventListener("load", (e) => {
  const img = e.target;
  if (!img.classList || !img.classList.contains("cover-img")) return;
  // the archive sometimes answers with a tiny placeholder: keep the typed sleeve instead
  img.classList.add(img.naturalWidth && img.naturalWidth < 50 ? "broken" : "loaded");
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

/* ---------- third-party sign-in widgets (loaded only when the auth window opens) ---------- */

const scriptLoads = new Map();
function loadScript(src) {
  if (!scriptLoads.has(src)) {
    scriptLoads.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { scriptLoads.delete(src); reject(new Error("Couldn't load " + src)); };
      document.head.append(s);
    }));
  }
  return scriptLoads.get(src);
}

async function mountGoogleButton(el, onCredential) {
  const id = state.config && state.config.google_client_id;
  if (!id || !el) return;
  try {
    await loadScript("https://accounts.google.com/gsi/client");
    google.accounts.id.initialize({ client_id: id, callback: (r) => onCredential(r.credential), ux_mode: "popup" });
    google.accounts.id.renderButton(el, {
      theme: "filled_black", size: "large", shape: "pill", text: "continue_with", width: Math.min(392, el.clientWidth || 392),
    });
  } catch {
    el.closest(".alt-auth").hidden = true; // blocked by an extension or offline: just hide it
  }
}

async function mountTurnstile(el, onToken) {
  const key = state.config && state.config.turnstile_sitekey;
  if (!key || !el) return null;
  await loadScript("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  return turnstile.render(el, {
    sitekey: key, theme: "dark", action: "signup",
    callback: (t) => onToken(t), "expired-callback": () => onToken(""), "error-callback": () => onToken(""),
  });
}

/* ---------- auth window ---------- */

async function finishAuth(user, { created = false, reason = "" } = {}) {
  state.me = user;
  prefetched.clear();
  closeModal();
  await applyPendingRating();
  if (created && reason !== "rate") toast(`Welcome, ${user.username}! Search an album to start rating.`);
  if (session) { session.stale = true; renderTopbar(); } else render();
}

function openAuth(mode = "join", reason = "") {
  const join = mode === "join";
  const cfg = state.config || {};
  const lede = reason === "rate"
    ? "Your rating is ready to save. Create a free account to keep it, and every rating after it."
    : join ? "Rate every track you love (and the ones you don't). Your taste profile builds itself." : "Good to have you back.";
  const m = openModal(`
    <h2>${join ? "Create your account" : "Log in"}</h2>
    <p class="lede">${lede}</p>
    ${join ? `<ul class="perks"><li>Rate albums song by song, in half-stars</li><li>Get your Taste DNA: genres, habits, all-time favorites</li><li>See how closely your taste matches every listener</li></ul>` : ""}
    ${cfg.google_client_id ? `<div class="alt-auth"><div id="g-btn" class="g-btn"></div><div class="or"><span>or with a username</span></div></div>` : ""}
    <form id="auth-form" novalidate>
      <div class="field"><label for="au-user">Username</label>
        <input id="au-user" name="username" autocomplete="username" required maxlength="24" spellcheck="false">
        ${join ? `<span class="hint">3–24 characters: letters, numbers, dots, underscores.</span>` : ""}</div>
      <div class="field"><label for="au-pass">Password</label>
        <input id="au-pass" name="password" type="password" autocomplete="${join ? "new-password" : "current-password"}" required minlength="${join ? 8 : 1}">
        ${join ? `<span class="hint">At least 8 characters.</span>` : ""}</div>
      ${join && cfg.turnstile_sitekey ? `<div class="ts-box" id="ts-box"></div>` : ""}
      <div class="form-error" id="au-err" role="alert"></div>
      <button class="btn btn-gold btn-lg btn-block" type="submit">${join ? "Create my account" : "Log in"}</button>
    </form>
    <div class="switch">${join ? `Already have an account? <button data-switch="login">Log in</button>` : `New here? <button data-switch="join">Create an account</button>`}</div>
  `, { onClose: () => sessionStorage.removeItem("pendingRating") });

  const err = $("#au-err", m);
  $("[data-switch]", m).addEventListener("click", (e) => openAuth(e.target.dataset.switch, reason));

  let captcha = "", widget = null;
  if (join) mountTurnstile($("#ts-box", m), (t) => { captcha = t; }).then((w) => { widget = w; })
    .catch(() => { err.textContent = "The robot check couldn't load. Check your connection or try another browser."; });

  mountGoogleButton($("#g-btn", m), (credential) => googleSignIn(credential, reason));

  $("#auth-form", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $("button[type=submit]", f);
    err.textContent = "";
    const name = f.username.value.trim(), pass = f.password.value;
    if (!name || !pass) {
      err.textContent = !name && !pass ? "Enter a username and password." : !name ? "Enter your username." : "Enter your password.";
      (!name ? f.username : f.password).focus();
      return;
    }
    if (join && !/^[A-Za-z0-9._]{3,24}$/.test(name)) {
      err.textContent = "Usernames are 3–24 characters: letters, numbers, dots and underscores.";
      f.username.focus();
      return;
    }
    if (join && pass.length < 8) {
      err.textContent = "Use at least 8 characters for the password.";
      f.password.focus();
      return;
    }
    if (join && cfg.turnstile_sitekey && !captcha) {
      err.textContent = "Please complete the “I'm not a robot” check first.";
      return;
    }
    btn.disabled = true;
    try {
      const body = { username: name, password: pass };
      if (join) body.captcha = captcha;
      const { user } = await api("POST", join ? "/api/auth/register" : "/api/auth/login", body);
      await finishAuth(user, { created: join, reason });
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      // A Turnstile token is single-use: get a fresh one for the next attempt.
      if (join && widget != null && window.turnstile) { captcha = ""; turnstile.reset(widget); }
    }
  });
}

async function googleSignIn(credential, reason, username) {
  try {
    const res = await api("POST", "/api/auth/google", username ? { credential, username } : { credential });
    if (res.user) return finishAuth(res.user, { created: !!username, reason });
    if (res.needs_username) return pickUsername(credential, reason, res.suggestion);
  } catch (ex) {
    if (username) throw ex; // shown inside the username step
    const box = $("#au-err");
    if (box) box.textContent = ex.message; else toast(ex.message, true);
  }
}

// First Google sign-in: choose the public username people will see.
function pickUsername(credential, reason, suggestion) {
  const m = openModal(`
    <h2>Pick a username</h2>
    <p class="lede">This is the name other listeners see. Your Google email stays private.</p>
    <form id="pick-form" novalidate>
      <div class="field"><label for="pk-user">Username</label>
        <input id="pk-user" name="username" required maxlength="24" spellcheck="false" value="${esc(suggestion || "")}">
        <span class="hint">3–24 characters: letters, numbers, dots, underscores.</span></div>
      <div class="form-error" id="pk-err" role="alert"></div>
      <button class="btn btn-gold btn-lg btn-block" type="submit">Create my account</button>
    </form>`, { onClose: () => sessionStorage.removeItem("pendingRating") });
  $("#pick-form", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true;
    $("#pk-err", m).textContent = "";
    try {
      await googleSignIn(credential, reason, e.target.username.value.trim());
    } catch (ex) {
      $("#pk-err", m).textContent = ex.status === 401
        ? "That Google sign-in expired. Close this and choose “Continue with Google” again."
        : ex.message;
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
    ${hideSearch ? '<div class="grow"></div>' : `<form class="nav-search" role="search" id="nav-search">${ICON.search}
      <input name="q" placeholder="Search albums or artists…" aria-label="Search albums or artists" autocomplete="off"></form>`}
    <nav class="nav-links">
      <a class="nav-link hide-sm ${route.name === "people" ? "active" : ""}" href="#/people">People</a>
      ${me
        ? `<a class="nav-me" href="#/u/${encodeURIComponent(me.username)}">${avatarHTML(me.username)}<span class="name">${esc(me.username)}</span></a>`
        : `<button class="nav-link nav-btn" data-auth="login">Log in</button>
           <button class="btn btn-gold btn-sm" data-auth="join">Join free</button>`}
    </nav></div>`;
  const form = $("#nav-search");
  if (form) attachTypeahead(form);
  $$("[data-auth]", $("#topbar")).forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
  renderTabbar(route);
}

// Phones: the four places you go, always one thumb away.
function renderTabbar(route) {
  const me = state.me;
  const mine = me && route.name === "user" && route.id === me.username;
  const tab = (href, icon, label, on) => `<a href="${href}" class="${on ? "on" : ""}"${on ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  $("#tabbar").innerHTML = tab("#/", ICON.home, "Home", route.name === "home")
    + tab("#/search", ICON.search, "Search", route.name === "search")
    + tab("#/people", ICON.people, "People", route.name === "people")
    + (me ? tab(`#/u/${encodeURIComponent(me.username)}`, ICON.user, "Me", mine) : tab("#/login", ICON.user, "Log in", false));
}

const TITLES = { home: "Crescendo: rate every song", search: "Search · Crescendo", people: "People · Crescendo" };

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
          ${a.avg ? `<span class="ta-score" aria-label="Average ${fmt(a.avg)} of 5">${fmt(a.avg)}</span>` : ""}</a>`).join("")}` : ""}
      ${artists.length ? `<div class="ta-label">Artists</div>${artists.map((a) => `<a class="ta-item" data-ta-item href="#/artist/${a.id}" role="option">
          ${avatarHTML(a.name)}<span class="ta-text"><b>${esc(a.name)}</b><span>${esc([a.type, a.country, a.disambiguation].filter(Boolean).join(" · "))}</span></span></a>`).join("")}` : ""}
      ${!albums.length && !artists.length && !pending ? `<div class="ta-empty">No matches for “${esc(q)}”.</div>` : ""}
      ${pending ? `<div class="ta-status"><span class="eq eq-sm"><span></span><span></span><span></span></span>Searching MusicBrainz…</div>` : ""}
      <a class="ta-all" data-ta-item href="#/search?q=${encodeURIComponent(q)}" role="option">See all results for “${esc(q)}”</a>`;
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
  // pages that know their subject (album, artist, profile) replace this once loaded
  const q = route.name === "search" && route.params.get("q");
  document.title = q ? `${q} · Search · Crescendo` : TITLES[route.name] || "Crescendo";
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

function heroSearchHTML(placeholder = "Search any album or artist") {
  return `<form class="hero-search" id="hero-search" role="search">${ICON.search}
    <input name="q" placeholder="${esc(placeholder)}" aria-label="Search albums or artists" autocomplete="off">
    <button class="btn btn-gold" type="submit">Search</button></form>`;
}

// The shop window: six real records from the shelf, each wearing its community score.
function binHTML(data) {
  if (!data) return `<div class="bin" aria-hidden="true">${'<div class="cover"></div>'.repeat(6)}</div>`;
  const seen = new Set(), records = [];
  for (const a of [...data.trending, ...data.top_rated]) {
    if (!seen.has(a.id) && records.length < 6) { seen.add(a.id); records.push(a); }
  }
  if (records.length < 3) return "";
  return `<div><div class="bin">${records.map((a) => `<a href="#/album/${a.id}" aria-label="${esc(a.title)} by ${esc(a.artist)}${a.avg ? `, average ${fmt(a.avg)} of 5` : ""}">
      ${coverHTML(a.id, a.title, 250, "", stickerHTML(a.avg))}</a>`).join("")}</div>
    <p class="bin-caption">On the shelf right now: what listeners are rating on Crescendo, with their average scores.</p></div>`;
}

function landingHTML(data) {
  return `
  <section class="hero"><div class="wrap hero-grid">
    <div>
      <h1>Every song<br>gets a score.</h1>
      <p class="hero-sub">Search any album, give each track its own rating in half-stars, and Crescendo turns your ratings into a profile of your taste.</p>
      ${heroSearchHTML()}
      <div class="hero-try"><span>Try</span>
        ${["Blonde", "Kid A", "Rumours", "To Pimp a Butterfly"].map((t) => `<button type="button" data-try="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>
    </div>
    ${binHTML(data)}
  </div></section>

  ${data && data.recent.length ? `<section class="section"><div class="wrap two-col">
    <div><div class="section-head"><h2>Fresh ratings</h2></div><div class="feed">${data.recent.slice(0, 6).map(feedItem).join("")}</div></div>
    <div>${data.top_rated.length ? `<div class="section-head"><h2>Highest rated</h2></div>
      <div class="album-grid album-grid-2">${data.top_rated.slice(0, 4).map((a) => albumCard(a)).join("")}</div>` : ""}</div>
  </div></section>` : ""}

  <section class="section"><div class="wrap"><div class="cta-final">
    <div><h2>Start with a record<br>you know by heart.</h2>
    <p>Free, no ads, and nothing deciding what you should like.</p></div>
    <button class="btn btn-gold btn-lg" data-auth="join">Create a free account</button>
  </div></div></section>`;
}

function welcomeHTML(d) {
  const me = state.me;
  const c = d.my_counts || {};
  const fresh = !c.songs && !c.albums;
  const profile = `#/u/${encodeURIComponent(me.username)}`;
  return `
  <section class="welcome page-top"><div class="wrap">
    <h1>${fresh ? `Let's rate your first album, ${esc(me.username)}.` : `What are we rating today, ${esc(me.username)}?`}</h1>
    ${heroSearchHTML("Search an album to rate")}
    ${fresh ? "" : `<p class="my-stats"><span><b>${num(c.songs)}</b> songs</span><span><b>${num(c.albums)}</b> albums</span><span><b>${num(c.artists)}</b> artists rated</span>
      <a href="${profile}">See my Taste DNA</a></p>`}
  </div></section>

  ${d.in_progress && d.in_progress.length ? `<section class="section section-tight"><div class="wrap">
    <div class="section-head"><h2>Continue rating</h2></div>
    <div class="progress-grid">${d.in_progress.map(progressCard).join("")}</div>
  </div></section>` : ""}

  ${d.trending.length ? `<section class="section"><div class="wrap">
    <div class="section-head"><h2>Hot on Crescendo</h2></div>
    <div class="scroller">${d.trending.map((a) => albumCard(a)).join("")}</div>
  </div></section>` : `<section class="section"><div class="wrap"><div class="empty-state">Nothing trending yet. Your ratings could start it.</div></div></section>`}

  <section class="section section-flush"><div class="wrap two-col">
    <div>
      <div class="section-head"><h2>From people you follow</h2></div>
      ${d.following_feed && d.following_feed.length ? `<div class="feed">${d.following_feed.map(feedItem).join("")}</div>`
        : `<div class="empty-state">You're not following anyone yet.<br><a class="btn btn-ghost btn-sm" href="#/people">Find listeners like you</a></div>`}
    </div>
    <div>
      <div class="section-head"><h2>Everyone</h2></div>
      <div class="feed">${d.recent.slice(0, 10).map(feedItem).join("") || '<div class="empty-state">No ratings yet.</div>'}</div>
    </div>
  </div></section>`;
}

function progressCard(p) {
  return `<a class="card progress-card" href="#/album/${p.id}">${coverHTML(p.id, p.title)}
    <div class="min0"><div class="t">${esc(p.title)}</div><div class="sub">${esc(p.artist)} · ${p.rated} of ${p.total} tracks</div>
    <div class="progress-bar"><span style="width:${(p.rated / Math.max(1, p.total)) * 100}%"></span></div></div></a>`;
}

/* ---------- search ---------- */

VIEWS.search = async (view, route, alive) => {
  const q = route.params.get("q") || "";
  const type = route.params.get("type") === "artist" ? "artist" : "album";
  view.innerHTML = `<div class="wrap"><div class="search-head">
      <h1>Search</h1>
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
    if (term) document.title = `${term} · Search · Crescendo`;
    const results = $("#results", view), status = $("#search-status", view);
    if (term.length < 2) {
      status.innerHTML = "";
      results.innerHTML = `<div class="empty-state">Type an album or artist name to search MusicBrainz.</div>`;
      document.title = TITLES.search;
      return;
    }
    // Both requests start now: MusicBrainz is the slow one, so it shouldn't wait for the local answer.
    const remote = api("GET", `/api/search?q=${encodeURIComponent(term)}&type=${type}`, null, controller.signal);
    remote.catch(() => {}); // handled below; avoids an "unhandled rejection" if we bail out early
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
      const data = await remote;
      if (my !== seq || !alive()) return;
      status.innerHTML = "";
      if (type === "album" && data.artist) results.innerHTML = artistAndAlbumsHTML(data);
      else results.innerHTML = data.results.length ? renderResults(data.results)
        : `<div class="empty-state">No ${type}s found for “${esc(term)}”. Try fewer words or check the spelling.</div>`;
    } catch (err) {
      if (err.name === "AbortError" || my !== seq) return;
      status.innerHTML = `<span class="err-text">${esc(err.message)}</span> <button class="btn btn-quiet btn-sm" data-retry>Retry</button>`;
      $("[data-retry]", status).addEventListener("click", () => runSearch(term));
    }
  }

  function renderResults(list) {
    if (type === "artist") {
      return `<div class="artist-grid">${list.map((a) => `<a class="card artist-result" href="#/artist/${a.id}">
        ${avatarHTML(a.name)}<div class="min0"><b>${esc(a.name)}</b>
        <div class="sub">${esc([a.type, a.country, a.begin && "since " + a.begin].filter(Boolean).join(" · "))}</div>
        ${a.disambiguation ? `<div class="sub">${esc(a.disambiguation)}</div>` : ""}</div></a>`).join("")}</div>`;
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
    const artistBlock = `<section class="sr-artist">
      <a class="sr-artist-head" href="#/artist/${ar.id}">
        ${avatarHTML(ar.name, "avatar-md")}
        <div class="min0"><h2>${esc(ar.name)}</h2>${meta ? `<div class="muted">${esc(meta)}</div>` : ""}</div>
        <span class="btn btn-ghost btn-sm">Artist page</span>
      </a>
      ${studio.length ? `<h3 class="sr-sub">Albums <span class="muted">${studio.length}</span></h3>${grid(studio)}` : ""}
      ${eps.length ? `<h3 class="sr-sub">EPs <span class="muted">${eps.length}</span></h3>${grid(eps)}` : ""}
    </section>`;
    const others = data.results.length ? `<section class="sr-others">
      <div class="section-head"><h2>${data.albums_first ? "Best matches" : "Other results"}</h2></div>
      ${renderResults(data.results)}</section>` : "";
    return data.albums_first ? others + artistBlock : artistBlock + others;
  }

  function skeletonGrid() {
    return type === "artist"
      ? `<div class="artist-grid">${'<div class="skeleton sk-artist"></div>'.repeat(6)}</div>`
      : `<div class="album-grid">${'<div><div class="skeleton sk-cover"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line short"></div></div>'.repeat(12)}</div>`;
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
  document.title = `${a.title} by ${a.artist} · Crescendo`;

  const discs = new Set(d.tracks.map((t) => t.disc)).size;
  let lastDisc = null;
  const trackRows = d.tracks.map((t, i) => {
    let head = "";
    if (discs > 1 && t.disc !== lastDisc) head = `<div class="disc-label">Disc ${t.disc}</div>`;
    lastDisc = t.disc;
    return head + `<div class="track ${t.my ? "rated" : ""}" data-track="${t.id}">
      <span class="n">${t.position}</span>
      <div class="min0"><div class="title">${esc(t.title)}</div>${t.artist_credit ? `<div class="credit">${esc(t.artist_credit)}</div>` : ""}</div>
      <span class="len">${fmtLen(t.length_ms)}</span>
      <div class="comm" data-comm="song:${t.id}">${commHTML(t.avg, t.count)}</div>
      <div class="mine">${ratingLine("song", t.id, t.my, { album: a.id, label: `Rate ${t.title}` })}</div>
    </div>`;
  }).join("");

  const meta = [a.type || "Release", ...(a.secondary || []), a.year].filter(Boolean).join(" · ");
  view.innerHTML = `
  <div class="page-top">
    <div class="wrap album-hero">
      ${coverHTML(a.id, a.title, 500)}
      <div class="min0">
        <h1>${esc(a.title)}</h1>
        <div class="by">by ${a.artist_id ? `<a href="#/artist/${a.artist_id}">${esc(a.artist)}</a>` : esc(a.artist)} <span class="muted">· ${esc(meta)}</span></div>
        ${a.genres.length ? `<div class="chips chips-gap">${a.genres.slice(0, 6).map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>` : ""}
        <div class="score-panel">
          <div class="card score-box"><div class="lbl">Crescendo average</div><div data-comm="album:${a.id}" data-style="big">${commHTML(d.stats.avg, d.stats.count, "big")}</div></div>
          <div class="card score-box"><div class="lbl">Your album rating</div>
            <div>${ratingLine("album", a.id, d.mine && d.mine.score, { size: "lg", label: `Rate the album ${a.title}` })}</div>
            <div class="sub" id="track-avg-hint"></div>
          </div>
        </div>
        <div class="actions">
          ${d.tracks.length ? `<button class="btn btn-gold btn-lg" id="start-session">${ICON.play} Rate track by track</button>` : ""}
          <button class="btn btn-ghost btn-lg ${d.mine && d.mine.listen_later ? "on" : ""}" id="listen-later">${ICON.bookmark} <span>${d.mine && d.mine.listen_later ? "In Listen Later" : "Listen later"}</span></button>
        </div>
      </div>
    </div>
  </div>

  <section class="wrap">
    <div id="album-progress"></div>
    ${d.tracks.length ? `<div class="tracklist">
      <div class="track track-head"><span class="n">#</span><span>Title</span><span>Length</span><span>Community</span><span>Your rating</span></div>
      ${trackRows}</div>` : `<div class="empty-state">MusicBrainz doesn't have a tracklist for this release yet. You can still rate the album as a whole.</div>`}
  </section>

  <section class="wrap section two-col">
    <div>
      <div class="section-head"><h2>What listeners say</h2></div>
      <div id="reviews">${reviewsHTML(d.reviews)}</div>
    </div>
    <div>
      <div class="section-head"><h2>Write a review</h2></div>
      <div class="card review-box">
        <textarea id="review-text" maxlength="2000" placeholder="${state.me ? "What makes this album work (or not)?" : "Log in to write a review."}">${esc(d.mine ? d.mine.review : "")}</textarea>
        <div class="review-foot">
          <span class="sub">Saved with your album rating.</span>
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
    $("#track-avg-hint").textContent = avg ? `Your track average: ${fmt(avg)}` : "";
    const box = $("#album-progress");
    if (!state.me || !total) { box.innerHTML = ""; return; }
    box.innerHTML = rated.length === total
      ? `<div class="card album-progress"><span class="done-mark">${ICON.check}</span><span><b>Album complete.</b> You rated all ${total} tracks, average ${fmt(avg)}.</span></div>`
      : `<div class="card album-progress"><span class="nowrap"><b>${rated.length}</b> of ${total} rated</span><div class="progress-bar"><span style="width:${(rated.length / total) * 100}%"></span></div>
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
    <div><a href="#/u/${encodeURIComponent(r.username)}"><b>${esc(r.username)}</b></a><div class="sub">${timeAgo(r.updated_at)}</div></div>
    <div class="push-right rating-line">${starsHTML(r.score, { size: "sm" })}<span class="score-num">${fmt(r.score)}</span></div></div><p>${esc(r.review)}</p></div>`).join("");
}

/* ---------- track-by-track session ----------
   Picking a score slaps its sticker on straight away and holds it for a beat (HOLD_MS) before moving to the
   next track, so you always see what you gave. Changing a score you had already given offers an undo. */

let session = null;
const HOLD_MS = 450;

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
  el.innerHTML = `<div class="session-top">
      <div class="session-album">${coverHTML(a.id, a.title)}<div><b>${esc(a.title)}</b><span>${esc(a.artist)}</span></div></div>
      <button class="icon-btn" data-exit aria-label="Close">${ICON.x}</button>
    </div>
    <div class="session-body" id="session-body"></div>
    <div class="session-dots" id="session-dots"></div>
    <div class="session-keys"><kbd>1</kbd> to <kbd>5</kbd> rate · <kbd>Shift</kbd> + number adds a half star · arrow keys move · <kbd>Esc</kbd> close</div>`;
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

function sessionScoreHTML(v, slap = false) {
  return v
    ? `<span class="sticker-inline ${slap ? "slap" : ""}">${fmt(v)}</span><span class="sr-only"> out of 5</span>`
    : "Tap a star, or press 1 to 5";
}

function renderSession() {
  const { model, idx, el } = session;
  const tracks = model.tracks;
  $("#session-dots", el).innerHTML = tracks.map((t, i) =>
    `<button class="${t.my ? "done" : ""} ${!session.final && i === idx ? "cur" : ""}" data-go="${i}" aria-label="Track ${i + 1}: ${esc(t.title)}${t.my ? ", rated " + fmt(t.my) : ""}"></button>`).join("")
    + `<button class="final ${session.final ? "cur" : ""}" data-go="final" aria-label="Album rating"></button>`;
  $$("[data-go]", el).forEach((b) => b.addEventListener("click", () => {
    clearTimeout(session.advanceTimer);
    if (b.dataset.go === "final") { session.final = true; } else { session.final = false; session.idx = Number(b.dataset.go); }
    renderSession();
  }));
  const body = $("#session-body", el);
  body.classList.toggle("session-final", session.final);
  if (session.final) return renderSessionFinal(body);

  const t = tracks[idx];
  body.innerHTML = `
    <div class="session-count">Track ${idx + 1} of ${tracks.length}</div>
    <h2 class="session-title">${esc(t.title)}</h2>
    <div class="session-meta">${[fmtLen(t.length_ms), t.artist_credit, t.count ? `community average ${fmt(t.avg)} from ${plural(t.count, "rating")}` : "no community ratings yet"].filter(Boolean).map(esc).join(" · ")}</div>
    <div>${starsHTML(t.my, { kind: "song", id: t.id, album: model.album.id, size: "xl", label: `Rate ${t.title}` })}</div>
    <div class="session-score ${t.my ? "" : "empty"}" id="session-score" aria-live="polite">${sessionScoreHTML(t.my)}</div>
    <div class="session-nav">
      <button class="btn btn-ghost" data-prev ${idx === 0 ? "disabled" : ""}>${ICON.left} Previous</button>
      <button class="btn btn-quiet" data-next>${t.my ? "Next" : "Skip"} ${ICON.right}</button>
    </div>`;
  wireStars($(".stars", body), (v) => sessionRate(v));
  if (!el.contains(document.activeElement) || document.activeElement.closest("#session-body")) el.focus({ preventScroll: true });
  $("[data-prev]", body).addEventListener("click", () => sessionMove(-1));
  $("[data-next]", body).addEventListener("click", () => sessionMove(1));
}

async function sessionRate(v, { advance = true, quiet = false } = {}) {
  if (!session || session.final) return;
  const idx = session.idx;
  const t = session.model.tracks[idx];
  const before = t.my || null;
  const albumId = session.model.album.id;
  if (v === before) { if (v && advance) sessionMove(1); return; }
  const el = $(".stars", session.el);
  // show it now: the sticker goes on before the server answers
  const scoreEl = $("#session-score", session.el);
  if (scoreEl) { scoreEl.classList.toggle("empty", !v); scoreEl.innerHTML = sessionScoreHTML(v, true); }
  clearTimeout(session.advanceTimer);
  if (v && advance) session.advanceTimer = setTimeout(() => sessionMove(1), HOLD_MS);
  const ok = await rate("song", t.id, albumId, v, el);
  if (!session) return;
  if (!ok) {
    clearTimeout(session.advanceTimer);
    if (session.idx === idx && !session.final) renderSession();
    return;
  }
  t.my = v;
  const dot = $$("#session-dots button", session.el)[idx];
  if (dot) dot.classList.toggle("done", !!v);
  if (before && !quiet) {
    toast(`${t.title}: changed from ${fmt(before)} to ${v ? fmt(v) : "no rating"}`, false, {
      label: "Undo",
      onClick: async () => {
        if (await rate("song", t.id, albumId, before, null)) {
          t.my = before;
          if (session && session.idx === idx && !session.final) renderSession();
          else if (session) renderSessionDots();
        }
      },
    });
  }
}

function renderSessionDots() {
  if (!session) return;
  session.model.tracks.forEach((t, i) => {
    const dot = $$("#session-dots button", session.el)[i];
    if (dot) dot.classList.toggle("done", !!t.my);
  });
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
  body.innerHTML = `
    <div class="session-count">${rated.length === model.tracks.length ? "Album complete" : `${rated.length} of ${model.tracks.length} tracks rated`}</div>
    <h2 class="session-title">Now the album as a whole</h2>
    <div class="suggest">${avg ? `Your track average is <b>${fmt(avg)}</b>${best ? ` · favorite: <b>${esc(best.title)}</b>` : ""}` : "You skipped every track. You can still rate the album."}</div>
    <div>${starsHTML(suggestion, { size: "xl", label: "Album rating", interactive: true })}</div>
    <div class="session-score ${suggestion ? "" : "empty"}" id="final-score" aria-live="polite">${suggestion ? sessionScoreHTML(suggestion) : "Pick a score"}</div>
    <textarea id="final-review" maxlength="2000" aria-label="Review (optional)" placeholder="Add a short review (optional)">${esc(state.reviews[`album:${model.album.id}`] || "")}</textarea>
    <div class="session-nav">
      <button class="btn btn-ghost" data-back>${ICON.left} Back to tracks</button>
      <button class="btn btn-gold btn-lg" data-save>Save album rating</button>
    </div>`;
  const stars = $(".stars", body);
  wireStars(stars, (v) => {
    session.albumScore = v;
    setStarsValue(stars, v);
    const s = $("#final-score", body);
    s.innerHTML = v ? sessionScoreHTML(v, true) : "Pick a score";
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
      const me = state.me.username;
      body.innerHTML = `<div class="session-count">Saved</div>
        <div class="session-score"><span class="sticker-inline slap">${fmt(session.albumScore)}</span></div>
        <h2 class="session-title">That's a wrap</h2>
        <div class="suggest">${esc(model.album.title)} is now part of your Taste DNA.</div>
        <div class="session-nav">
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
  const years = ar.begin ? `${ar.begin}${ar.end ? "–" + ar.end : "–present"}` : null;
  const section = (title, list, limit = Infinity) => list.length ? `<section class="section section-tight">
      <div class="section-head"><h2>${title}</h2><span class="muted">${list.length}</span></div>
      <div class="album-grid">${list.map((a, i) => albumCard({ ...a, artist: null }).replace("<a ", i >= limit ? "<a hidden " : "<a ")).join("")}</div>
      ${list.length > limit ? `<div class="center-row"><button class="btn btn-ghost" data-show-all>Show all ${list.length}</button></div>` : ""}</section>` : "";

  view.innerHTML = `
  <div class="page-top">
    <div class="wrap artist-hero">
      <h1>${esc(ar.name)}</h1>
      <div class="meta-line">${[ar.type, ar.country, years, ar.disambiguation].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</div>
      ${ar.genres.length ? `<div class="chips chips-gap">${ar.genres.slice(0, 6).map((g) => `<span class="chip">${esc(g)}</span>`).join("")}</div>` : ""}
      <div class="score-panel">
        <div class="card score-box"><div class="lbl">Crescendo average</div><div data-comm="artist:${ar.id}" data-style="big">${commHTML(d.stats.avg, d.stats.count, "big")}</div></div>
        <div class="card score-box"><div class="lbl">Your rating of this artist</div><div>${ratingLine("artist", ar.id, d.mine && d.mine.score, { size: "lg", label: `Rate ${ar.name}` })}</div></div>
      </div>
    </div>
  </div>
  <div class="wrap">
    ${d.top_songs.length ? `<section class="section"><div class="section-head"><h2>Top-rated songs</h2></div>
      <div class="song-list">${d.top_songs.map((s, i) => `<a class="song-row" href="#/album/${s.album_id}"><span class="i">${i + 1}</span>
        <div class="min0"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.album_title)}</div></div>
        <span class="rating-line">${starsHTML(Math.round(s.avg), { size: "sm" })}<span class="score-num">${fmt(s.avg)}</span><span class="sub">(${s.count})</span></span></a>`).join("")}</div></section>` : ""}
    ${section("Albums", studio)}
    ${section("EPs", eps)}
    <section class="section section-tight" id="other-releases">
      <div class="section-head"><h2>Live, compilations &amp; more</h2></div>
      <button class="btn btn-ghost" data-load-other>Show live albums, compilations &amp; more</button>
    </section>
    ${!d.albums.length ? `<div class="empty-state">MusicBrainz lists no albums or EPs for this artist.</div>` : ""}
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
      box.outerHTML = section("Live, compilations & more", more.albums, 12)
        || `<section class="section section-tight"><div class="empty-state">No live albums or compilations listed.</div></section>`;
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
    if (c.avg >= 7.6) verdict = `Generous ear: ${Math.round(highShare * 100)}% of song ratings are 4 stars or higher`;
    else if (c.avg <= 5.2) verdict = `Tough critic: ${Math.round(lowShare * 100)}% of song ratings are 2 stars or lower`;
    else verdict = `Balanced listener: most often rates songs ${fmt(mode)}`;
  }
  const gsum = d.genres.reduce((s, g) => s + g.weight, 0) || 1;
  const me = d.is_me;
  const empty = !c.songs && !c.albums && !c.artists;

  view.innerHTML = `<div class="page-top">
  <div class="wrap profile-hero">
    ${avatarHTML(u.username, "avatar-lg")}
    <div class="min0">
      <h1>${esc(u.username)}</h1>
      <div class="sub">Listener since ${new Date(u.joined * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>
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
      ${me ? `<button class="btn btn-ghost btn-sm" id="edit-bio">Edit bio</button><button class="btn btn-ghost btn-sm" id="account">Account</button><button class="btn btn-quiet btn-sm" id="logout">Log out</button>`
        : d.match ? `<div class="ring ring-lg"><span>${d.match.percent}%<small>taste match</small></span></div>
          <div class="why">${d.match.shared_genres.length ? "You both love " + d.match.shared_genres.slice(0, 3).map(esc).join(", ") : "Rate more to sharpen this"}${d.match.common ? ` · ${plural(d.match.common, "rating")} in common` : ""}</div>`
        : !state.me ? `<button class="btn btn-ghost btn-sm" data-auth="join">See your match %</button>` : ""}
      ${!me && state.me ? `<button class="btn ${d.following ? "btn-ghost on" : "btn-gold"} btn-sm" id="follow">${d.following ? "Following" : "Follow"}</button>` : ""}
    </div>
  </div></div>

  <div class="wrap">
    ${empty ? `<div class="empty-state">${me ? `Your Taste DNA appears once you start rating.<br><a class="btn btn-gold" href="#/search">Rate your first album</a>` : "No ratings yet."}</div>` : `
    <section class="section section-tight">
      <div class="section-head"><h2>${me ? "What your ears are into" : `What ${esc(u.username)} is into`}</h2></div>
      <div class="dna">
        <div class="card"><h3>Genre fingerprint</h3><p class="sub">Share of taste by genre, weighted toward what's rated highest.</p>
          ${d.genres.length ? d.genres.map((g, i) => `<div class="gbar" data-tip="<b>${esc(g.name)}</b> · ${Math.round((g.weight / gsum) * 100)}% of taste">
            <span class="name">${esc(g.name)}</span><div class="track-bg"><div class="fill" style="width:${g.weight * 100}%;animation-delay:${i * 60}ms"></div></div>
            <span class="pct">${Math.round((g.weight / gsum) * 100)}%</span></div>`).join("") : '<p class="muted">No genre data yet for the rated albums.</p>'}
        </div>
        <div class="card"><h3>Song ratings</h3><p class="sub">How ${plural(totalSongs, "song rating")} are spread across the 5-star scale.</p>
          <div class="histo" role="img" aria-label="Rating distribution: ${d.distribution.map((n, i) => `${fmt(i + 1)} stars ${n}`).join(", ")}">
            ${d.distribution.map((n, i) => `<div class="col ${n ? "" : "zero"}" data-tip="<b>${fmt(i + 1)} stars</b> · ${plural(n, "song")}"><span style="height:${(n / maxBar) * 100}%;animation-delay:${i * 40}ms"></span></div>`).join("")}
          </div>
          <div class="histo-axis">${d.distribution.map((_, i) => `<span>${i % 2 ? (i + 1) / 2 : ""}</span>`).join("")}</div>
          <div class="histo-note"><span>Average <b>${fmt(c.avg)}</b> of 5</span><span>${plural(totalSongs, "song")}</span></div>
          ${verdict ? `<div class="verdict">${verdict}</div>` : ""}
        </div>
      </div>
    </section>

    ${me && d.in_progress.length ? `<section class="section section-tight"><div class="section-head"><h2>Continue rating</h2></div>
      <div class="progress-grid">${d.in_progress.map(progressCard).join("")}</div></section>` : ""}

    ${d.top_albums.length ? `<section class="section section-tight"><div class="section-head"><h2>Top albums</h2></div>
      <div class="album-grid">${d.top_albums.map((a) => albumCard({ ...a, my: a.score }, { stickerMine: true })).join("")}</div></section>` : ""}

    <section class="section section-tight two-col">
      <div>${d.top_songs.length ? `<div class="section-head"><h2>Top songs</h2></div>
        <div class="song-list">${d.top_songs.map((s, i) => `<a class="song-row" href="#/album/${s.album_id}"><span class="i">${i + 1}</span>
          <div class="min0"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.artist)} · ${esc(s.album_title)}</div></div>
          <span class="rating-line">${starsHTML(s.score, { size: "sm" })}</span></a>`).join("")}</div>` : ""}</div>
      <div>${d.top_artists.length ? `<div class="section-head"><h2>Top artists</h2></div>
        <div>${d.top_artists.map((a) => `<a class="artist-row" href="#/artist/${a.id}">${a.cover_album ? coverHTML(a.cover_album, a.name) : avatarHTML(a.name)}
          <div class="min0"><b>${esc(a.name)}</b><div class="sub">${plural(a.n, "rating")}</div></div>
          <span class="rating-line">${starsHTML(Math.round(a.explicit || a.avg), { size: "sm" })}<span class="score-num">${fmt(a.explicit || a.avg)}</span></span></a>`).join("")}</div>` : ""}</div>
    </section>

    ${d.recent.length ? `<section class="section section-tight"><div class="section-head"><h2>Recent activity</h2></div>
      <div class="feed feed-narrow">${d.recent.map(feedItem).join("")}</div></section>` : ""}`}

    ${d.listen_later.length ? `<section class="section section-tight"><div class="section-head"><h2>Listen later</h2></div>
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
  const acct = $("#account", view);
  if (acct) acct.addEventListener("click", openAccount);
  const eb = $("#edit-bio", view);
  if (eb) eb.addEventListener("click", () => {
    const m = openModal(`<h2>Edit bio</h2><p class="lede">A line or two about what you listen to.</p>
      <div class="field"><textarea id="bio-text" class="bio-text" maxlength="280" aria-label="Bio">${esc(u.bio)}</textarea></div>
      <button class="btn btn-gold btn-block" id="bio-save">Save</button>`);
    $("#bio-save", m).addEventListener("click", async () => {
      try { await api("PUT", "/api/me", { bio: $("#bio-text", m).value }); closeModal(); render(); }
      catch (err) { toast(err.message, true); }
    });
  });
};

/* ---------- account settings ---------- */

async function openAccount() {
  let me = state.me;
  try { me = (await api("GET", "/api/me")).user || me; } catch { /* use what we have */ }
  if (!me) return openAuth("login");
  const pw = me.has_password;
  const m = openModal(`
    <h2>Account</h2>
    <p class="lede">Signed in as <b>${esc(me.username)}</b>${me.google ? " · linked to Google" : ""}.</p>

    <form id="pw-form" class="acct-section" novalidate>
      <h3>${pw ? "Change password" : "Set a password"}</h3>
      ${pw ? "" : `<p class="muted">You sign in with Google. A password lets you log in with your username too.</p>`}
      ${pw ? `<div class="field"><label for="pw-cur">Current password</label>
        <input id="pw-cur" name="current" type="password" autocomplete="current-password" required></div>` : ""}
      <div class="field"><label for="pw-new">New password</label>
        <input id="pw-new" name="next" type="password" autocomplete="new-password" required minlength="8">
        <span class="hint">At least 8 characters. Other devices get signed out.</span></div>
      <div class="form-error" id="pw-err" role="alert"></div>
      <button class="btn btn-gold btn-block" type="submit">${pw ? "Change password" : "Set password"}</button>
    </form>

    <div class="acct-section">
      <h3>Sessions</h3>
      <p class="muted">Lost a device or used a shared computer? Sign out of Crescendo everywhere, including here.</p>
      <button class="btn btn-ghost btn-block" id="logout-all">Sign out of all devices</button>
    </div>

    <form id="del-form" class="acct-section danger-zone" novalidate>
      <h3>Delete account</h3>
      <p class="muted">Permanently deletes your account and every rating, review, follow and list. This can't be undone.</p>
      ${pw ? `<div class="field"><label for="del-pw">Password</label>
          <input id="del-pw" name="password" type="password" autocomplete="current-password" required></div>`
        : `<div class="field"><label for="del-confirm">Type <b>${esc(me.username)}</b> to confirm</label>
          <input id="del-confirm" name="confirm" autocomplete="off" spellcheck="false" required></div>`}
      <div class="form-error" id="del-err" role="alert"></div>
      <button class="btn btn-danger btn-block" type="submit">Delete my account</button>
    </form>`);

  $("#pw-form", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = $("button[type=submit]", f);
    btn.disabled = true;
    $("#pw-err", m).textContent = "";
    try {
      const { user } = await api("POST", "/api/me/password",
        { current_password: f.current ? f.current.value : "", new_password: f.next.value });
      state.me = user;
      closeModal();
      toast(pw ? "Password changed. Other devices were signed out." : "Password set.");
    } catch (ex) {
      $("#pw-err", m).textContent = ex.message;
      btn.disabled = false;
    }
  });

  $("#logout-all", m).addEventListener("click", async () => {
    try { await api("POST", "/api/me/logout-all"); } catch (ex) { return toast(ex.message, true); }
    state.me = null;
    closeModal();
    toast("Signed out of every device.");
    location.hash = "#/";
    render();
  });

  $("#del-form", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = $("button[type=submit]", f);
    btn.disabled = true;
    $("#del-err", m).textContent = "";
    try {
      await api("DELETE", "/api/me", pw ? { password: f.password.value } : { confirm: f.confirm.value });
    } catch (ex) {
      $("#del-err", m).textContent = ex.message;
      btn.disabled = false;
      return;
    }
    state.me = null;
    closeModal();
    toast("Your account was deleted.");
    location.hash = "#/";
    render();
  });
}

/* ---------- people ---------- */

VIEWS.people = async (view, route, alive) => {
  view.innerHTML = loadingHTML("Comparing tastes…");
  const d = await api("GET", "/api/people");
  if (!alive()) return;
  document.title = "People · Crescendo";
  view.innerHTML = `<div class="wrap">
    <div class="welcome welcome-people">
      <h1>${state.me ? "People who hear what you hear" : "Meet the listeners"}</h1>
      <p class="dim lede-text">${state.me
        ? "Ranked by how closely their ratings and genre fingerprint line up with yours. The more you rate, the sharper this gets."
        : "Create an account and rate a few albums. Crescendo then ranks everyone here by how closely they match your taste."}</p>
      ${!state.me ? `<div class="actions"><button class="btn btn-gold" data-auth="join">Find my matches</button></div>` : ""}
    </div>
    ${d.people.length ? `<div class="people">${d.people.map((p) => `<a class="card person" href="#/u/${encodeURIComponent(p.username)}">
      ${avatarHTML(p.username)}
      <div class="min0"><div class="n">${esc(p.username)}</div>
        <div class="g">${p.top_genres.length ? p.top_genres.map(esc).join(" · ") : "—"}</div>
        <div class="sub">${plural(p.ratings, "rating")}${p.following ? " · following" : ""}</div></div>
      ${p.match ? `<span class="ring" aria-label="${p.match.percent}% taste match" data-tip="${p.match.percent}% taste match${p.match.common ? " · " + p.match.common + " in common" : ""}">${p.match.percent}%</span>` : ""}
    </a>`).join("")}</div>` : `<div class="empty-state">No other listeners have rated anything yet.</div>`}
  </div>`;
  $$("[data-auth]", view).forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
};

/* ---------- boot ---------- */

(async function boot() {
  const [me, config] = await Promise.allSettled([api("GET", "/api/me"), api("GET", "/api/config")]);
  if (me.status === "fulfilled") state.me = me.value.user;      // offline: render anyway
  if (config.status === "fulfilled") state.config = config.value; // which sign-in options are on
  lastPath = location.hash.split("?")[0];
  render();
})();
