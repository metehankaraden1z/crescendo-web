#!/usr/bin/env python3
"""
Crescendo — a track-by-track music rating app.

Pure Python standard library: http.server + sqlite3 + hashlib.scrypt.
Album, artist and track data comes from the MusicBrainz API and is cached
locally; users, sessions, follows and every rating live in SQLite.

    python3 server.py               # http://localhost:8000
    python3 server.py --port 9000
    python3 server.py --seed-demo   # create a few demo accounts with ratings
"""

import argparse
import hashlib
import hmac
import http.client
import json
import math
import mimetypes
import os
import queue
import random
import re
import secrets
import socket
import sqlite3
import ssl
import threading
import time
import urllib.parse
from collections import defaultdict
from concurrent.futures import Future, ThreadPoolExecutor
from email.utils import formatdate, parsedate_to_datetime
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DB_PATH = os.environ.get("CRESCENDO_DB", os.path.join(ROOT, "data", "crescendo.db"))
SECURE_COOKIES = os.environ.get("CRESCENDO_SECURE") == "1"

MB_HOST = "musicbrainz.org"
MB_BASE = f"https://{MB_HOST}/ws/2/"
# MusicBrainz requires a descriptive User-Agent with contact info.
MB_USER_AGENT = os.environ.get(
    "CRESCENDO_MB_UA", "Crescendo/1.0 ( https://github.com/metehankaraden1z/crescendo-web )"
)
MB_RATE = 1.0   # sustained requests/second (MusicBrainz asks for ~1/s on average)
MB_BURST = 3    # short bursts are tolerated; lets independent lookups overlap
MB_DEBUG = os.environ.get("CRESCENDO_DEBUG_MB") == "1"

SESSION_COOKIE = "cr_session"
SESSION_DAYS = 30
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.]{3,24}$")
MBID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
);

-- Catalog, mirrored from MusicBrainz -------------------------------------
CREATE TABLE IF NOT EXISTS artists (
    mbid          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    sort_name     TEXT,
    type          TEXT,
    country       TEXT,
    disambiguation TEXT,
    begin_year    TEXT,
    end_year      TEXT,
    genres        TEXT NOT NULL DEFAULT '[]',  -- JSON list of names
    details_at    INTEGER                      -- set once the full lookup ran
);

CREATE TABLE IF NOT EXISTS albums (                -- MusicBrainz release groups
    mbid            TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    artist_mbid     TEXT REFERENCES artists(mbid),
    artist_credit   TEXT NOT NULL DEFAULT '',
    year            TEXT,
    primary_type    TEXT,
    secondary_types TEXT NOT NULL DEFAULT '[]',
    release_mbid    TEXT,                          -- release used for the tracklist
    tracks_at       INTEGER                        -- set once the tracklist is stored
);

CREATE TABLE IF NOT EXISTS album_genres (
    album_mbid TEXT NOT NULL REFERENCES albums(mbid) ON DELETE CASCADE,
    genre      TEXT NOT NULL,
    votes      INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (album_mbid, genre)
);

CREATE TABLE IF NOT EXISTS songs (                 -- MusicBrainz recordings
    mbid          TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    length_ms     INTEGER,
    artist_credit TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tracks (
    album_mbid TEXT NOT NULL REFERENCES albums(mbid) ON DELETE CASCADE,
    disc       INTEGER NOT NULL,
    position   INTEGER NOT NULL,
    song_mbid  TEXT NOT NULL REFERENCES songs(mbid),
    PRIMARY KEY (album_mbid, disc, position)
);
CREATE INDEX IF NOT EXISTS tracks_song ON tracks(song_mbid);

-- Ratings: score is 1..10 (half-stars on a 5-star scale) ----------------
CREATE TABLE IF NOT EXISTS song_ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_mbid  TEXT NOT NULL REFERENCES songs(mbid),
    album_mbid TEXT NOT NULL REFERENCES albums(mbid),
    score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_mbid)
);
CREATE INDEX IF NOT EXISTS song_ratings_album ON song_ratings(album_mbid);
CREATE INDEX IF NOT EXISTS song_ratings_time ON song_ratings(updated_at);

CREATE TABLE IF NOT EXISTS album_ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_mbid TEXT NOT NULL REFERENCES albums(mbid),
    score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
    review     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, album_mbid)
);
CREATE INDEX IF NOT EXISTS album_ratings_album ON album_ratings(album_mbid);

CREATE TABLE IF NOT EXISTS artist_ratings (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_mbid TEXT NOT NULL REFERENCES artists(mbid),
    score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
    review      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, artist_mbid)
);
CREATE INDEX IF NOT EXISTS artist_ratings_artist ON artist_ratings(artist_mbid);

CREATE TABLE IF NOT EXISTS listen_later (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_mbid TEXT NOT NULL REFERENCES albums(mbid),
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, album_mbid)
);

