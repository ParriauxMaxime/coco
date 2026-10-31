---
name: coco-demo-video
description: "Record coco's README media (the demo clip and its stills) against a throwaway demo server seeded with fictional data: title and outro cards, one-line captions, coco's palette, a GIF under 8 MB. Use when the README hero or docs/media has to be re-recorded, or when a feature changes what the demo shows."
argument-hint: "[shots|video|all]"
allowed-tools: Bash, Read, Edit
---

# coco-demo-video

Re-record `docs/media` from a demo coco that lives in `/tmp`, never from the
server you work in. One pass of the app, framed by a title card and an outro
card, with a one-line caption under each beat.

## Scope

- Writes `docs/media/overview.{gif,mp4,webm,jpg}` and `plan.png`,
  `review.png`, `findings.png`, `thread.png`.
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
its `index.mjs` when the repo has none.

The beats, in order: the work and its progress, a decision taken, a PR
reviewed file by file, the findings board with the agent's answer.

## 3. What the recorder draws

The look is a short dark film in coco's palette, not a raw screen capture:
the app runs in its dark theme (`DEMO_THEME=light` records the other one).

- Palette from `docs/media/banner.svg` on a near-black backdrop: cream
  `#f3ecdc`, violet `#7b7bf5`, amber `#f2b84b`, muted `#a9abb6`, film
  `#0b0c10`.
- Title card: the parrot mark, `coco`, "ADE, but your way." in a violet
  accent, a breathing violet/amber glow, and four tilted chips that pop in
  ("one stack, many agents", "decisions you click", "every remark, one
  board", "an agent that answers"). The outro card is the line plus the
  repo chip. Both are page content, so the recording carries them.
- On the app: a vignette that holds the eye on the middle, a violet ring
  around whatever is about to be acted on, a 370 ms dip through the film
  colour between beats, and a caption chip bottom-left — a caps kicker
  (`PLAN`, `DECIDE`, `REVIEW`, `FINDINGS`) over one line.
- Encode: `overview.mp4` (H.264, what GitHub plays), `overview.webm` (VP9),
  a `overview.jpg` poster from the review beat, and `overview.gif` at
  860 px / 8 fps with a palette built from the clip, so the README hero
  stays under 8 MB — dark plus motion needs that headroom.

## 4. Verify before you commit

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1 docs/media/overview.mp4
ls -l docs/media/overview.gif      # under 8 MB
ffmpeg -v error -y -ss 12 -i docs/media/overview.mp4 -frames:v 1 /tmp/frame.png
```

Look at the frames: the cards are the right size, the caption matches the
beat under it, no checklist or empty first-run state is in shot. Then open
the README and watch the GIF play once.

## 5. Rules

- One pass: no cuts, no jump to a first-run beat.
- A caption is one line, in the user's voice, and describes what is on
  screen at that second.
- The stills come from the same seeded state as the clip, so the README
  table and the hero agree.
- Re-record when a beat's screen changes; a stale clip is worse than none.
