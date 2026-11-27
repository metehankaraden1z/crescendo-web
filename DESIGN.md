---
name: Crescendo
description: A record shop at night, where every album wears its score like a price sticker.
colors:
  bg: "#121110"
  bg-2: "#171614"
  surface: "#1C1A17"
  surface-2: "#26231F"
  surface-3: "#312D28"
  line: "#2C2924"
  line-2: "#403B34"
  line-3: "#6B645B"
  text: "#F2EFE8"
  text-2: "#CFC9BE"
  muted: "#A39C90"
  sticker: "#FF6A2B"
  sticker-2: "#FF8A57"
  on-sticker: "#121110"
  star-empty: "#77706A"
  danger: "#FF7A66"
typography:
  signage:
    fontFamily: "Anton, 'Arial Narrow', Impact, sans-serif"
    fontSize: "clamp(3rem, 7vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.92
    textTransform: uppercase
  page-title:
    fontFamily: "Anton, 'Arial Narrow', Impact, sans-serif"
    fontSize: "clamp(2.5rem, 5.6vw, 4.5rem)"
    fontWeight: 400
    lineHeight: 0.95
    textTransform: uppercase
  section:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 750
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.8125rem"
rounded:
  control: "6px"
  sticker: "50%"
  cover: "0px"
spacing:
  wrap: "1180px"
  page-pad: "24px (16px on phones)"
  section: "48px"
  target: "44px"
components:
  sticker:
    backgroundColor: "{colors.sticker}"
    textColor: "{colors.on-sticker}"
    size: "44px"
    rotate: "-9deg"
  action-primary:
    backgroundColor: "{colors.sticker}"
    textColor: "{colors.on-sticker}"
    rounded: "{rounded.control}"
    height: "44px"
  action:
    backgroundColor: "transparent"
    borderColor: "{colors.line-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "44px"
---

## Overview

Crescendo is a record shop at night. Browsing is flipping through a bin of real sleeves; every album wears its
community score as a round orange price sticker on the cover corner. Opening an album is pulling the record out and
reading the back of the sleeve: a ruled tracklist where every track gets its own score. The landing page is the shop
window (signage headline, the search field, six real records from the shelf); everything after sign-in is a tool and
is set quietly.

It deliberately refuses the dark-SaaS template it replaced: no colour blobs, film grain, glow, glass, eyebrow labels
above headings, stat bands, three-step cards, tilted demo cards or endless animations.

## Colors

- One ground (`bg`) with warm shelf surfaces (`surface`, `surface-2`, `surface-3`) and card-stock text (`text`).
- **One accent, `sticker` orange**, used only for: scores (stickers), filled stars, the primary action, and the
  current selection (active tab, current track dot, bottom tab bar). Data bars (genre fingerprint, histogram,
  community bars) stay neutral `text-2`.
- Avatars are neutral (`surface-3`), never hashed colours.
- Contrast: `text` 15:1, `text-2` 10.5:1, `muted` 6.4:1 on `surface`. Empty stars (`star-empty`) are 3.6:1 on
  `surface`, so keep them off `surface-3`. Input borders use `line-3` (3:1); `line`/`line-2` are rules only.

## Typography

Two faces, with a hard split. **Anton** is shop signage: the landing headline, album, artist, profile, people and
rating-session titles, always uppercase. Everything you operate or read (labels, buttons, numbers, section headings,
body) is the system UI face at a fixed rem scale. Numbers use tabular figures. No third face, no monospace.

## Layout

A single 1180px column. Sections are separated by a 2px `text` rule under a plain section heading (the shelf edge),
never by tiles: grouped content (score boxes, charts, people) sits on the shelf under a 1px rule with no fill.
Album grids are bins of square covers. Under 760px a bottom tab bar (Home, Search, People, Me/Log in) appears and
the top bar loses its People and Log in links.

## Elevation & Depth

None beyond a sleeve's 1px edge (`inset 0 0 0 1px` at 6-8% card-stock). The type-ahead dropdown is the only
floating layer with a shadow.

## Shapes

Covers are square with no radius. Stickers are circles rotated -9deg. Controls (buttons, inputs, chips) use a 6px
radius. Every control is at least 44px tall; star rows pad to a 44px hit area.

## Components

- **Score sticker:** 44px orange circle, black numeral, top-right of a cover. A user's own score on their profile
  uses the same orange with a black inner ring. Inline variant (`sticker-inline`) for averages and the session score.
- **Stars:** outline `star-empty`, fill `sticker`, half-star steps. Interactive stars are keyboard sliders.
- **Album card:** cover with the average sticker, title, artist, then a labelled "You: 4.5" line when you rated it.
- **Tracklist row:** number (orange when rated), title and credit, length, community bar labelled "Avg" on phones,
  your stars.
- **Rating session:** full-screen; Anton track title, big stars, the given score slapped on as a sticker (180ms
  scale-in), held about 450ms, then the next track. Overwriting a score shows a toast with Undo.
- **Feed row:** one row per listener per album per sitting (track ratings and the album rating are merged).
- **Cover fallback:** while art loads or when it is missing, the sleeve is plain `surface-2` with the title typed on it.

## Motion

Only state feedback: sticker slap (180ms), star fill (120ms), cover lift on hover (150ms), the loading equaliser.
Under reduced motion the movement goes; colour and opacity changes stay.

## Do's and Don'ts

- Do keep orange for scores, stars, the primary action and the current selection; don't use it for decoration or data.
- Do write headings as plain words; don't add eyebrow labels, gradient text or italic accent words.
- Do draw icons as SVG; don't use Unicode stars, sparkles or arrows as icons.
- Do show real covers and real scores; don't add demo cards, fake stats or placeholder art.
- Don't add rounded tiles, drop shadows, glass, glow, grain or looping animations.