CREATE TABLE IF NOT EXISTS mb_cache (
    key        TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
"""

_local = threading.local()


def db():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 15000")
        _local.conn = conn
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = db()
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)


class Tx:
    """`with Tx() as c:` runs a block in one IMMEDIATE transaction."""

    def __enter__(self):
        self.conn = db()
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
        return False


def now():
    return int(time.time())


def rows(sql, params=()):
    return [dict(r) for r in db().execute(sql, params).fetchall()]


def one(sql, params=()):
    r = db().execute(sql, params).fetchone()
    return dict(r) if r else None


# ---------------------------------------------------------------------------
# Passwords & sessions
# ---------------------------------------------------------------------------

def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    try:
        _, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(digest.hex(), digest_hex)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    t = now()
    db().execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        (token_hash(token), user_id, t, t + SESSION_DAYS * 86400),
    )
    return token


_login_failures = defaultdict(list)
_login_lock = threading.Lock()


def too_many_failures(ip):
    cutoff = time.time() - 600
    with _login_lock:
        _login_failures[ip] = [t for t in _login_failures[ip] if t > cutoff]
        return len(_login_failures[ip]) >= 10


def record_failure(ip):
    with _login_lock:
        _login_failures[ip].append(time.time())


# ---------------------------------------------------------------------------
# MusicBrainz client (throttled, retried, cached)
# ---------------------------------------------------------------------------

class MBError(Exception):
    pass


class RateLimiter:
    """Token bucket: MB_RATE requests/second on average, bursts of up to MB_BURST."""

    def __init__(self, rate, burst):
        self.rate, self.burst = rate, burst
        self.tokens = float(burst)
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            with self.lock:
                t = time.monotonic()
                self.tokens = min(self.burst, self.tokens + (t - self.updated) * self.rate)
                self.updated = t
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait = (1 - self.tokens) / self.rate
            time.sleep(wait)


_limiter = RateLimiter(MB_RATE, MB_BURST)
_inflight = {}
_inflight_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mb")


def parallel(*calls):
    """Run (fn, *args) tuples concurrently and return their results in order."""
    futures = [_pool.submit(fn, *args) for fn, *args in calls]
    return [f.result() for f in futures]


_ssl_context = ssl.create_default_context()
_mb_addr = [None]          # the address that last connected fine
_mb_addr_lock = threading.Lock()
_mb_conns = queue.LifoQueue()  # idle keep-alive connections


def _mb_address():
    """Pick a reachable MusicBrainz address once, IPv4 first.

    Some networks resolve IPv6 but can't route it; trying that first costs a full
    connect timeout on every request, so probe briefly and remember what works."""
    with _mb_addr_lock:
        if _mb_addr[0]:
            return _mb_addr[0]
    infos = socket.getaddrinfo(MB_HOST, 443, type=socket.SOCK_STREAM)
    infos.sort(key=lambda info: info[0] != socket.AF_INET)
    last_error = OSError("no address")
    for family, _, _, _, addr in infos:
        try:
            socket.create_connection(addr[:2], timeout=2).close()
        except OSError as e:
            last_error = e
            continue
        with _mb_addr_lock:
            _mb_addr[0] = addr[:2]
        return addr[:2]
    raise last_error


class _MBConnection(http.client.HTTPSConnection):
    def connect(self):
        sock = socket.create_connection(_mb_address(), timeout=self.timeout)
        self.sock = _ssl_context.wrap_socket(sock, server_hostname=MB_HOST)


def _mb_request(url):
    """GET over a pooled keep-alive connection; returns (status, body)."""
    path = url[len(f"https://{MB_HOST}"):]
    headers = {"User-Agent": MB_USER_AGENT, "Accept": "application/json"}
    for fresh in (False, True):
        conn = None
        if not fresh:
            try:
                conn = _mb_conns.get_nowait()
            except queue.Empty:
                fresh = True
        if conn is None:
            conn = _MBConnection(MB_HOST, timeout=10)
        try:
            conn.request("GET", path, headers=headers)
            resp = conn.getresponse()
            body = resp.read()
        except (OSError, http.client.HTTPException):
            conn.close()
            if fresh:
                with _mb_addr_lock:
                    _mb_addr[0] = None  # re-probe next time
                raise
            continue  # an idle pooled connection went stale: retry once on a new one
        if resp.will_close:
            conn.close()
        else:
            _mb_conns.put(conn)
        return resp.status, body.decode("utf-8")


def mb_get(path, params, ttl):
    params = dict(params, fmt="json")
    url = MB_BASE + path + "?" + urllib.parse.urlencode(params)
    cached = one("SELECT body, fetched_at FROM mb_cache WHERE key = ?", (url,))
    if cached and now() - cached["fetched_at"] < ttl:
        return json.loads(cached["body"])

    # If the same URL is already being fetched (e.g. a hover prefetch), wait for that instead.
    with _inflight_lock:
        fut = _inflight.get(url)
        owner = fut is None
        if owner:
            fut = _inflight[url] = Future()
    if not owner:
        return fut.result(timeout=60)
    try:
        data = _mb_fetch(url, cached)
        fut.set_result(data)
        return data
    except BaseException as e:
        fut.set_exception(e)
        raise
    finally:
        with _inflight_lock:
            _inflight.pop(url, None)


def _mb_fetch(url, cached):
    # MusicBrainz sheds load by answering a share of requests with a fast 503 ("server busy").
    # Those rejections are random, so a quick jittered retry almost always gets through.
    last_error = None
    body = None
    started = time.monotonic()
    deadline = started + 12
    _limiter.acquire()
    for attempts in range(1, 11):
        try:
            status, text = _mb_request(url)
        except (OSError, http.client.HTTPException) as e:
            last_error = e
        else:
            if status == 200:
                body = text
                break
            if status == 404:
                raise MBError("not_found")
            if status == 400:
                raise MBError("bad_request")
            last_error = f"HTTP {status}"  # 503 = busy
        if time.monotonic() > deadline:
            break
        time.sleep(0.3 + random.random() * 0.3)
    if MB_DEBUG:
        print(f"[mb] {time.monotonic() - started:5.2f}s attempts={attempts} "
              f"{'ok' if body is not None else 'FAIL ' + str(last_error)} {url[len(MB_BASE):][:110]}", flush=True)
    if body is None:
        if cached:  # stale is better than nothing
            return json.loads(cached["body"])
        raise MBError(f"MusicBrainz is unavailable right now ({last_error}). Try again in a moment.")

    db().execute(
        "INSERT INTO mb_cache (key, body, fetched_at) VALUES (?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
        (url, body, now()),
    )
    return json.loads(body)


def credit_string(credits):
    return "".join(c.get("name", "") + c.get("joinphrase", "") for c in credits or [])


def lucene_escape(text):
    return re.sub(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)', r"\\\1", text)


def year_of(date):
    return (date or "")[:4] or None


def upsert_artist_stub(c, artist):
    c.execute(
        "INSERT INTO artists (mbid, name, sort_name, type, country, disambiguation) VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(mbid) DO UPDATE SET name = excluded.name",
        (artist["id"], artist["name"], artist.get("sort-name"), artist.get("type"),
         artist.get("country"), artist.get("disambiguation")),
    )


def upsert_album_stub(c, rg):
    credits = rg.get("artist-credit") or []
    artist = credits[0]["artist"] if credits else None
    if artist:
        upsert_artist_stub(c, artist)
    c.execute(
        "INSERT INTO albums (mbid, title, artist_mbid, artist_credit, year, primary_type, secondary_types) "
        "VALUES (?,?,?,?,?,?,?) ON CONFLICT(mbid) DO UPDATE SET title = excluded.title, "
        "artist_credit = CASE WHEN excluded.artist_credit <> '' THEN excluded.artist_credit ELSE albums.artist_credit END, "
        "artist_mbid = COALESCE(excluded.artist_mbid, albums.artist_mbid), year = excluded.year, "
        "primary_type = excluded.primary_type, secondary_types = excluded.secondary_types",
        (rg["id"], rg["title"], artist["id"] if artist else None, credit_string(credits),
         year_of(rg.get("first-release-date")), rg.get("primary-type"),
         json.dumps(rg.get("secondary-types") or [])),
    )


PREFERRED_FORMATS = {"CD", "Digital Media", "Enhanced CD", "SHM-CD", "Hybrid SACD"}
PREFERRED_COUNTRIES = {"XW", "US", "GB", "XE"}


def pick_release(releases):
    """Choose the most 'canonical' release of a release group for its tracklist."""
    usable = [r for r in releases if r.get("media") and any(m.get("tracks") for m in r["media"])]
    if not usable:
        return None
    totals = [sum(m.get("track-count", 0) for m in r["media"]) for r in usable]
    counts = defaultdict(int)
    for t in totals:
        counts[t] += 1
    common_total = max(counts, key=lambda t: (counts[t], -t))

    def key(item):
        r, total = item
        formats = {m.get("format") for m in r["media"]}
        return (
            r.get("status") != "Official",
            total != common_total,
            not formats <= PREFERRED_FORMATS,
            r.get("country") not in PREFERRED_COUNTRIES,
            r.get("date") or "9999",
        )

    return min(zip(usable, totals), key=key)[0]


def load_album(rgid, force=False):
    """Make sure the release group and its tracklist are stored locally."""
    album = one("SELECT * FROM albums WHERE mbid = ?", (rgid,))
    if album and album["tracks_at"] and not force:
        return album

    rg, rel = parallel(
        (mb_get, f"release-group/{rgid}", {"inc": "artist-credits genres"}, 30 * 86400),
        (mb_get, "release", {"release-group": rgid, "inc": "recordings artist-credits media",
                             "status": "official", "limit": 25}, 30 * 86400),
    )
    releases = rel.get("releases") or []
    if not releases:  # some groups only have bootleg/promo/etc releases
        rel = mb_get("release", {"release-group": rgid, "inc": "recordings artist-credits media", "limit": 25},
                     ttl=30 * 86400)
        releases = rel.get("releases") or []
    release = pick_release(releases)

    genres = sorted(rg.get("genres") or [], key=lambda g: -g.get("count", 0))[:8]
    with Tx() as c:
        upsert_album_stub(c, rg)
        c.execute("DELETE FROM album_genres WHERE album_mbid = ?", (rgid,))
        for g in genres:
            c.execute("INSERT INTO album_genres (album_mbid, genre, votes) VALUES (?,?,?)",
                      (rgid, g["name"], max(1, g.get("count", 1))))
        if release:
            c.execute("DELETE FROM tracks WHERE album_mbid = ?", (rgid,))
            for disc_no, medium in enumerate(release["media"], start=1):
                for t in medium.get("tracks") or []:
                    rec = t.get("recording") or {}
                    if not rec.get("id"):
                        continue
                    c.execute(
                        "INSERT INTO songs (mbid, title, length_ms, artist_credit) VALUES (?,?,?,?) "
                        "ON CONFLICT(mbid) DO UPDATE SET title = excluded.title, "
                        "length_ms = COALESCE(excluded.length_ms, songs.length_ms), artist_credit = excluded.artist_credit",
                        (rec["id"], t.get("title") or rec.get("title", ""), t.get("length") or rec.get("length"),
                         credit_string(t.get("artist-credit") or rec.get("artist-credit"))),
                    )
                    c.execute("INSERT OR IGNORE INTO tracks (album_mbid, disc, position, song_mbid) VALUES (?,?,?,?)",
                              (rgid, disc_no, t.get("position") or 0, rec["id"]))
        c.execute("UPDATE albums SET release_mbid = ?, tracks_at = ? WHERE mbid = ?",
                  (release["id"] if release else None, now(), rgid))

    album = one("SELECT * FROM albums WHERE mbid = ?", (rgid,))
    if not genres and album["artist_mbid"]:
        # No album-level genres: borrow the artist's (in the background, off the page's critical path).
        _pool.submit(borrow_artist_genres, rgid, album["artist_mbid"])
    return album


def borrow_artist_genres(rgid, artist_mbid):
    try:
        artist = load_artist(artist_mbid)
    except MBError:
        return
    with Tx() as c:
        for g in json.loads(artist["genres"])[:5]:
            c.execute("INSERT OR IGNORE INTO album_genres (album_mbid, genre, votes) VALUES (?,?,1)", (rgid, g))


def load_artist(mbid):
    artist = one("SELECT * FROM artists WHERE mbid = ?", (mbid,))
    if artist and artist["details_at"]:
        return artist
    a = mb_get(f"artist/{mbid}", {"inc": "genres"}, ttl=30 * 86400)
    genres = [g["name"] for g in sorted(a.get("genres") or [], key=lambda g: -g.get("count", 0))[:8]]
    span = a.get("life-span") or {}
    with Tx() as c:
        upsert_artist_stub(c, a)
        c.execute(
            "UPDATE artists SET sort_name=?, type=?, country=?, disambiguation=?, begin_year=?, end_year=?, "
            "genres=?, details_at=? WHERE mbid=?",
            (a.get("sort-name"), a.get("type"), a.get("country"), a.get("disambiguation"),
             year_of(span.get("begin")), year_of(span.get("end")), json.dumps(genres), now(), mbid),
        )
    return one("SELECT * FROM artists WHERE mbid = ?", (mbid,))


def store_album_stubs(groups, fallback_artist):
    with Tx() as c:
        for rg in groups:
            if rg.get("artist-credit"):
                upsert_album_stub(c, rg)
                continue
            c.execute(
                "INSERT INTO albums (mbid, title, artist_mbid, year, primary_type, secondary_types) VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(mbid) DO UPDATE SET title = excluded.title, year = excluded.year, "
                "primary_type = excluded.primary_type, secondary_types = excluded.secondary_types",
                (rg["id"], rg["title"], fallback_artist, year_of(rg.get("first-release-date")), rg.get("primary-type"),
                 json.dumps(rg.get("secondary-types") or [])),
            )


def artist_studio_releases(mbid):
    """Official albums and EPs without secondary types (no live/compilation/bootleg) — one search call."""
    base = f"arid:{mbid} AND (primarytype:album OR primarytype:ep) AND -secondarytype:*"
    data = mb_get("release-group", {"query": base + " AND status:official", "limit": 100}, ttl=7 * 86400)
    groups = data.get("release-groups") or []
    if not groups:  # some artists' releases carry no status at all
        data = mb_get("release-group", {"query": base, "limit": 100}, ttl=7 * 86400)
        groups = data.get("release-groups") or []
    store_album_stubs(groups, mbid)
    return [rg["id"] for rg in groups]


def artist_other_releases(mbid):
    """Live albums, compilations, remixes… — fetched only when the visitor asks for them."""
    first = mb_get("release-group", {"artist": mbid, "type": "album|ep", "limit": 100}, ttl=7 * 86400)
    groups = list(first.get("release-groups") or [])
    total = min(first.get("release-group-count") or 0, 400)
    rest = parallel(*[(mb_get, "release-group", {"artist": mbid, "type": "album|ep", "limit": 100, "offset": off},
                       7 * 86400) for off in range(100, total, 100)])
    for page in rest:
        groups += page.get("release-groups") or []
    groups = [rg for rg in groups if rg.get("secondary-types")]
    store_album_stubs(groups, mbid)
    return [rg["id"] for rg in groups]


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def tokens(text):
    return set(re.findall(r"\w+", (text or "").lower()))


def search_albums(q):
    esc = lucene_escape(q)
    data = mb_get("release-group", {"query": f"releasegroup:({esc})^3 OR artist:({esc}) OR ({esc})", "limit": 30},
                  ttl=86400)
    qt = tokens(q)
    results = []
    for rg in data.get("release-groups") or []:
        credits = rg.get("artist-credit") or []
        title_t, artist_t = tokens(rg["title"]), tokens(credit_string(credits))
        score = rg.get("score", 0)
        if title_t and title_t <= qt:
            score += 25
        if artist_t and artist_t <= qt:
            score += 15
        if title_t and artist_t and (title_t | artist_t) >= qt:
            score += 25
        score += {"Album": 20, "EP": 8}.get(rg.get("primary-type"), 0)
        score += 7 * math.log1p(rg.get("count") or 0)  # many editions ~ well-known record
        if set(rg.get("secondary-types") or []) & {"Compilation", "Live", "Remix", "DJ-mix", "Mixtape/Street"}:
            score -= 12
        results.append((score, rg))
    results.sort(key=lambda x: -x[0])
    out = []
    for _, rg in results[:24]:
        credits = rg.get("artist-credit") or []
        out.append({
            "id": rg["id"], "title": rg["title"], "artist": credit_string(credits),
            "artist_id": credits[0]["artist"]["id"] if credits else None,
            "year": year_of(rg.get("first-release-date")), "type": rg.get("primary-type"),
            "secondary": rg.get("secondary-types") or [], "editions": rg.get("count") or 0,
        })
    return out


def search_artists(q):
    data = mb_get("artist", {"query": lucene_escape(q), "limit": 12}, ttl=86400)
    return [{
        "id": a["id"], "name": a["name"], "type": a.get("type"), "country": a.get("country"),
        "disambiguation": a.get("disambiguation"), "begin": year_of((a.get("life-span") or {}).get("begin")),
        "score": a.get("score", 0), "aliases": [x["name"] for x in a.get("aliases") or [] if x.get("name")],
    } for a in data.get("artists") or []]


# ---------------------------------------------------------------------------
# Taste profiles
# ---------------------------------------------------------------------------

def user_genre_vector(user_id):
    """Genre -> weight, where liked albums (and albums with liked tracks) weigh more."""
    engaged = rows(
        """
        SELECT album_mbid, AVG(score) AS avg FROM (
            SELECT album_mbid, score FROM album_ratings WHERE user_id = ?
            UNION ALL
            SELECT album_mbid, score FROM song_ratings WHERE user_id = ?
        ) GROUP BY album_mbid
        """, (user_id, user_id))
    if not engaged:
        return {}
    weights = {e["album_mbid"]: (e["avg"] / 10.0) ** 2 for e in engaged}
    vec = defaultdict(float)
    marks = ",".join("?" * len(weights))
    for g in rows(f"SELECT album_mbid, genre, votes FROM album_genres WHERE album_mbid IN ({marks})", list(weights)):
        vec[g["genre"]] += weights[g["album_mbid"]] * (1 + math.log(g["votes"]))
    return dict(vec)


def user_scores(user_id):
    out = {}
    for kind, table, col in (("s", "song_ratings", "song_mbid"), ("a", "album_ratings", "album_mbid"),
                             ("r", "artist_ratings", "artist_mbid")):
        for r in rows(f"SELECT {col} AS id, score FROM {table} WHERE user_id = ?", (user_id,)):
            out[kind + r["id"]] = r["score"]
    return out


def taste_match(a_id, b_id, cache=None):
    def get(uid):
        if cache is not None and uid in cache:
            return cache[uid]
        v = (user_genre_vector(uid), user_scores(uid))
        if cache is not None:
            cache[uid] = v
        return v

    (ga, sa), (gb, sb) = get(a_id), get(b_id)
    if not ga or not gb:
        return None
    dot = sum(ga[g] * gb[g] for g in ga.keys() & gb.keys())
    norm = math.sqrt(sum(v * v for v in ga.values())) * math.sqrt(sum(v * v for v in gb.values()))
    genre_sim = dot / norm if norm else 0.0
    common = sa.keys() & sb.keys()
    agreement = sum(1 - abs(sa[k] - sb[k]) / 9 for k in common) / len(common) if common else 0.0
    confidence = min(1.0, len(common) / 12)
    score = genre_sim * (1 - 0.6 * confidence) + agreement * 0.6 * confidence
    shared = sorted(ga.keys() & gb.keys(), key=lambda g: -(ga[g] * gb[g]))[:4]
    return {"percent": round(score * 100), "shared_genres": shared, "common": len(common)}


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

def public_user(u):
    return {"id": u["id"], "username": u["username"], "bio": u.get("bio", ""), "joined": u.get("created_at")}


def album_summary_rows(where_sql, params, order_sql, limit, user_id=None):
    """Albums with community stats (and the viewer's album score when logged in)."""
    my_sql = ("(SELECT score FROM album_ratings WHERE user_id = :uid AND album_mbid = al.mbid)"
              if user_id else "NULL")
    sql = f"""
        SELECT al.mbid AS id, al.title, al.artist_credit AS artist, al.artist_mbid AS artist_id, al.year,
               al.primary_type AS type, al.secondary_types AS secondary,
               (SELECT AVG(score) FROM album_ratings WHERE album_mbid = al.mbid) AS avg,
               (SELECT COUNT(*) FROM album_ratings WHERE album_mbid = al.mbid) AS count,
               (SELECT COUNT(*) FROM song_ratings WHERE album_mbid = al.mbid) AS song_count,
               {my_sql} AS my
        FROM albums al {where_sql} {order_sql} LIMIT {int(limit)}
    """
    p = dict(params)
    if user_id:
        p["uid"] = user_id
    out = rows(sql, p)
    for r in out:
        r["secondary"] = json.loads(r["secondary"] or "[]")
    return out


def albums_by_ids(ids, user_id=None, order_sql="ORDER BY al.year IS NULL, al.year"):
    if not ids:
        return []
    params = {f"i{n}": v for n, v in enumerate(ids)}
    return album_summary_rows(f"WHERE al.mbid IN ({','.join(':' + k for k in params)})", params,
                              order_sql, len(ids), user_id)


def like_terms(q):
    """LIKE patterns (one per word, wildcards escaped) — every word must appear somewhere."""
    words = [w for w in re.findall(r"\w+", q.lower()) if w][:6]
    params = {f"w{n}": "%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
              for n, w in enumerate(words)}
    return params


def recent_activity(where_sql="", params=(), limit=30):
    """Recent ratings across songs/albums/artists, with track ratings collapsed per album."""
    events = rows(f"""
        SELECT * FROM (
            SELECT 'song' AS kind, sr.user_id, u.username, sr.score, sr.updated_at AS at, '' AS review,
                   s.mbid AS item_id, s.title AS item_title, al.mbid AS album_id, al.title AS album_title,
                   al.artist_credit AS artist, al.artist_mbid AS artist_id
            FROM song_ratings sr JOIN users u ON u.id = sr.user_id
            JOIN songs s ON s.mbid = sr.song_mbid JOIN albums al ON al.mbid = sr.album_mbid
            UNION ALL
            SELECT 'album', ar.user_id, u.username, ar.score, ar.updated_at, ar.review,
                   al.mbid, al.title, al.mbid, al.title, al.artist_credit, al.artist_mbid
            FROM album_ratings ar JOIN users u ON u.id = ar.user_id JOIN albums al ON al.mbid = ar.album_mbid
            UNION ALL
            SELECT 'artist', rr.user_id, u.username, rr.score, rr.updated_at, rr.review,
                   a.mbid, a.name, NULL, NULL, a.name, a.mbid
            FROM artist_ratings rr JOIN users u ON u.id = rr.user_id JOIN artists a ON a.mbid = rr.artist_mbid
        ) {where_sql} ORDER BY at DESC LIMIT 400
    """, params)
    out = []
    for e in events:
        prev = out[-1] if out else None
        if (e["kind"] == "song" and prev and prev["kind"] == "songs" and prev["user_id"] == e["user_id"]
                and prev["album_id"] == e["album_id"] and prev["at"] - e["at"] < 6 * 3600):
            prev["scores"].append(e["score"])
            continue
        if e["kind"] == "song":
            e = dict(e, kind="songs", scores=[e["score"]], first_title=e["item_title"])
        out.append(e)
        if len(out) >= limit:
            break
    for e in out:
        if e["kind"] == "songs":
            e["n"] = len(e["scores"])
            e["score"] = sum(e["scores"]) / len(e["scores"])
            if e["n"] > 1:
                e["item_title"] = None
            del e["scores"]
    return out


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


ROUTES = []


def route(method, pattern):
    regex = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, regex, fn))
        return fn

    return deco


