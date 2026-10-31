---
name: coco-demo-video
description: "Record coco's README media (the demo clip, its player and the stills) against a throwaway demo server seeded with fictional data: motion over the live app, a numbered caption per beat, coco's palette, a GIF under 8 MB and an inline player. Use when the README hero or docs/media has to be re-recorded, or when a feature changes what the demo shows."
argument-hint: "[shots|video|all]"
allowed-tools: Bash, Read, Edit
---

# coco-demo-video

Re-record `docs/media` from a demo coco that lives in `/tmp`, never from the
server you work in. One continuous pass over the app, with the camera moving,
a numbered caption under each beat, and the brand rising over the product
instead of a card standing in front of it.

## Scope

- Writes `docs/media/demo.{gif,mp4,webm,jpg}` and `stack-plan.png`,
  `code-review.png`, `findings-board.png`, `agent-thread.png`; the vertical
  take writes `demo-vertical.{mp4,jpg}`.
- Reads `scripts/record-demo.ts`, `demo/`, `README.md`. Edits the recorder
  when a beat hits a UI that moved.
- Never the real server: no persona name, token, card or personal work may
  reach `docs/media`.

## 1. The throwaway server (port 8793)

```bash
bash demo/make-repo.sh                     # the fictional acme/widgets stack
rm -rf /tmp/coco-demo/data                 # a fresh data dir every time
PATH="$PWD/demo/bin:$PATH" COCO_CONFIG="$PWD/demo/coco.config.demo.json" \
  node server/index.ts 8793 > /tmp/coco-demo/server-8793.log 2>&1 &
COCO_APP="$PWD" COCO_URL=http://127.0.0.1:8793 node demo/seed.mjs
```

`demo/bin` stubs `claude`, `gh` and `paseo`, so the demo never reaches the
daemon or GitHub. `demo/coco.config.demo.json` points `dataDir`, `repo` and
the persona dir at `/tmp/coco-demo`; `seed.mjs` deletes and rebuilds the
`invoice-csv-export` work, so it is safe to run before every take.

## 2. Record

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
COCO_URL=http://127.0.0.1:8793 node scripts/record-demo.ts all
```

`shots` takes the four stills, `video` the clip, `all` both. Reseed before
`video`: the clip takes the open decision, and a taken one has nothing left
to answer. Playwright is not a dependency of coco; `PLAYWRIGHT_MODULE` names
its `index.mjs` when the repo has none. The GIF step needs `gifsicle`
(`brew install gifsicle`): without it the encoded GIF stays raw and blows
past 8 MB.

The beats, in order: the work and its progress, a decision taken, a PR
reviewed file by file, the findings board, the agent's answer, the stack.

## 3. How it moves

The look is a product film, not a screen capture, and **no frame goes
black**: every card and every cut is a state of the app itself.

- The camera. `#root` is scaled 1.0 → 1.07 and back with a transform origin
  on the element being acted on, so the push lands where the click goes.
- A cut is a punch: scale to 1.07, 110 ms of violet glow, swap the tab,
  settle back. Never a dip through black.
- Title and outro are overlays over the live app (dim plus the palette), so
  the first frame already shows the product: the parrot mark, `coco`, "ADE,
  but *your way.*" and three chips; the outro is the line and the repo chip.
- A violet ring on whatever is about to be acted on, a ripple on every
  click, and a numbered caption chip bottom-left (`01 — Plan`, `02 — Decide`,
  …) with one line under it.
- Palette from `docs/media/banner.svg`: cream `#f3ecdc`, violet `#7b7bf5`,
  amber `#f2b84b`, muted `#a9abb6`, on the app's own dark theme
  (`DEMO_THEME=light` records the other one).

## 4. Encode and publish

The encoder writes `demo.mp4` (H.264, crf 25), `demo.webm` (VP9), a
`demo.jpg` poster, and `demo.gif` at 820 px / 8 fps with a 192-colour
palette, then runs `gifsicle -O3 --lossy=120` — a moving camera changes
every frame, and raw GIF stores each one three times over.

The README shows both: the GIF as the inline hero, and the mp4 as a player
GitHub renders from a user attachment.

```bash
gh issue edit <host issue> --attach docs/media/demo.mp4   # or gh issue create --attach
gh issue view <n> --json body -q .body                     # the /user-attachments/assets/… URL
```

Paste that URL alone on a line above the GIF. GitHub folds it into a player
(a `<video>` inside a `<details>`); the asset outlives the issue, but keep
one named host issue so the next take has somewhere to land.

## 5. The 9:16 cut (TikTok)

Same pass, recorded in the phone shell instead of the desktop one:

```bash
DEMO_VIEWPORT=640x1138 COCO_URL=http://127.0.0.1:8793 node scripts/record-demo.ts video
```

640 is the widest viewport that still gets the phone layout; the recorder
captures CSS pixels, so `encode` scales the take to 1080x1920 with lanczos.
What `PORTRAIT` changes:

- The card is the first frame (the hero breathes on the app first) and the
  take is trimmed at 1.45 s, so the cover is the card.
- Type for a phone: the name at 92 px, the line at 38 px, a 19 px caption
  centered above the shell's tab bar — clear of TikTok's own chrome, which
  covers the bottom ~300 px of a 1920-tall video.
- The stack beat is dropped: three short rows leave a phone frame empty, so
  the cut ends on the agent's patch instead.
- A taken decision blanks its board for a second while it refetches, so the
  click punches into the next beat rather than waiting on the empty bucket.
- `demo-vertical.mp4` (h264, 1080x1920, ~27 s, ~6 MB) and its cover, no GIF
  and no webm: a feed takes neither.

The clip is silent: the sound is added where it is posted.

## 6. Verify before you push

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1 docs/media/demo.mp4
ls -l docs/media/demo.gif      # under 8 MB
ffmpeg -v error -y -ss 12 -i docs/media/demo.mp4 -frames:v 1 /tmp/frame.png
```

Look at the frames: no black frame anywhere, the caption matches the beat
under it, the ring sits on the element the cursor touches, no checklist or
empty first-run state is in shot.

After the push, check what GitHub actually serves: `github.com/<repo>/raw/…`
caches by path, so a replaced file can keep serving the old bytes for
minutes. A new path (a rename) is how a replaced clip starts showing up.
Then open the repo page and look at the hero and the player.

## 7. Rules

- No black frame: the title, the outro and the cuts are the app plus an
  overlay.
- One pass: no jump to a first-run beat.
- A caption is one line, in the user's voice, and names what is on screen at
  that second.
- The stills come from the same seeded state as the clip, so the README
  table and the hero agree.
- Re-attach the mp4 and update the URL whenever the clip is re-recorded; a
  stale player is worse than none.
