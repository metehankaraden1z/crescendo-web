# Crescendo

Crescendo is a community music‑rating app. Search any album on MusicBrainz, rate it **song by song** in
half‑stars, rate the album and the artist, and get a **Taste DNA** profile plus a **taste match %** with
every other listener.

Nothing to install: the server is a single Python file using only the standard library (`http.server`,
`sqlite3`, `hashlib.scrypt`), and the web front end is plain HTML/CSS/JS.

## Run it

```bash
python3 server.py                 # → http://127.0.0.1:8000
python3 server.py --port 9000
python3 server.py --host 0.0.0.0  # reachable from other devices on your network
python3 server.py --seed-demo     # optional: demo accounts (mustafa / elif_k / can.polat, password "password123")
```

Requires Python 3.9+. The database is created automatically at `data/crescendo.db`.

| Env var | Purpose |
|---|---|
| `CRESCENDO_DB` | Path of the SQLite file (default `data/crescendo.db`) |
| `CRESCENDO_SECURE=1` | Mark the session cookie `Secure` (set this when serving over HTTPS) |
| `CRESCENDO_MB_UA` | User‑Agent sent to MusicBrainz. Put your own app name and contact here |
| `CRESCENDO_QUIET=1` | Silence the request log |
| `CRESCENDO_DEBUG_MB=1` | Log each MusicBrainz call with timing |

## Features

- **Search:** any album or artist from MusicBrainz, with suggestions as you type. Searching an artist's
  name ("eminem", "kanye west") leads with that artist's albums.
- **Ratings:** half‑star ratings (stored as 1–10) for songs, albums and artists, plus written reviews.
- **Track‑by‑track mode:** a full‑screen flow that walks through an album one song at a time. Keys 1–5
  rate, and Shift adds a half star.
- **Taste DNA:** a genre fingerprint, a rating curve, and top albums, songs and artists.
- **Social:** a taste match % with every listener, follows, an activity feed and Listen Later.
- **Accounts:** salted scrypt password hashes and HttpOnly session cookies.

## Database

```
users(id, username UNIQUE NOCASE, password_hash, bio, created_at)
sessions(token_hash, user_id, created_at, expires_at)          -- only SHA‑256 of the token is stored
follows(follower_id, followee_id, created_at)

artists(mbid, name, type, country, begin_year, end_year, genres…)
albums(mbid, title, artist_mbid, artist_credit, year, primary_type, secondary_types, release_mbid)
album_genres(album_mbid, genre, votes)
songs(mbid, title, length_ms, artist_credit)                    -- MusicBrainz recordings
tracks(album_mbid, disc, position, song_mbid)

song_ratings(user_id, song_mbid, album_mbid, score 1‑10, created_at, updated_at)
album_ratings(user_id, album_mbid, score 1‑10, review, …)
artist_ratings(user_id, artist_mbid, score 1‑10, review, …)
listen_later(user_id, album_mbid, added_at)
mb_cache(key, body, fetched_at)                                 -- raw MusicBrainz responses
```

## API

Everything the web front end does goes through a JSON API, so other clients, such as mobile apps, can
use the same endpoints. Logging in sets an HttpOnly `cr_session` cookie; send it back on later requests.
Requests that change data must use `Content-Type: application/json`. Errors come back as
`{"error": "..."}` with a matching HTTP status.

| Method & path | Purpose |
|---|---|
| `POST /api/auth/register` · `POST /api/auth/login` | `{username, password}` → `{user}` and a session cookie |
| `POST /api/auth/logout` · `GET /api/me` · `PUT /api/me` | End session · current user · update `{bio}` |
| `GET /api/search?q=&type=album\|artist` | MusicBrainz search; album searches may include `artist` + `artist_albums` |
| `GET /api/search/local?q=` · `GET /api/suggest?q=` | Instant local matches · type‑ahead suggestions |
| `GET /api/album/<release-group id>` | Album, tracklist, community stats, your ratings, reviews |
| `GET /api/artist/<id>` · `GET /api/artist/<id>/other` | Artist, studio albums and EPs · live albums, compilations and more |
| `PUT /api/ratings/song` | `{song, album, score}`; `score` is 1–10, or `null` to clear |
| `PUT /api/ratings/album` · `PUT /api/ratings/artist` | `{album\|artist, score, review}` |
| `POST`/`DELETE /api/listen-later/<id>` | Add or remove an album |
| `GET /api/users/<name>` · `POST`/`DELETE /api/users/<name>/follow` | Profile with Taste DNA · follow and unfollow |
| `GET /api/people` · `GET /api/home` | Listeners ranked by taste match · home feed, trending, stats |

## Speed & MusicBrainz etiquette

MusicBrainz asks for about one request per second. The server keeps to that on average (token bucket,
short bursts of 3 so independent lookups can overlap), reuses keep‑alive HTTPS connections, and prefers
whichever address family actually connects. On networks that resolve IPv6 but can't route it, this avoids
waiting out a connection timeout on every call. MusicBrainz sheds load with fast random `503 busy` replies,
so those are retried after 0.3–0.6 s.

Every response is cached in `mb_cache` (searches for a day, albums and artists for 30 days), so anything
viewed once loads straight from SQLite. On top of that:

* **Search:** albums and artists already on Crescendo show instantly from SQLite (`/api/search/local`);
  MusicBrainz results replace them a moment later. Every search box suggests results as you type
  (`/api/suggest` runs the album and artist searches side by side).
* **Artist pages:** one search call fetches official studio albums and EPs, run in parallel with the
  artist lookup. Live albums, compilations and bootlegs, which can run to hundreds, load only when asked
  for (`/api/artist/<id>/other`).
* **Albums:** the release‑group and tracklist calls run in parallel.
* **Prefetch:** hovering or focusing an album or artist link loads its data in the background, so the
  click usually opens instantly.

Set `CRESCENDO_DEBUG_MB=1` to log every MusicBrainz call with its duration and retry count.

## Deploying

`server.py` is a long‑running process, so it needs a host that runs Python, such as a small VPS, Fly.io,
Railway or Render (GitHub Pages only serves static files). Put it behind HTTPS (for example Caddy or nginx)
and set `CRESCENDO_SECURE=1`. Keep `data/` on a persistent volume.

Credits: music data from [MusicBrainz](https://musicbrainz.org), cover art from the
[Cover Art Archive](https://coverartarchive.org).