def require_user(req):
    if not req.user:
        raise ApiError(401, "Log in to do that.")
    return req.user


def require_mbid(value):
    if not MBID_RE.match(value or ""):
        raise ApiError(400, "Invalid MusicBrainz id.")
    return value


def parse_score(value):
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 10:
        raise ApiError(400, "Score must be an integer from 1 to 10.")
    return value


def mb_call(fn, *args):
    try:
        return fn(*args)
    except MBError as e:
        if str(e) == "not_found":
            raise ApiError(404, "Not found on MusicBrainz.")
        if str(e) == "bad_request":
            raise ApiError(400, "MusicBrainz couldn't understand that search.")
        raise ApiError(503, str(e))


# --- auth -----------------------------------------------------------------

@route("GET", "/api/me")
def api_me(req):
    return {"user": public_user(req.user) if req.user else None}


@route("POST", "/api/auth/register")
def api_register(req):
    body = req.json()
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    if not USERNAME_RE.match(username):
        raise ApiError(400, "Usernames are 3–24 characters: letters, numbers, dots and underscores.")
    if len(password) < 8:
        raise ApiError(400, "Passwords need at least 8 characters.")
    if len(password) > 200:
        raise ApiError(400, "That password is too long.")
    try:
        cur = db().execute("INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)",
                           (username, hash_password(password), now()))
    except sqlite3.IntegrityError:
        raise ApiError(409, "That username is already taken.")
    req.set_session(create_session(cur.lastrowid))
    return {"user": public_user(one("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)))}


@route("POST", "/api/auth/login")
def api_login(req):
    if too_many_failures(req.client_ip):
        raise ApiError(429, "Too many attempts. Wait a few minutes and try again.")
    body = req.json()
    user = one("SELECT * FROM users WHERE username = ?", (str(body.get("username", "")).strip(),))
    if not user or not verify_password(str(body.get("password", "")), user["password_hash"]):
        record_failure(req.client_ip)
        raise ApiError(401, "Incorrect username or password.")
    req.set_session(create_session(user["id"]))
    return {"user": public_user(user)}


@route("POST", "/api/auth/logout")
def api_logout(req):
    if req.session_token:
        db().execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(req.session_token),))
    req.clear_session()
    return {"ok": True}


@route("PUT", "/api/me")
def api_update_me(req):
    user = require_user(req)
    bio = str(req.json().get("bio", "")).strip()[:280]
    db().execute("UPDATE users SET bio = ? WHERE id = ?", (bio, user["id"]))
    return {"user": public_user(one("SELECT * FROM users WHERE id = ?", (user["id"],)))}


# --- catalog --------------------------------------------------------------

def attach_album_stats(results):
    if not results:
        return results
    ids = [r["id"] for r in results]
    marks = ",".join("?" * len(ids))
    stats = {r["album_mbid"]: r for r in rows(
        f"SELECT album_mbid, AVG(score) AS avg, COUNT(*) AS count FROM album_ratings "
        f"WHERE album_mbid IN ({marks}) GROUP BY album_mbid", ids)}
    for r in results:
        st = stats.get(r["id"])
        r["avg"], r["count"] = (st["avg"], st["count"]) if st else (None, 0)
    return results


def local_search(q, limit_albums=12, limit_artists=6):
    """Instant results from albums/artists already stored locally (no MusicBrainz round trip)."""
    params = like_terms(q)
    if not params:
        return [], []
    hay_al = "lower(al.title || ' ' || COALESCE(NULLIF(al.artist_credit, ''), ar.name, ''))"
    cond_al = " AND ".join(f"{hay_al} LIKE :{k} ESCAPE '\\'" for k in params)
    albums = rows(f"""
        SELECT al.mbid AS id, al.title, COALESCE(NULLIF(al.artist_credit, ''), ar.name, '') AS artist,
               al.artist_mbid AS artist_id, al.year, al.primary_type AS type, al.secondary_types AS secondary,
               (SELECT COUNT(*) FROM song_ratings WHERE album_mbid = al.mbid)
               + (SELECT COUNT(*) FROM album_ratings WHERE album_mbid = al.mbid) AS heat
        FROM albums al LEFT JOIN artists ar ON ar.mbid = al.artist_mbid
        WHERE {cond_al}
        ORDER BY (al.secondary_types <> '[]'), (al.primary_type = 'Album') DESC, heat DESC, al.tracks_at IS NULL
        LIMIT {int(limit_albums)}
    """, params)
    for a in albums:
        a["secondary"] = json.loads(a["secondary"] or "[]")
        del a["heat"]
    cond_ar = " AND ".join(f"lower(name) LIKE :{k} ESCAPE '\\'" for k in params)
    artists = rows(f"""
        SELECT mbid AS id, name, type, country, disambiguation, begin_year AS begin FROM artists
        WHERE {cond_ar} ORDER BY (SELECT COUNT(*) FROM albums WHERE artist_mbid = artists.mbid) DESC
        LIMIT {int(limit_artists)}
    """, params)
    return attach_album_stats(albums), artists


@route("GET", "/api/search/local")
def api_search_local(req):
    q = (req.query.get("q") or "").strip()[:120]
    if len(q) < 2:
        return {"albums": [], "artists": []}
    albums, artists = local_search(q)
    return {"albums": albums, "artists": artists}


def artist_for_query(q, artists):
    """The artist a query names, if it plainly names one ("eminem", "kanye west", "beatles")."""
    qt = tokens(q)
    if not qt or not artists or artists[0].get("score", 0) < 90:
        return None
    top = artists[0]
    for name in [top["name"], *top.get("aliases", [])]:
        nt = tokens(name)
        if nt == qt or (qt <= nt and len(q) >= 4):
            return top
    return None


ARTIST_PUBLIC_FIELDS = ("id", "name", "type", "country", "disambiguation", "begin")


@route("GET", "/api/search")
def api_search(req):
    q = (req.query.get("q") or "").strip()[:120]
    if len(q) < 2:
        return {"results": []}
    if req.query.get("type") == "artist":
        return {"results": mb_call(search_artists, q)}

    albums, artists = mb_call(parallel, (search_albums, q), (search_artists, q))
    out = {"results": attach_album_stats(albums)}
    artist = artist_for_query(q, artists)
    if artist:
        # The query names an artist: lead with their discography (studio albums + EPs).
        ids = mb_call(artist_studio_releases, artist["id"])
        discography = albums_by_ids(ids, req.user["id"] if req.user else None)
        if discography:
            in_discography = set(ids)
            out["results"] = [a for a in albums if a["id"] not in in_discography]
            out["artist"] = {k: artist.get(k) for k in ARTIST_PUBLIC_FIELDS}
            out["artist_albums"] = discography
            # ...unless the "artist" is a minor act sharing its name with a well-known album
            # ("in rainbows" is also the name of a one-release remix project).
            out["albums_first"] = len(discography) <= 3 and any(
                tokens(a["title"]) == tokens(q) and a["artist_id"] != artist["id"] and a["editions"] >= 5
                for a in albums[:5])
    return out


@route("GET", "/api/suggest")
def api_suggest(req):
    """Type-ahead: albums and artists from MusicBrainz, fetched side by side."""
    q = (req.query.get("q") or "").strip()[:120]
    if len(q) < 2:
        return {"albums": [], "artists": []}
    albums, artists = mb_call(parallel, (search_albums, q), (search_artists, q))
    return {"albums": attach_album_stats(albums[:6]), "artists": artists[:4]}


@route("GET", "/api/album/(?P<rgid>[^/]+)")
def api_album(req, rgid):
    require_mbid(rgid)
    album = mb_call(load_album, rgid)
    uid = req.user["id"] if req.user else None
    tracks = rows("""
        SELECT t.disc, t.position, s.mbid AS id, s.title, s.length_ms, s.artist_credit,
               (SELECT AVG(score) FROM song_ratings WHERE song_mbid = s.mbid) AS avg,
               (SELECT COUNT(*) FROM song_ratings WHERE song_mbid = s.mbid) AS count,
               (SELECT score FROM song_ratings WHERE song_mbid = s.mbid AND user_id = ?) AS my
        FROM tracks t JOIN songs s ON s.mbid = t.song_mbid
        WHERE t.album_mbid = ? ORDER BY t.disc, t.position
    """, (uid, rgid))
    for t in tracks:
        if t["artist_credit"] == album["artist_credit"]:
            t["artist_credit"] = None  # only show credits that differ from the album's
    stats = one("SELECT AVG(score) AS avg, COUNT(*) AS count FROM album_ratings WHERE album_mbid = ?", (rgid,))
    dist = [0] * 10
    for r in rows("SELECT score, COUNT(*) AS n FROM album_ratings WHERE album_mbid = ? GROUP BY score", (rgid,)):
        dist[r["score"] - 1] = r["n"]
    raters = one("SELECT COUNT(DISTINCT user_id) AS n FROM song_ratings WHERE album_mbid = ?", (rgid,))["n"]
    reviews = rows("""
        SELECT u.username, ar.score, ar.review, ar.updated_at
        FROM album_ratings ar JOIN users u ON u.id = ar.user_id
        WHERE ar.album_mbid = ? AND ar.review <> '' ORDER BY ar.updated_at DESC LIMIT 30
    """, (rgid,))
    mine = None
    if uid:
        r = one("SELECT score, review FROM album_ratings WHERE user_id = ? AND album_mbid = ?", (uid, rgid))
        mine = {
            "score": r["score"] if r else None, "review": r["review"] if r else "",
            "listen_later": bool(one("SELECT 1 AS x FROM listen_later WHERE user_id = ? AND album_mbid = ?",
                                     (uid, rgid))),
        }
    return {
        "album": {
            "id": album["mbid"], "title": album["title"], "artist": album["artist_credit"],
            "artist_id": album["artist_mbid"], "year": album["year"], "type": album["primary_type"],
            "secondary": json.loads(album["secondary_types"]),
            "genres": [g["genre"] for g in rows(
                "SELECT genre FROM album_genres WHERE album_mbid = ? ORDER BY votes DESC", (rgid,))],
        },
        "tracks": tracks,
        "stats": {"avg": stats["avg"], "count": stats["count"], "distribution": dist, "track_raters": raters},
        "reviews": reviews,
        "mine": mine,
    }


@route("GET", "/api/artist/(?P<mbid>[^/]+)/other")
def api_artist_other(req, mbid):
    require_mbid(mbid)
    ids = mb_call(artist_other_releases, mbid)
    return {"albums": albums_by_ids(ids, req.user["id"] if req.user else None)}


@route("GET", "/api/artist/(?P<mbid>[^/]+)")
def api_artist(req, mbid):
    require_mbid(mbid)
    artist, studio_ids = mb_call(parallel, (load_artist, mbid), (artist_studio_releases, mbid))
    uid = req.user["id"] if req.user else None
    albums = albums_by_ids(studio_ids, uid)
    stats = one("SELECT AVG(score) AS avg, COUNT(*) AS count FROM artist_ratings WHERE artist_mbid = ?", (mbid,))
    top_songs = rows("""
        SELECT s.mbid AS id, s.title, sr.album_mbid AS album_id, al.title AS album_title,
               AVG(sr.score) AS avg, COUNT(*) AS count
        FROM song_ratings sr JOIN songs s ON s.mbid = sr.song_mbid JOIN albums al ON al.mbid = sr.album_mbid
        WHERE al.artist_mbid = ? GROUP BY s.mbid ORDER BY avg DESC, count DESC LIMIT 10
    """, (mbid,))
    mine = None
    if uid:
        r = one("SELECT score, review FROM artist_ratings WHERE user_id = ? AND artist_mbid = ?", (uid, mbid))
        mine = {"score": r["score"] if r else None, "review": r["review"] if r else ""}
    return {
        "artist": {
            "id": artist["mbid"], "name": artist["name"], "type": artist["type"], "country": artist["country"],
            "disambiguation": artist["disambiguation"], "begin": artist["begin_year"], "end": artist["end_year"],
            "genres": json.loads(artist["genres"]),
        },
        "albums": albums, "stats": stats, "top_songs": top_songs, "mine": mine,
    }


# --- ratings --------------------------------------------------------------

@route("PUT", "/api/ratings/song")
def api_rate_song(req):
    user = require_user(req)
    body = req.json()
    song, album = require_mbid(body.get("song")), require_mbid(body.get("album"))
    score = parse_score(body.get("score"))
    if not one("SELECT 1 AS x FROM tracks WHERE album_mbid = ? AND song_mbid = ?", (album, song)):
        raise ApiError(400, "That track isn't on this album.")
    t = now()
    if score is None:
        db().execute("DELETE FROM song_ratings WHERE user_id = ? AND song_mbid = ?", (user["id"], song))
    else:
        db().execute(
            "INSERT INTO song_ratings (user_id, song_mbid, album_mbid, score, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, song_mbid) DO UPDATE SET "
            "score = excluded.score, album_mbid = excluded.album_mbid, updated_at = excluded.updated_at",
            (user["id"], song, album, score, t, t))
    s = one("SELECT AVG(score) AS avg, COUNT(*) AS count FROM song_ratings WHERE song_mbid = ?", (song,))
    return {"score": score, "avg": s["avg"], "count": s["count"]}


@route("PUT", "/api/ratings/album")
def api_rate_album(req):
    user = require_user(req)
    body = req.json()
    album = require_mbid(body.get("album"))
    score = parse_score(body.get("score"))
    review = str(body.get("review") or "").strip()[:2000]
    if not one("SELECT 1 AS x FROM albums WHERE mbid = ?", (album,)):
        raise ApiError(404, "Unknown album.")
    t = now()
    if score is None:
        db().execute("DELETE FROM album_ratings WHERE user_id = ? AND album_mbid = ?", (user["id"], album))
    else:
        db().execute(
            "INSERT INTO album_ratings (user_id, album_mbid, score, review, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, album_mbid) DO UPDATE SET "
            "score = excluded.score, review = excluded.review, updated_at = excluded.updated_at",
            (user["id"], album, score, review, t, t))
        db().execute("DELETE FROM listen_later WHERE user_id = ? AND album_mbid = ?", (user["id"], album))
    s = one("SELECT AVG(score) AS avg, COUNT(*) AS count FROM album_ratings WHERE album_mbid = ?", (album,))
    return {"score": score, "avg": s["avg"], "count": s["count"]}


@route("PUT", "/api/ratings/artist")
def api_rate_artist(req):
    user = require_user(req)
    body = req.json()
    artist = require_mbid(body.get("artist"))
    score = parse_score(body.get("score"))
    review = str(body.get("review") or "").strip()[:2000]
    if not one("SELECT 1 AS x FROM artists WHERE mbid = ?", (artist,)):
        raise ApiError(404, "Unknown artist.")
    t = now()
    if score is None:
        db().execute("DELETE FROM artist_ratings WHERE user_id = ? AND artist_mbid = ?", (user["id"], artist))
    else:
        db().execute(
            "INSERT INTO artist_ratings (user_id, artist_mbid, score, review, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, artist_mbid) DO UPDATE SET "
            "score = excluded.score, review = excluded.review, updated_at = excluded.updated_at",
            (user["id"], artist, score, review, t, t))
    s = one("SELECT AVG(score) AS avg, COUNT(*) AS count FROM artist_ratings WHERE artist_mbid = ?", (artist,))
    return {"score": score, "avg": s["avg"], "count": s["count"]}


@route("POST", "/api/listen-later/(?P<rgid>[^/]+)")
def api_listen_later_add(req, rgid):
    user = require_user(req)
    require_mbid(rgid)
    if not one("SELECT 1 AS x FROM albums WHERE mbid = ?", (rgid,)):
        raise ApiError(404, "Unknown album.")
    db().execute("INSERT OR IGNORE INTO listen_later (user_id, album_mbid, added_at) VALUES (?,?,?)",
                 (user["id"], rgid, now()))
    return {"listen_later": True}


@route("DELETE", "/api/listen-later/(?P<rgid>[^/]+)")
def api_listen_later_remove(req, rgid):
    user = require_user(req)
    require_mbid(rgid)
    db().execute("DELETE FROM listen_later WHERE user_id = ? AND album_mbid = ?", (user["id"], rgid))
    return {"listen_later": False}


# --- people ---------------------------------------------------------------

@route("GET", "/api/users/(?P<username>[^/]+)")
def api_user(req, username):
    u = one("SELECT * FROM users WHERE username = ?", (username,))
    if not u:
        raise ApiError(404, "No such user.")
    uid = u["id"]
    counts = one("""
        SELECT (SELECT COUNT(*) FROM song_ratings WHERE user_id = :u) AS songs,
               (SELECT COUNT(*) FROM album_ratings WHERE user_id = :u) AS albums,
               (SELECT COUNT(*) FROM artist_ratings WHERE user_id = :u) AS artists,
               (SELECT COUNT(*) FROM follows WHERE followee_id = :u) AS followers,
               (SELECT COUNT(*) FROM follows WHERE follower_id = :u) AS following,
               (SELECT AVG(score) FROM (SELECT score FROM song_ratings WHERE user_id = :u
                                        UNION ALL SELECT score FROM album_ratings WHERE user_id = :u)) AS avg
    """, {"u": uid})
    dist = [0] * 10
    for r in rows("SELECT score, COUNT(*) AS n FROM song_ratings WHERE user_id = ? GROUP BY score", (uid,)):
        dist[r["score"] - 1] = r["n"]
    genres = sorted(user_genre_vector(uid).items(), key=lambda kv: -kv[1])[:10]
    top_w = genres[0][1] if genres else 1
    top_albums = rows("""
        SELECT al.mbid AS id, al.title, al.artist_credit AS artist, al.year, ar.score, ar.review
        FROM album_ratings ar JOIN albums al ON al.mbid = ar.album_mbid
        WHERE ar.user_id = ? ORDER BY ar.score DESC, ar.updated_at DESC LIMIT 12
    """, (uid,))
    top_songs = rows("""
        SELECT s.mbid AS id, s.title, sr.score, al.mbid AS album_id, al.title AS album_title,
               al.artist_credit AS artist
        FROM song_ratings sr JOIN songs s ON s.mbid = sr.song_mbid JOIN albums al ON al.mbid = sr.album_mbid
        WHERE sr.user_id = ? ORDER BY sr.score DESC, sr.updated_at DESC LIMIT 10
    """, (uid,))
    top_artists = rows("""
        SELECT a.mbid AS id, a.name, AVG(x.score) AS avg, COUNT(*) AS n,
               (SELECT score FROM artist_ratings WHERE user_id = :u AND artist_mbid = a.mbid) AS explicit,
               (SELECT al2.mbid FROM albums al2 JOIN song_ratings sr2 ON sr2.album_mbid = al2.mbid
                 WHERE al2.artist_mbid = a.mbid AND sr2.user_id = :u
                 GROUP BY al2.mbid ORDER BY AVG(sr2.score) DESC LIMIT 1) AS cover_album
        FROM (
            SELECT al.artist_mbid AS artist, sr.score FROM song_ratings sr
              JOIN albums al ON al.mbid = sr.album_mbid WHERE sr.user_id = :u
            UNION ALL
            SELECT al.artist_mbid, ar.score FROM album_ratings ar
              JOIN albums al ON al.mbid = ar.album_mbid WHERE ar.user_id = :u
            UNION ALL
            SELECT artist_mbid, score FROM artist_ratings WHERE user_id = :u
        ) x JOIN artists a ON a.mbid = x.artist
        GROUP BY a.mbid ORDER BY COALESCE(explicit, AVG(x.score)) * 1.0 + MIN(COUNT(*), 20) * 0.08 DESC LIMIT 8
    """, {"u": uid})
    in_progress = rows("""
        SELECT al.mbid AS id, al.title, al.artist_credit AS artist, COUNT(sr.song_mbid) AS rated,
               (SELECT COUNT(*) FROM tracks t WHERE t.album_mbid = al.mbid) AS total,
               MAX(sr.updated_at) AS at
        FROM song_ratings sr JOIN albums al ON al.mbid = sr.album_mbid
        WHERE sr.user_id = ? GROUP BY al.mbid HAVING rated < total ORDER BY at DESC LIMIT 6
    """, (uid,))
    listen_later = rows("""
        SELECT al.mbid AS id, al.title, al.artist_credit AS artist, al.year
        FROM listen_later ll JOIN albums al ON al.mbid = ll.album_mbid
        WHERE ll.user_id = ? ORDER BY ll.added_at DESC LIMIT 24
    """, (uid,))
    viewer = req.user
    match = following = None
    if viewer and viewer["id"] != uid:
        match = taste_match(viewer["id"], uid)
        following = bool(one("SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?",
                             (viewer["id"], uid)))
    return {
        "user": public_user(u), "counts": counts, "distribution": dist,
        "genres": [{"name": g, "weight": w / top_w} for g, w in genres],
        "top_albums": top_albums, "top_songs": top_songs, "top_artists": top_artists,
        "in_progress": in_progress, "listen_later": listen_later,
        "recent": recent_activity("WHERE user_id = ?", (uid,), limit=12),
        "is_me": bool(viewer and viewer["id"] == uid), "match": match, "following": following,
    }


@route("POST", "/api/users/(?P<username>[^/]+)/follow")
def api_follow(req, username):
    user = require_user(req)
    other = one("SELECT id FROM users WHERE username = ?", (username,))
    if not other:
        raise ApiError(404, "No such user.")
    if other["id"] == user["id"]:
        raise ApiError(400, "You can't follow yourself.")
    db().execute("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)",
                 (user["id"], other["id"], now()))
    return {"following": True}


@route("DELETE", "/api/users/(?P<username>[^/]+)/follow")
def api_unfollow(req, username):
    user = require_user(req)
    other = one("SELECT id FROM users WHERE username = ?", (username,))
    if other:
        db().execute("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?", (user["id"], other["id"]))
    return {"following": False}


@route("GET", "/api/people")
def api_people(req):
    active = rows("""
        SELECT u.id, u.username, u.bio, u.created_at,
               (SELECT COUNT(*) FROM song_ratings WHERE user_id = u.id) +
               (SELECT COUNT(*) FROM album_ratings WHERE user_id = u.id) AS ratings
        FROM users u ORDER BY ratings DESC LIMIT 200
    """)
    viewer = req.user
    following = set()
    if viewer:
        following = {r["followee_id"] for r in rows("SELECT followee_id FROM follows WHERE follower_id = ?",
                                                    (viewer["id"],))}
    cache = {}
    out = []
    for u in active:
        if viewer and u["id"] == viewer["id"]:
            continue
        if not u["ratings"]:
            continue
        g = sorted(user_genre_vector(u["id"]).items(), key=lambda kv: -kv[1])[:3]
        item = dict(public_user(u), ratings=u["ratings"], top_genres=[x[0] for x in g],
                    following=u["id"] in following)
        if viewer:
            item["match"] = taste_match(viewer["id"], u["id"], cache)
        out.append(item)
    if viewer:
        out.sort(key=lambda x: -(x["match"]["percent"] if x["match"] else -1))
    return {"people": out[:60]}


@route("GET", "/api/home")
def api_home(req):
    uid = req.user["id"] if req.user else None
    stats = one("""
        SELECT (SELECT COUNT(*) FROM users) AS users,
               (SELECT COUNT(*) FROM song_ratings) + (SELECT COUNT(*) FROM album_ratings)
               + (SELECT COUNT(*) FROM artist_ratings) AS ratings,
               (SELECT COUNT(DISTINCT album_mbid) FROM (SELECT album_mbid FROM song_ratings
                                                        UNION SELECT album_mbid FROM album_ratings)) AS albums
    """)
    since = now() - 14 * 86400
    trending = album_summary_rows("""
        JOIN (SELECT album_mbid, COUNT(*) AS heat FROM (
                SELECT album_mbid, updated_at FROM song_ratings
                UNION ALL SELECT album_mbid, updated_at FROM album_ratings
                UNION ALL SELECT album_mbid, added_at FROM listen_later
              ) WHERE updated_at >= :since GROUP BY album_mbid) h ON h.album_mbid = al.mbid
    """, {"since": since}, "ORDER BY h.heat DESC", 18, uid)
    if len(trending) < 6:
        trending = album_summary_rows("""
            JOIN (SELECT album_mbid, COUNT(*) AS heat FROM (
                    SELECT album_mbid FROM song_ratings UNION ALL SELECT album_mbid FROM album_ratings
                  ) GROUP BY album_mbid) h ON h.album_mbid = al.mbid
        """, {}, "ORDER BY h.heat DESC", 18, uid)
    top_rated = album_summary_rows("""
        JOIN (SELECT album_mbid, AVG(score) AS a, COUNT(*) AS n FROM album_ratings GROUP BY album_mbid
              HAVING n >= 2) r ON r.album_mbid = al.mbid
    """, {}, "ORDER BY r.a DESC, r.n DESC", 12, uid)
    out = {"stats": stats, "trending": trending, "top_rated": top_rated, "recent": recent_activity(limit=16)}
    if uid:
        out["following_feed"] = recent_activity(
            "WHERE user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)", (uid,), limit=16)
        out["in_progress"] = rows("""
            SELECT al.mbid AS id, al.title, al.artist_credit AS artist, COUNT(sr.song_mbid) AS rated,
                   (SELECT COUNT(*) FROM tracks t WHERE t.album_mbid = al.mbid) AS total, MAX(sr.updated_at) AS at
            FROM song_ratings sr JOIN albums al ON al.mbid = sr.album_mbid
            WHERE sr.user_id = ? GROUP BY al.mbid HAVING rated < total ORDER BY at DESC LIMIT 6
        """, (uid,))
        out["my_counts"] = one("""
            SELECT (SELECT COUNT(*) FROM song_ratings WHERE user_id = :u) AS songs,
                   (SELECT COUNT(*) FROM album_ratings WHERE user_id = :u) AS albums,
                   (SELECT COUNT(*) FROM artist_ratings WHERE user_id = :u) AS artists
        """, {"u": uid})
    return out


# --- request handler ------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "Crescendo/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("CRESCENDO_QUIET") != "1":
            super().log_message(fmt, *args)

    # helpers used by routes
    @property
    def client_ip(self):
        return self.client_address[0]

    def json(self):
        return self._body if isinstance(self._body, dict) else {}

    def set_session(self, token):
        self._cookies_out.append(self._cookie(token, SESSION_DAYS * 86400))

    def clear_session(self):
        self._cookies_out.append(self._cookie("", 0))

    def _cookie(self, value, max_age):
        parts = [f"{SESSION_COOKIE}={value}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if SECURE_COOKIES:
            parts.append("Secure")
        return "; ".join(parts)

    def _load_user(self):
        self.user = None
        self.session_token = None
        raw = self.headers.get("Cookie")
        if not raw:
            return
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except Exception:
            return
        morsel = cookie.get(SESSION_COOKIE)
        if not morsel or not morsel.value:
            return
        self.session_token = morsel.value
        r = one("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash = ? AND s.expires_at > ?", (token_hash(morsel.value), now()))
        self.user = r

    def _send(self, status, body, content_type, extra_headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in extra_headers:
            self.send_header(k, v)
        for c in getattr(self, "_cookies_out", []):
            self.send_header("Set-Cookie", c)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self._send(status, body, "application/json; charset=utf-8", [("Cache-Control", "no-store")])

    def _dispatch(self):
        self._cookies_out = []
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            if self.command in ("GET", "HEAD"):
                return self._static(path)
            return self._send_json(405, {"error": "Method not allowed."})

        self.query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            self._body = None
            if self.command in ("POST", "PUT", "DELETE"):
                # CSRF defence: cross-site forms can't send JSON, and Origin must match when present.
                origin = self.headers.get("Origin")
                if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host"):
                    raise ApiError(403, "Cross-origin request refused.")
                length = int(self.headers.get("Content-Length") or 0)
                if length > 64 * 1024:
                    raise ApiError(413, "Request too large.")
                raw = self.rfile.read(length) if length else b""
                if raw:
                    if "application/json" not in (self.headers.get("Content-Type") or ""):
                        raise ApiError(415, "Send JSON.")
                    try:
                        self._body = json.loads(raw)
                    except ValueError:
                        raise ApiError(400, "Malformed JSON.")
                elif self.command != "DELETE" and "application/json" not in (self.headers.get("Content-Type") or ""):
                    raise ApiError(415, "Send JSON.")
            self._load_user()
            for method, regex, fn in ROUTES:
                if method != self.command:
                    continue
                m = regex.match(path)
                if m:
                    params = {k: urllib.parse.unquote(v) for k, v in m.groupdict().items()}
                    return self._send_json(200, fn(self, **params))
            raise ApiError(404, "Unknown endpoint.")
        except ApiError as e:
            self._send_json(e.status, {"error": e.message})
        except Exception as e:  # pragma: no cover - last-resort guard
            self.log_error("Unhandled error on %s: %r", path, e)
            self._send_json(500, {"error": "Something went wrong on our side."})

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")  # SPA fallback
        mtime = int(os.path.getmtime(full))
        last_modified = formatdate(mtime, usegmt=True)
        since = self.headers.get("If-Modified-Since")
        try:
            if since and parsedate_to_datetime(since).timestamp() >= mtime:
                self.send_response(304)
                self.send_header("Last-Modified", last_modified)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        except (TypeError, ValueError):
            pass
        with open(full, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        # Always revalidate (cheap 304s) so a deploy is picked up immediately.
        self._send(200, body, ctype, [("Cache-Control", "no-cache"), ("Last-Modified", last_modified)])

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _dispatch


# ---------------------------------------------------------------------------
# Demo seed
# ---------------------------------------------------------------------------

DEMO_ALBUMS = [
    ("Currents", "Tame Impala"), ("In Rainbows", "Radiohead"), ("Mezzanine", "Massive Attack"),
    ("channel ORANGE", "Frank Ocean"), ("Blonde", "Frank Ocean"), ("SOS", "SZA"),
    ("Carrie & Lowell", "Sufjan Stevens"), ("Bon Iver, Bon Iver", "Bon Iver"), ("IGOR", "Tyler, The Creator"),
    ("Con Todo El Mundo", "Khruangbin"), ("Fleet Foxes", "Fleet Foxes"), ("Kid A", "Radiohead"),
    ("Random Access Memories", "Daft Punk"), ("To Pimp a Butterfly", "Kendrick Lamar"),
    ("Rumours", "Fleetwood Mac"), ("Discovery", "Daft Punk"),
]
DEMO_USERS = [
    ("mustafa", "Yacht-rock to post-punk. Always one track away from a new favorite.", 0.3),
    ("elif_k", "Synths, strings and anything that sounds like 3am.", 0.6),
    ("can.polat", "Still building my taste profile.", -0.2),
]


def seed_demo():
    import random
    rng = random.Random(7)
    print("Seeding demo data from MusicBrainz (this takes a minute — the API allows ~1 request/second)…")
    album_ids = []
    for title, artist in DEMO_ALBUMS:
        try:
            hits = search_albums(f"{title} {artist}")
        except MBError as e:
            print(f"  ! search failed for {title}: {e}")
            continue
        hit = next((h for h in hits if h["title"].lower() == title.lower()
                    and artist.lower() in h["artist"].lower()), hits[0] if hits else None)
        if not hit:
            continue
        try:
            load_album(hit["id"])
        except MBError as e:
            print(f"  ! couldn't load {title}: {e}")
            continue
        album_ids.append(hit["id"])
        print(f"  ✓ {hit['title']} — {hit['artist']}")

    t0 = now() - 10 * 86400
    for name, bio, bias in DEMO_USERS:
        if one("SELECT 1 AS x FROM users WHERE username = ?", (name,)):
            continue
        cur = db().execute("INSERT INTO users (username, password_hash, bio, created_at) VALUES (?,?,?,?)",
                           (name, hash_password("password123"), bio, t0))
        uid = cur.lastrowid
        for rgid in rng.sample(album_ids, k=min(len(album_ids), rng.randint(7, 11))):
            album_taste = rng.gauss(7 + bias * 2, 1.4)
            t = t0 + rng.randint(0, 9 * 86400)
            scores = []
            for tr in rows("SELECT song_mbid FROM tracks WHERE album_mbid = ?", (rgid,)):
                s = max(1, min(10, round(rng.gauss(album_taste, 1.5))))
                scores.append(s)
                t += rng.randint(30, 240)
                db().execute("INSERT OR IGNORE INTO song_ratings VALUES (?,?,?,?,?,?)",
                             (uid, tr["song_mbid"], rgid, s, t, t))
            if scores:
                a = max(1, min(10, round(sum(scores) / len(scores) + rng.uniform(-0.5, 1.2))))
                db().execute("INSERT OR IGNORE INTO album_ratings VALUES (?,?,?,?,?,?)", (uid, rgid, a, "", t, t))
    users = [r["id"] for r in rows("SELECT id FROM users WHERE username IN (?,?,?)", [u[0] for u in DEMO_USERS])]
    for a in users:
        for b in users:
            if a != b and rng.random() < 0.6:
                db().execute("INSERT OR IGNORE INTO follows VALUES (?,?,?)", (a, b, t0))
    print("Done. Demo logins: mustafa / elif_k / can.polat — password: password123")


def main():
    parser = argparse.ArgumentParser(description="Crescendo server")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    parser.add_argument("--seed-demo", action="store_true", help="create demo accounts with ratings, then exit")
    args = parser.parse_args()

    init_db()
    db().execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
    if args.seed_demo:
        seed_demo()
        return
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"Crescendo is live on http://{args.host}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBye.")


if __name__ == "__main__":
    main()
