# Feature clips

Silent annotated screen recordings on the brochure site: the homepage demo
video (`site/public/media/anmerko-homepage.mp4`, scripted by
`scripts/site/capture-homepage-video.mjs`) and the Features page clips
(`site/public/media/features/*.mp4`, scripted by
`scripts/site/capture-feature-clips.mjs`). Each clip shows one flow in action
in a few seconds: a slow exaggerated cursor, step captions, and the real UI.
No audio, no talking head. Shared machinery lives in
`scripts/site/clip-helpers.mjs`.

## Locked look (v1, approved 2026-09-21)

- Record viewport `1068x668` (`CLIP_VIEWPORT`), encoded to `800x500` H.264
  (`CLIP_SCALE=800:-2`, `-crf 29 -preset veryfast -pix_fmt yuv420p -an
  -movflags +faststart`). Budget: ~10–20s, ~100KB per clip.
- Captions: logged with wall-clock times during recording (`caption()` in
  `clip-helpers.mjs`), then burned into a dedicated 150px panel below the
  picture at encode time via an SRT + libass `subtitles` pass (40px
  Helvetica, two lines allowed, centered in the band). Nothing is ever
  overlaid on the recorded
  pixels, so type can be large and never covers the action. The red cursor
  dot and pulse highlights stay baked in — they are positional, not text.
- In multi-act composites (`composePip`), first-act captions are capped at
  the handoff so two captions never stack.
- Cursor: 34px red dot with white ring and halo, injected as a DOM overlay.
  Every move is a slow glide (~700–1100ms); every click gets a ~450–900ms
  pause around it. Typing uses `pressSequentially` with ~35ms delay so it
  reads on screen. Targets get a pulsing blue outline before selection.
- Display: `.feature-split` grid — text left, video right at half width;
  stacks to video-under-text at `max-width: 800px`. Videos use
  `autoplay muted loop playsinline preload="metadata"`, a 2px themed border
  with radius and shadow, and a poster from `site/public/screenshots/`.

## Recording

Script: `scripts/site/capture-feature-clips.mjs`. Requires a local `ffmpeg`
with libx264 (pass via `FFMPEG=`; the system Homebrew build has broken
dylib links, a known-good static binary is documented in the script history —
re-resolve if it moves). Record one clip or all:

```sh
npm run build
HEADLESS=1 CLIP_VIEWPORT=1068x668 CLIP_SCALE=800:-2 FFMPEG=/path/to/ffmpeg \
  node scripts/site/capture-feature-clips.mjs [element|screenshot|global|component|export]
```

`HEADLESS=1` records in headless bundled Chromium (no window opens) and is
the default for re-captures; omit it for headed debugging. Re-recording after
a UI tweak is just `npm run build` plus the command above — scenario steps
are written against accessible names, so small markup changes usually need no
script edits.

Raw captures (`tasks/feature-clips/raw/<clip>/`, git-ignored) and per-clip
SRTs (`tasks/feature-clips/<clip>.srt`) are kept: caption type, panel, and
other style-only changes re-encode from raw via `encode`/`composePip`
without re-recording the browser. Finished MP4s go to
`site/public/media/features/<name>.mp4`.

Video URLs carry a `?v=` counter (`CLIP_V` in `features.astro`, `DEMO_V`
in `index.astro`): bump it whenever clip bytes change so viewers
and edge caches can never be served a stale copy.

The homepage script also writes `site/public/media/anmerko-homepage.en.vtt`
(caption cues scaled to the finished duration) for the player's captions
track; keep its text in sync with the recorded beats when they change.

## Honesty constraints

- Automation cannot click Chrome's toolbar, so the script loads a temporary
  copy of `dist/` in bundled Chromium (branded Chrome ignores
  `--load-extension` under automation) with two invisible differences:
  `<all_urls>` in `host_permissions` (automation cannot grant activeTab, and
  `tabs.captureVisibleTab` accepts no narrower grant) and a bootstrap hook
  exposing the production `activateTab`. All injection, storage, and UI code
  is production code — every recorded pixel is the production interface.
- Captions describe only what just happened; component paths show only names
  the page actually exposed. Never stage a hint that was not captured live.
- Keep clips silent and dependency-free: no network calls in the page markup
  beyond same-origin `src`/`poster`.

## Terminal recordings (export clip's second act)

`scripts/site/capture-terminal-opencode.mjs` records the real OpenCode TUI:
`opencode` under node-pty, rendered by xterm.js in a Playwright page, joined
to the browser footage with `composePip`. The copied brief is typed into a
fresh prompt as raw keystrokes in ~2s — a bracketed paste would collapse into
a "[Pasted ~N lines]" chip and hide the content, while typing shows every
line arriving. The bytes are exactly the copied brief, and the prompt is
NEVER submitted: no tokens burn and nothing runs.

- One-time setup (kept out of the repo; node-pty is native and finicky):
  `npm install --prefix /tmp/anmerko-term node-pty ws xterm @xterm/addon-fit`
  plus `chmod +x` on the `node-pty` spawn-helper if it loses its bit.
  Override the module location with `XTERM_DIR`.
- Screen capture of Terminal.app is not available to automation here (no
  display capture), which is why the terminal is re-hosted in xterm.js
  instead of filmed natively. The bytes through the PTY are identical either
  way: a real `opencode` process receiving the exact copied bytes as
  keystrokes.
- The export clip's side-by-side is composited (`composePip`): the browser
  and terminal recordings are both real captures, played fullscreen and
  picture-in-picture with an Alt-Tab slide-in. Only the window arrangement
  is staged, never the pixels inside either window.

## Adding or re-recording a clip
1. Add a scenario function following the existing cadence: `setupPage`
   (warm page absorbs slow loads off-camera; its video is discarded) →
   `caption` → `glide` → `clickAt` → `pressSequentially` → closing hold.
2. Hide the overlay during real screenshot drags so it never ends up inside a
   captured crop.
3. Name the output `<feature>.mp4`, reuse an existing poster, and embed with
   the `feature-split` + `feature-clip` pattern (text in the left `div`,
   `figure` on the right).
4. Verify: `npm run site:build`, `npm run site:check`, then confirm the route
   serves the new bytes (`curl …/media/features/<name>.mp4`).
5. For size/format shootouts, stash candidates in `tasks/feature-clips/` and
   extend `tasks/feature-clips/compare.html` (served locally, never merged).
