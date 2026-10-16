# Spike 05: OpenTUI React soak with 16 cards

Ticket tutti-nrg.1.5, M0 spike (6) (spec § 14), for § 7.5 Bounded rendering, § 3.5 and § 7.4.

- **Code:** `spikes/opentui-soak/` (its README lists the files). The soak is
  `bun spikes/opentui-soak/run-soak.ts --minutes 30 --window 600|200|unbounded --out <file>`; the
  checks are `bun spikes/opentui-soak/checks.ts` and `bun spikes/opentui-soak/test-utils-check.tsx`;
  `bun spikes/opentui-soak/summarize.ts <files>` makes the tables below.
- **Versions:** `@opentui/core` and `@opentui/react` 0.6.6, React 19.2.9 (`react-reconciler`
  0.33.0), Bun 1.4.3, macOS 26.6.2 on an Apple M1 Pro (10 cores, 16 GB), 2026-10-16/17.
- **Terminal:** a pseudo-terminal from `Bun.Terminal`, 160×50, `TERM=xterm-256color`,
  `COLORTERM=truecolor`. The harness plays the terminal: it answers OSC 10/11 colour queries and
  reads everything the app writes.

## Summary

| Item | Result |
|---|---|
| 30-minute soak, 16 cards at 10 Hz + 600 mounted items | Footprint 136 → 892 MB. **Not flat** |
| … with 200 mounted items | 104 → 557 MB. **Not flat** |
| … unbounded (every item stays mounted, 2,765 at the end) | 134 → 1,946 MB, linear |
| The same with React's production build (`NODE_ENV=production`), 600 items | 121 → 589 MB: level from minute 9 (495 MB), then **+4 MB/min**, slowing |
| … 200 items | 98 → 267 MB: level from minute 4 (233 MB), **+0.6 MB/min** over the last 10 minutes |
| OpenTUI's native memory under the bounds | **Levels off**: 469 MB with 600 items, 172 MB with 200; unbounded it grows 46 MB/min. About **0.75 MB per mounted item** once drawn. Unmounting gives it back to the system |
| What else grows | **React's development build**: about 10 MB/min, whatever the transcript does. It adds a `performance.measure()` entry per component render (React 19.2's Performance Tracks) and Bun keeps them all. With `NODE_ENV=production`, or with the timeline cleared, it stays flat |
| Verdict on § 7.5's bounds | **They hold the transcript's memory, but only with React's production build is the whole app near flat.** At 200 items (the view at the bottom) the footprint settles at ~260 MB and grows 0.6 MB/min; at 600 (scrolled back) it settles near 500 MB and still creeps 3–4 MB/min after 30 minutes, which is acceptable for a view one only visits. In the development build, which `bun src/main.ts` gets, nothing is flat |
| `exitOnCtrlC: false`, `exitSignals: []` | **Work.** Ctrl+C arrives as a key; SIGINT, SIGTERM and SIGHUP reach the app's handlers, and the renderer stays |
| `renderer.destroy()` restores the terminal | **Yes**, termios and every mode but one: **mode 2027 (grapheme clustering) is set at start and never reset** |
| `waitForThemeMode()` and `theme_mode` | **Work.** Dark or light from OSC 11 in about 5 ms; `theme_mode` fires for the first answer and after a DSR 997 report; `waitForThemeMode(1000)` gives `null` after 1 s when the terminal doesn't answer |
| `captureCharFrame`, `captureSpans` at a fixed size | **Work.** Exact size, the same on a second render, colours as asked. `dispose()` makes React warn about `act()` unless it runs inside `act()` |

## 1. The soak

`soak.tsx` mounts one React tree with `createRoot(renderer)` on a renderer made with
`exitOnCtrlC: false`, `exitSignals: []` in `alternate-screen` mode:

- **16 cards** in a 4×4 grid, each a bordered box of three one-line `<text>`s (ID, phase and time;
  title; activity and token count). A producer writes a new `RunView` (`{ tick, cards }`) every
  100 ms in which every card changes.
- **One transcript** `<scrollbox stickyScroll stickyStart="bottom">` under them, starting with 600
  items: Markdown (`<markdown>`, a heading, emphasis, inline code, a list, a link and every third
  one a fenced block), a tool line over a `<code filetype="typescript">` of 8 lines, and a tool line
  over a `<diff>` of a 7-line hunk (`height={12}`), in turn. Each tick appends 24 characters to a
  streamed assistant message (`<markdown streaming>`) at the end; a finished message becomes an
  item (every 4.5 s), and every 10th tick appends another item. That is about 1.25 new items a
  second, 2,160 over 30 minutes: the window turns over more than three times.
- **The bridge of § 3.5:** two external stores (`store.ts`), one for the `RunView` and one for the
  transcript (not part of the `RunView`, as § 3.5 says). A write replaces the snapshot and
  schedules a notification, throttled to 30 Hz; `getSnapshot` returns the same object until the
  next write; React reads each with `useSyncExternalStore`. Cards and items are `memo` components,
  and an item keeps its identity once made.
- **`--window`** is how many items stay mounted: the oldest beyond it are dropped, as § 7.5's
  bounded rendering unmounts them. `600` is the most § 7.5 ever mounts (scrolled back), `200` what
  it mounts at the bottom, `unbounded` the control.

The three runs went side by side for 30 minutes. Each kept its pace: 9.8 producer ticks and 19.6
frames a second on average (every tick commits both stores, so two frames), the unbounded one too
with 2,765 items mounted. The PTY received 2 MB a minute.

### How memory was measured

Once a minute (and at 5 s, minute 0), the app records `process.memoryUsage()`, `bun:jsc`'s
`heapStats()` and `vmmap -summary <pid>` (`memory.ts`):

- **Physical footprint** (vmmap): the process's memory as macOS accounts it, compressed pages
  included. RSS tracks it closely here. Above 1 GB vmmap prints it to 0.1 GB, hence the steps in
  the unbounded run.
- **`VM_ALLOCATE`**: OpenTUI's native memory. Its Zig library has its own general-purpose
  allocator (`getBuildOptions()` reports its `gpaSafeStats`), whose mappings vmmap lists as
  `VM_ALLOCATE`, not as malloc zones. In a run with no transcript it stays at 5 MB, and it moves
  with the transcript alone. (`getAllocatorStats()` covers only span feeds and read 0 throughout.)
- **Memory Tag 240**: Bun's own allocator, under the JS heap, strings, `ArrayBuffer`s and objects;
  allocating each of those in a bare Bun process grows this region and nothing else.
- **JS heap**: `heapStats().heapSize`.

Dirty and compressed ("swapped") sizes are added up per region, since other workers kept the
machine short of memory and macOS compressed much of each process: in a first attempt, which
counted dirty pages alone, they were an eighth of `VM_ALLOCATE`'s share of the footprint.

### Results

The footprint each minute (`1` = 600 items, `2` = 200, `3` = unbounded):

```
 1946 MB |                              3
 1816 MB |                             3
 1686 MB |                         3333
 1556 MB |                       33
 1427 MB |                     33
 1297 MB |                    3
 1167 MB |                3333
 1038 MB |               3
  908 MB |             33          111111
  778 MB |         3333   111111111
  649 MB |        31111111
  519 MB |     3331           22222222222
  389 MB |   331  222222222222
  259 MB | 3322222
  130 MB |32
    0 MB |
         +-------------------------------
          minutes 0..30
```

Every 5 minutes, in MB (every minute is in the appendix):

| min | 600: footprint | native | Tag 240 | 200: footprint | native | Tag 240 | unbounded: footprint | native | Tag 240 | mounted |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 136 | 27 | 91 | 104 | 15 | 73 | 134 | 27 | 89 | 606 |
| 5 | 417 | 236 | 162 | 294 | 144 | 132 | 459 | 254 | 186 | 960 |
| 10 | 611 | 388 | 204 | 348 | 155 | 174 | 749 | 484 | 244 | 1,321 |
| 15 | 691 | 419 | 253 | 399 | 161 | 220 | 1,024 | 713 | 280 | 1,682 |
| 20 | 768 | 439 | 310 | 457 | 166 | 273 | 1,331 | 944 | 370 | 2,043 |
| 25 | 847 | 455 | 373 | 531 | 170 | 342 | 1,638 | 1,153 | 406 | 2,405 |
| 30 | 892 | 469 | 403 | 557 | 172 | 366 | 1,946 | 1,385 | 474 | 2,765 |

("native" is `VM_ALLOCATE`; "mounted" is the unbounded run's, the others mount 601 and 201.) The JS
heap stayed between 16 and 40 MB in the bounded runs, and 26 to 106 MB unbounded.

Two things grow, and they behave differently:

- **OpenTUI's native memory follows the mounted items that have been drawn.** In the 600 run it
  grows like the unbounded run's for the first 8 minutes (42 MB/min), then levels off: +30 MB over
  the last 10 minutes, against +441 MB unbounded. The 200 run levels off after 3 minutes (+6 MB
  over the last 10). The knee is where the window has turned over once: the preloaded items sit
  above the viewport and are never drawn, and every new item is drawn as it scrolls past the
  bottom. At the plateau that is about 0.75 MB per mounted item (442 MB for 600, 157 MB for 200);
  unbounded, 0.63 MB per appended item.
- **Something grows 10 MB/min in every run that has the cards**, in Bun's allocator, not
  OpenTUI's, while the JS heap stays flat. Section 2 finds it: React's development build.

## 2. What grows: the diagnostic runs

Shorter runs, each with one part on (`--cards 0`, `--append-every 0`, `--stream off`, `--preload`),
in the same PTY. Sizes in MB.

| Run | Minutes | Footprint | Native | Tag 240 | Reading |
|---|---:|---|---|---|---|
| Cards only (React) | 30 | 45 → 346 | 5 → 5 | 32 → 333 | 10 MB/min in Bun's allocator |
| … with `Bun.gc(true)` before each sample | 30 | 42 → 326 | 5 → 5 | 30 → 313 | the same: nothing for the GC to free |
| … each line one string, not JSX parts | 10 | 48 → 148 | 5 → 5 | 36 → 135 | the same: not the text-node children |
| … with `NODE_ENV=production` | 10 | 40 → 46 | 5 → 5 | 28 → 33 | **flat** |
| … clearing the performance timeline every 10 s | 10 | 43 → 66 (43–74) | 5 → 5 | 31 → 53 | **flat**, give or take a GC cycle |
| The same 48 texts at 10 Hz through `@opentui/core` alone (`core-text.ts`) | 10 | 32 → 34 | 4 → 4 | 22 → 24 | **flat** |
| Streamed message only | 10 | 63 → 80 | 4 → 5 | 48 → 63 | slow, 1.7 MB/min, with React's development build |
| Static 600-item transcript | 10 | 133 → 129 | 23 → 23 | 93 → 90 | flat |
| Churn: 600 items, one appended a tick (10/s), nothing else | 10 | 135 → 238 | 27 → 96 | 91 → 124 | native levels off at 96 after 6 minutes |
| 600 items for 10 minutes, then 200 | 16 | 125 → 631, then 386 → 434 | 27 → 389, then 166 → 176 | 80 → 222 → 238 | **unmounting gives native memory back** |

**React's development build.** `react-reconciler` 0.33 (React 19.2) in development mode records
"Performance Tracks": a `performance.measure()` for each component render, with a `detail` object,
whenever `console.timeStamp` and `performance.measure` exist, as they do in Bun. Bun keeps every
entry in the timeline: the cards-only run had 885 entries at 5 s, 10,695 at 1 minute and 32,097
at 3 minutes. Bun doesn't set `NODE_ENV`, so `bun src/main.ts` gets the development build.
Production builds (`NODE_ENV=production`) don't record them, and the run is flat.

**Native memory per item.** It isn't the frequently updated texts: the cards (48 texts at 10 Hz)
and the streamed message leave `VM_ALLOCATE` flat. It is the transcript's items, once drawn, and
more of it the longer an item stays on screen while frames are drawn: in the churn run, where an
item is on screen for a fraction of a second, 600 items level off at 69 MB (0.12 MB each); in the
soak, where an item takes a few seconds to scroll through, at 442 MB (0.75 MB each). When items are
unmounted, the memory goes back to the system: going from 600 to 200 items dropped `VM_ALLOCATE`
from 389 to 166 MB within the minute.

## 3. The soak with React's production build

The two bounded soaks again, 30 minutes side by side, with `NODE_ENV=production`, so that only
OpenTUI and the bounds are left. Every 5 minutes, in MB (every minute is in the appendix):

```
  589 MB |                           1111
  550 MB |               111111111111
  510 MB |         111111
  471 MB |        1
  432 MB |       1
  393 MB |      1
  353 MB |     1
  314 MB |    1
  275 MB |            2 2 222222222222222
  236 MB |   122222222 2 2
  196 MB |  22
  157 MB | 2
  118 MB |1
   79 MB |2
   39 MB |
    0 MB |
         +-------------------------------
          minutes 0..30   (1 = 600 items, 2 = 200 items)
```

| min | 600: footprint | native | Tag 240 | JS heap | 200: footprint | native | Tag 240 | JS heap |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 121 | 27 | 77 | 20 | 98 | 15 | 67 | 14 |
| 5 | 343 | 236 | 88 | 22 | 236 | 144 | 75 | 16 |
| 10 | 495 | 389 | 87 | 24 | 242 | 155 | 70 | 16 |
| 15 | 532 | 419 | 94 | 24 | 255 | 161 | 76 | 15 |
| 20 | 547 | 439 | 89 | 21 | 261 | 165 | 77 | 16 |
| 25 | 563 | 455 | 89 | 24 | 263 | 169 | 76 | 16 |
| 30 | 589 | 470 | 99 | 30 | 267 | 172 | 77 | 19 |

- **Bun's allocator is flat** (67 to 99 MB): the 10 MB/min of the development build is gone.
- **OpenTUI's native memory is the same as in the development runs**, minute for minute (469 and
  172 MB at minute 30 there, 470 and 172 here): the bounds alone decide it.
- **What is left grows slowly**, and more slowly as time goes on: with 600 items native memory
  grew 5.0 MB/min from minute 10 to 20 and 3.1 MB/min from 20 to 30; with 200 items 1.0 and
  0.7 MB/min. That is 0.04 and 0.01 MB per appended item. Whether it levels off for good is beyond
  a 30-minute run. tutti mounts 600 items only while you're scrolled back, and unmounting returns
  the memory (§ 2), so the 200-item figure is what a long run pays.

The verdict for § 7.5: **the bounds hold OpenTUI's memory where § 7.5 needs it held**, at about
0.75 MB per mounted item, and the 200/600 numbers can stay, **provided tutti runs React's
production build** (tutti-nrg.26).

## 4. The renderer options

`checks.ts` runs `probe.tsx` in the PTY, once with tutti's options (`exitOnCtrlC: false`,
`exitSignals: []`) and a dark terminal, once with no answer to the colour queries, and three times
with OpenTUI's defaults. 15 of its 16 checks pass; the one that fails is mode 2027.

### `exitOnCtrlC: false` and `exitSignals: []`

| Event | tutti's options | OpenTUI's defaults |
|---|---|---|
| Ctrl+C typed (`\x03` in raw mode) | A key event (`name: "c"`, `ctrl: true`) for the app; the renderer stays | The renderer is destroyed (the key also reaches the app) |
| `kill -INT` | The app's `process.on("SIGINT")` handler runs; the renderer stays | The renderer is destroyed; the app's handler runs too |
| `kill -TERM` | As SIGINT | As SIGINT |
| `kill -HUP` | As SIGINT | (not tried) |

So with tutti's options every signal is the app's to handle, as § 7.4 needs. Two details for
§ 7.4:

- OpenTUI's default `exitSignals` are **SIGINT, SIGTERM, SIGQUIT, SIGABRT, SIGHUP, SIGPIPE,
  SIGBREAK and SIGBUS**, not only SIGINT, SIGTERM and SIGABRT. `exitSignals: []` turns them all off
  (`config.exitSignals || defaults` keeps an empty array).
- The default handler only calls `renderer.destroy()`. The probe then exited 0 because nothing else
  kept Bun's event loop alive; a process with more to do would carry on without its renderer.

### `renderer.destroy()`

After `destroy()` and `await renderer.closed`:

- **termios is restored:** the PTY's local flags were `0x5cf` before the app, `0x47` while it ran
  (raw: no `ICANON`, `ECHO` or `ISIG`) and `0x5cf` again after; `process.stdin.isRaw` is `false`.
- **The alternate screen is left** (`CSI ? 1049 l`) before the app's next write, so what tutti
  prints after `destroy()` lands on the main screen.
- **Every private mode it set is reset but one.** At start it sets 2031 (colour-scheme reports),
  1049, 2027, 2004 (bracketed paste), 1000, 1002, 1003, 1006 (mouse), 2026 (synchronised output)
  and hides the cursor (25), and pushes `modifyOtherKeys` (`CSI > 4 ; 1 m`). `destroy()` resets
  all of them and shows the cursor, **except mode 2027** (grapheme clustering). It sets 2027 even
  though the terminal never answered its `CSI ? 2027 $ p` query. A terminal that supports 2027 is
  left with grapheme clustering on for the shell, whatever it was before; one that doesn't ignores
  the sequence.
- **No query is sent during `destroy()`**, so no answer can arrive after raw mode is off and echo
  onto the shell. At start it sends many: OSC 10 and 11, XTVERSION, cursor position, DECRQM for
  1016, 2027, 2031, 1004, 2004 and 2026, the Kitty keyboard query, OSC 99, OSC 1337, OSC 7501, a
  Kitty graphics query, DA1, OSC 66 and `CSI 14 t`. The Kitty keyboard flags were never pushed,
  since this PTY didn't answer `CSI ? u`.

### `waitForThemeMode()` and `theme_mode`

- At start OpenTUI sends `CSI ? 2031 h` and OSC 10 and 11 queries. `renderer.themeMode` is still
  `null` when `createCliRenderer()` resolves (10 ms); answered with a dark background
  (`rgb:1a1a/1b1b/2626`), `waitForThemeMode(1000)` resolved `"dark"` 3 to 6 ms later. A background
  brighter than mid-grey (brightness > 128) is light, as § 7.11 says.
- `theme_mode` fires for that first answer (`dark`) too, not only for changes.
- A colour-scheme report (`CSI ? 997 ; 2 n`, what terminals with mode 2031 send) makes OpenTUI ask
  OSC 10 and 11 again; answered with a light background, `theme_mode` fired `"light"`. Terminals
  without mode 2031 never send the report, so live switching works only in those that have it.
- With no answer, `waitForThemeMode(1000)` resolved `null` after 1,009 to 1,016 ms. § 7.11's 250 ms
  is ample for a terminal that answers at once, as this PTY did; over ssh the answer takes a round
  trip more.

## 5. `@opentui/react/test-utils`

`test-utils-check.tsx` renders the soak's app (16 cards, 30 items and the streamed message's
start) with `testRender(…, { width: 100, height: 40 })` twice, from the same state:

- `captureCharFrame()` is 40 lines of exactly 100 columns; `captureSpans()` has `cols` 100, `rows`
  40, 40 lines whose spans' widths add up to 100 each, and a cursor.
- Both are **the same on the second render**, after `flush()` and `waitForVisualIdle()`, Markdown,
  code and diff included.
- The spans carry the colours asked for: the `Card 1:` span's `fg` is `#7aa2f7` (`RGBA.toInts()`).
- The transcript is stuck to the bottom in the frame.
- **`dispose()` warns** "An update to Root inside a test was not wrapped in act(…)", even for a
  single `<text>`: the root unmounts from the renderer's `destroy` event, outside `act()`. Disposing
  inside `act()` (`await act(async () => { await setup.dispose() })`) is clean (`act-probe.tsx`).

## 6. Other findings

- **A `<text>` that wraps inside a fixed-height box is drawn over its siblings.** The first cards
  had three `<text>`s in a box of height 5; lines longer than the card wrapped, and the lines were
  drawn on top of each other ("Card01:uBash 0s"). One line per field with `wrapMode="none"` and
  `truncate` cuts each to the width with "..." in the middle (`Card 1: B...k-fast.sh`).
- **A diff whose hunk header miscounts its lines** shows "Error parsing diff: Removed line count did
  not match for hunk at line 3" above the raw text instead of the diff.
- **Many queries at start** (above) are answered by most terminals; any answer that arrives after
  OpenTUI stops listening would reach tutti's input. None did here.

## 7. Against the spec

- **§ 7.5's "why" is not what this version does.** "Native memory grows with many frequently
  updated texts (#1493)": here, frequently updated texts (the cards, the streamed message) leave
  OpenTUI's native memory flat; what grows it is mounted transcript items, about 0.75 MB each once
  drawn, and unmounting gives it back. The bounds are the right fix for that, and § 7.5's numbers
  hold: 200 items cost ~170 MB of native memory, 600 ~470 MB while scrolled back. Follow-up:
  tutti-nrg.27.
- **React's development build grows memory without bound** (10 MB/min with 16 cards), and nothing
  in the spec makes tutti run React's production build. Follow-up: tutti-nrg.26.
- **§ 7.4's list of OpenTUI's default exit signals** is short: it has eight (above). The decision
  (`exitSignals: []`) stands. Follow-up: tutti-nrg.28.
- **Mode 2027 is left set** after `destroy()`; § 7.4 expects the terminal restored. Follow-up:
  tutti-nrg.29.
- § 3.5's bridge (a plain variable, listeners, `useSyncExternalStore`, a 30 Hz throttle) needed
  nothing more, and the `testRender` checks of § 13 work at fixed sizes with `captureSpans()` for
  colours; UI tests should dispose inside `act()` (tutti-nrg.30).

## Appendix: every sample

#### soak-600 (React development build, as for every run without `NODE_ENV`)

| min | footprint | RSS | VM_ALLOCATE | Tag 240 | malloc | JS heap | mounted | appended | ticks | frames |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 136 | 135 | 27 | 91 | 3 | 25 | 601 | 605 | 60 | 120 |
| 1 | 211 | 208 | 66 | 126 | 3 | 28 | 601 | 671 | 604 | 1208 |
| 2 | 251 | 251 | 109 | 124 | 3 | 25 | 601 | 743 | 1195 | 2390 |
| 3 | 346 | 345 | 151 | 176 | 3 | 28 | 601 | 815 | 1793 | 3587 |
| 4 | 361 | 360 | 193 | 149 | 3 | 24 | 601 | 887 | 2370 | 4744 |
| 5 | 417 | 416 | 236 | 162 | 3 | 30 | 601 | 959 | 2960 | 5925 |
| 6 | 484 | 483 | 277 | 188 | 3 | 34 | 601 | 1031 | 3557 | 7118 |
| 7 | 516 | 516 | 320 | 177 | 3 | 29 | 601 | 1103 | 4145 | 8295 |
| 8 | 570 | 569 | 362 | 190 | 3 | 29 | 601 | 1175 | 4728 | 9462 |
| 9 | 609 | 608 | 382 | 207 | 3 | 35 | 601 | 1247 | 5319 | 10644 |
| 10 | 611 | 611 | 388 | 204 | 3 | 22 | 601 | 1319 | 5909 | 11825 |
| 11 | 635 | 635 | 394 | 222 | 3 | 23 | 601 | 1392 | 6498 | 13003 |
| 12 | 642 | 642 | 401 | 222 | 3 | 22 | 601 | 1464 | 7085 | 14178 |
| 13 | 676 | 668 | 406 | 250 | 3 | 40 | 601 | 1536 | 7677 | 15361 |
| 14 | 675 | 674 | 412 | 243 | 3 | 22 | 601 | 1608 | 8266 | 16540 |
| 15 | 691 | 691 | 419 | 253 | 3 | 29 | 601 | 1680 | 8856 | 17721 |
| 16 | 716 | 716 | 426 | 271 | 3 | 30 | 601 | 1752 | 9447 | 18904 |
| 17 | 746 | 744 | 431 | 296 | 3 | 31 | 601 | 1824 | 10039 | 20088 |
| 18 | 741 | 747 | 434 | 287 | 3 | 22 | 601 | 1896 | 10630 | 21270 |
| 19 | 755 | 755 | 437 | 298 | 3 | 31 | 601 | 1969 | 11219 | 22448 |
| 20 | 768 | 769 | 439 | 310 | 3 | 31 | 601 | 2041 | 11812 | 23634 |
| 21 | 781 | 781 | 443 | 319 | 3 | 28 | 601 | 2114 | 12405 | 24820 |
| 22 | 808 | 808 | 446 | 343 | 3 | 22 | 601 | 2186 | 12994 | 25998 |
| 23 | 812 | 811 | 449 | 343 | 3 | 25 | 601 | 2258 | 13582 | 27175 |
| 24 | 819 | 818 | 451 | 348 | 3 | 26 | 601 | 2330 | 14173 | 28357 |
| 25 | 847 | 846 | 455 | 373 | 3 | 22 | 601 | 2402 | 14762 | 29535 |
| 26 | 845 | 845 | 457 | 368 | 3 | 29 | 601 | 2474 | 15358 | 30727 |
| 27 | 889 | 887 | 460 | 409 | 3 | 30 | 601 | 2547 | 15945 | 31902 |
| 28 | 881 | 881 | 463 | 398 | 3 | 38 | 601 | 2619 | 16535 | 33082 |
| 29 | 886 | 885 | 466 | 400 | 3 | 31 | 601 | 2691 | 17127 | 34265 |
| 30 | 892 | 892 | 469 | 403 | 3 | 32 | 601 | 2763 | 17717 | 35447 |

Ended after 30 minutes. Sizes in MB; "VM_ALLOCATE" is OpenTUI's native memory, "Tag 240" Bun's allocator, "malloc" the malloc zones (dirty and compressed).

#### soak-200

| min | footprint | RSS | VM_ALLOCATE | Tag 240 | malloc | JS heap | mounted | appended | ticks | frames |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 104 | 103 | 15 | 73 | 2 | 16 | 201 | 605 | 62 | 123 |
| 1 | 170 | 169 | 54 | 99 | 2 | 23 | 201 | 671 | 606 | 1210 |
| 2 | 219 | 219 | 96 | 105 | 2 | 22 | 201 | 743 | 1196 | 2390 |
| 3 | 269 | 267 | 132 | 119 | 2 | 25 | 201 | 815 | 1805 | 3608 |
| 4 | 270 | 268 | 138 | 114 | 2 | 17 | 201 | 887 | 2373 | 4744 |
| 5 | 294 | 294 | 144 | 132 | 2 | 18 | 201 | 959 | 2964 | 5924 |
| 6 | 323 | 322 | 149 | 156 | 2 | 29 | 201 | 1031 | 3561 | 7120 |
| 7 | 319 | 319 | 151 | 151 | 2 | 19 | 201 | 1103 | 4149 | 8296 |
| 8 | 341 | 338 | 153 | 170 | 2 | 26 | 201 | 1175 | 4731 | 9461 |
| 9 | 349 | 349 | 154 | 177 | 2 | 25 | 201 | 1247 | 5322 | 10643 |
| 10 | 348 | 348 | 155 | 174 | 2 | 18 | 201 | 1320 | 5912 | 11823 |
| 11 | 362 | 362 | 156 | 187 | 2 | 16 | 201 | 1392 | 6501 | 13001 |
| 12 | 372 | 370 | 158 | 195 | 2 | 20 | 201 | 1464 | 7088 | 14175 |
| 13 | 385 | 385 | 160 | 207 | 2 | 17 | 201 | 1536 | 7681 | 15361 |
| 14 | 388 | 390 | 161 | 209 | 2 | 16 | 201 | 1608 | 8270 | 16539 |
| 15 | 399 | 399 | 161 | 220 | 2 | 19 | 201 | 1680 | 8860 | 17720 |
| 16 | 425 | 424 | 162 | 244 | 2 | 24 | 201 | 1753 | 9452 | 18903 |
| 17 | 421 | 421 | 162 | 241 | 2 | 20 | 201 | 1825 | 10044 | 20087 |
| 18 | 439 | 438 | 163 | 257 | 2 | 22 | 201 | 1898 | 10635 | 21270 |
| 19 | 449 | 449 | 165 | 266 | 2 | 16 | 201 | 1970 | 11226 | 22452 |
| 20 | 457 | 457 | 166 | 273 | 2 | 19 | 201 | 2042 | 11818 | 23636 |
| 21 | 484 | 484 | 166 | 299 | 2 | 30 | 201 | 2114 | 12411 | 24823 |
| 22 | 485 | 485 | 167 | 300 | 2 | 22 | 201 | 2186 | 12999 | 26000 |
| 23 | 515 | 514 | 168 | 329 | 2 | 22 | 201 | 2258 | 13587 | 27176 |
| 24 | 503 | 503 | 169 | 315 | 2 | 24 | 201 | 2330 | 14179 | 28360 |
| 25 | 531 | 530 | 170 | 342 | 2 | 24 | 201 | 2402 | 14769 | 29539 |
| 26 | 521 | 521 | 169 | 333 | 2 | 19 | 201 | 2475 | 15364 | 30730 |
| 27 | 524 | 523 | 170 | 335 | 2 | 18 | 201 | 2548 | 15951 | 31904 |
| 28 | 538 | 538 | 171 | 348 | 2 | 18 | 201 | 2620 | 16542 | 33086 |
| 29 | 552 | 551 | 172 | 360 | 2 | 24 | 201 | 2692 | 17133 | 34268 |
| 30 | 557 | 557 | 172 | 366 | 2 | 17 | 201 | 2764 | 17725 | 35452 |

Ended after 30 minutes. Sizes in MB; "VM_ALLOCATE" is OpenTUI's native memory, "Tag 240" Bun's allocator, "malloc" the malloc zones (dirty and compressed).

#### soak-unbounded

| min | footprint | RSS | VM_ALLOCATE | Tag 240 | malloc | JS heap | mounted | appended | ticks | frames |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 134 | 133 | 27 | 89 | 3 | 26 | 606 | 605 | 60 | 120 |
| 1 | 208 | 207 | 69 | 120 | 3 | 28 | 672 | 671 | 605 | 1211 |
| 2 | 258 | 258 | 116 | 124 | 3 | 28 | 744 | 743 | 1196 | 2392 |
| 3 | 346 | 342 | 162 | 165 | 3 | 32 | 816 | 815 | 1795 | 3592 |
| 4 | 412 | 401 | 208 | 185 | 3 | 50 | 888 | 887 | 2373 | 4749 |
| 5 | 459 | 458 | 254 | 186 | 3 | 36 | 960 | 959 | 2965 | 5935 |
| 6 | 493 | 492 | 299 | 174 | 4 | 30 | 1032 | 1031 | 3559 | 7124 |
| 7 | 555 | 554 | 346 | 189 | 4 | 35 | 1104 | 1103 | 4149 | 8303 |
| 8 | 635 | 619 | 391 | 223 | 4 | 39 | 1176 | 1175 | 4731 | 9468 |
| 9 | 724 | 723 | 438 | 266 | 4 | 68 | 1248 | 1247 | 5323 | 10652 |
| 10 | 749 | 746 | 484 | 244 | 4 | 38 | 1321 | 1320 | 5914 | 11836 |
| 11 | 800 | 799 | 530 | 249 | 4 | 40 | 1393 | 1392 | 6503 | 13020 |
| 12 | 843 | 842 | 576 | 246 | 5 | 39 | 1466 | 1465 | 7090 | 14195 |
| 13 | 900 | 899 | 622 | 256 | 5 | 39 | 1538 | 1537 | 7682 | 15380 |
| 14 | 960 | 960 | 669 | 270 | 5 | 44 | 1610 | 1609 | 8272 | 16560 |
| 15 | 1024 | 1014 | 713 | 280 | 5 | 48 | 1682 | 1681 | 8862 | 17745 |
| 16 | 1126 | 1083 | 760 | 303 | 5 | 53 | 1754 | 1753 | 9453 | 18927 |
| 17 | 1126 | 1136 | 806 | 308 | 5 | 46 | 1826 | 1825 | 10045 | 20114 |
| 18 | 1229 | 1258 | 852 | 373 | 6 | 61 | 1899 | 1898 | 10637 | 21297 |
| 19 | 1229 | 1268 | 899 | 347 | 6 | 58 | 1971 | 1970 | 11228 | 22479 |
| 20 | 1331 | 1337 | 945 | 370 | 6 | 70 | 2043 | 2042 | 11821 | 23666 |
| 21 | 1434 | 1429 | 991 | 418 | 6 | 106 | 2115 | 2114 | 12414 | 24854 |
| 22 | 1434 | 1434 | 1037 | 375 | 6 | 54 | 2187 | 2186 | 13002 | 26032 |
| 23 | 1536 | 1489 | 1084 | 382 | 6 | 61 | 2260 | 2259 | 13591 | 27209 |
| 24 | 1536 | 1555 | 1151 | 403 | 7 | 48 | 2332 | 2331 | 14181 | 28393 |
| 25 | 1638 | 1604 | 1153 | 407 | 7 | 56 | 2405 | 2404 | 14771 | 29576 |
| 26 | 1638 | 1688 | 1257 | 443 | 7 | 73 | 2477 | 2476 | 15366 | 30767 |
| 27 | 1741 | 1721 | 1266 | 429 | 7 | 59 | 2549 | 2548 | 15954 | 31944 |
| 28 | 1741 | 1784 | 1271 | 445 | 7 | 51 | 2621 | 2620 | 16545 | 33125 |
| 29 | 1843 | 1834 | 1380 | 450 | 7 | 52 | 2693 | 2692 | 17136 | 34311 |
| 30 | 1946 | 1905 | 1385 | 474 | 7 | 53 | 2765 | 2764 | 17727 | 35494 |

Ended after 30 minutes. Sizes in MB; "VM_ALLOCATE" is OpenTUI's native memory, "Tag 240" Bun's allocator, "malloc" the malloc zones (dirty and compressed).

#### soak-prod-600 (`NODE_ENV=production`)

| min | footprint | RSS | VM_ALLOCATE | Tag 240 | malloc | JS heap | mounted | appended | ticks | frames |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 121 | 121 | 27 | 77 | 3 | 20 | 601 | 605 | 58 | 119 |
| 1 | 166 | 166 | 66 | 82 | 3 | 21 | 601 | 672 | 601 | 1207 |
| 2 | 211 | 211 | 109 | 84 | 3 | 24 | 601 | 744 | 1193 | 2391 |
| 3 | 252 | 252 | 152 | 82 | 3 | 22 | 601 | 816 | 1784 | 3573 |
| 4 | 299 | 299 | 194 | 86 | 3 | 24 | 601 | 888 | 2387 | 4780 |
| 5 | 343 | 343 | 236 | 88 | 3 | 22 | 601 | 960 | 2965 | 5936 |
| 6 | 384 | 384 | 279 | 87 | 3 | 24 | 601 | 1032 | 3554 | 7114 |
| 7 | 431 | 431 | 322 | 91 | 3 | 24 | 601 | 1104 | 4146 | 8297 |
| 8 | 468 | 468 | 363 | 86 | 3 | 21 | 601 | 1177 | 4735 | 9476 |
| 9 | 495 | 495 | 382 | 94 | 3 | 31 | 601 | 1249 | 5326 | 10657 |
| 10 | 495 | 495 | 389 | 87 | 3 | 24 | 601 | 1321 | 5916 | 11838 |
| 11 | 504 | 504 | 394 | 91 | 3 | 27 | 601 | 1394 | 6513 | 13032 |
| 12 | 510 | 510 | 400 | 91 | 3 | 26 | 601 | 1466 | 7105 | 14216 |
| 13 | 513 | 513 | 406 | 88 | 3 | 21 | 601 | 1539 | 7700 | 15405 |
| 14 | 526 | 525 | 412 | 94 | 3 | 21 | 601 | 1612 | 8295 | 16595 |
| 15 | 532 | 532 | 419 | 94 | 3 | 24 | 601 | 1684 | 8889 | 17784 |
| 16 | 536 | 536 | 425 | 92 | 3 | 20 | 601 | 1756 | 9478 | 18962 |
| 17 | 539 | 539 | 430 | 90 | 3 | 21 | 601 | 1829 | 10072 | 20149 |
| 18 | 541 | 541 | 433 | 89 | 3 | 21 | 601 | 1901 | 10662 | 21330 |
| 19 | 545 | 545 | 436 | 89 | 3 | 20 | 601 | 1973 | 11251 | 22508 |
| 20 | 547 | 547 | 439 | 89 | 3 | 21 | 601 | 2045 | 11843 | 23692 |
| 21 | 552 | 551 | 442 | 90 | 3 | 24 | 601 | 2118 | 12433 | 24871 |
| 22 | 556 | 555 | 447 | 90 | 3 | 22 | 601 | 2190 | 13023 | 26052 |
| 23 | 556 | 556 | 449 | 88 | 3 | 21 | 601 | 2262 | 13613 | 27232 |
| 24 | 561 | 560 | 452 | 89 | 3 | 23 | 601 | 2334 | 14204 | 28414 |
| 25 | 563 | 563 | 455 | 89 | 3 | 24 | 601 | 2406 | 14796 | 29597 |
| 26 | 566 | 566 | 458 | 89 | 3 | 20 | 601 | 2478 | 15384 | 30773 |
| 27 | 570 | 569 | 461 | 89 | 3 | 20 | 601 | 2550 | 15974 | 31954 |
| 28 | 577 | 577 | 464 | 94 | 3 | 23 | 601 | 2622 | 16566 | 33138 |
| 29 | 578 | 578 | 467 | 91 | 3 | 23 | 601 | 2695 | 17155 | 34317 |
| 30 | 589 | 589 | 470 | 99 | 3 | 30 | 601 | 2767 | 17747 | 35501 |

Ended after 30 minutes. Sizes in MB; "VM_ALLOCATE" is OpenTUI's native memory, "Tag 240" Bun's allocator, "malloc" the malloc zones (dirty and compressed).

#### soak-prod-200 (`NODE_ENV=production`)

| min | footprint | RSS | VM_ALLOCATE | Tag 240 | malloc | JS heap | mounted | appended | ticks | frames |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 98 | 97 | 15 | 67 | 2 | 14 | 201 | 605 | 59 | 121 |
| 1 | 141 | 141 | 54 | 69 | 2 | 16 | 201 | 672 | 602 | 1206 |
| 2 | 179 | 179 | 97 | 66 | 2 | 15 | 201 | 744 | 1193 | 2389 |
| 3 | 215 | 215 | 131 | 66 | 2 | 15 | 201 | 816 | 1784 | 3570 |
| 4 | 233 | 232 | 138 | 77 | 2 | 18 | 201 | 888 | 2389 | 4781 |
| 5 | 236 | 236 | 144 | 75 | 2 | 16 | 201 | 960 | 2966 | 5935 |
| 6 | 245 | 245 | 149 | 78 | 2 | 23 | 201 | 1032 | 3555 | 7113 |
| 7 | 240 | 240 | 150 | 72 | 2 | 18 | 201 | 1104 | 4146 | 8295 |
| 8 | 241 | 241 | 152 | 72 | 2 | 16 | 201 | 1177 | 4735 | 9473 |
| 9 | 244 | 243 | 153 | 73 | 2 | 18 | 201 | 1249 | 5326 | 10655 |
| 10 | 242 | 242 | 155 | 70 | 2 | 16 | 201 | 1321 | 5917 | 11835 |
| 11 | 254 | 254 | 157 | 79 | 2 | 24 | 201 | 1394 | 6513 | 13029 |
| 12 | 258 | 257 | 158 | 82 | 2 | 30 | 201 | 1466 | 7106 | 14214 |
| 13 | 251 | 250 | 158 | 75 | 2 | 17 | 201 | 1539 | 7700 | 15402 |
| 14 | 256 | 256 | 159 | 79 | 2 | 19 | 201 | 1612 | 8295 | 16591 |
| 15 | 255 | 255 | 161 | 76 | 2 | 15 | 201 | 1684 | 8889 | 17781 |
| 16 | 258 | 259 | 161 | 78 | 2 | 22 | 201 | 1756 | 9478 | 18959 |
| 17 | 268 | 268 | 162 | 88 | 2 | 29 | 201 | 1829 | 10071 | 20145 |
| 18 | 259 | 259 | 163 | 79 | 2 | 17 | 201 | 1901 | 10662 | 21326 |
| 19 | 260 | 260 | 164 | 78 | 2 | 19 | 201 | 1973 | 11250 | 22503 |
| 20 | 261 | 260 | 165 | 77 | 2 | 16 | 201 | 2045 | 11842 | 23687 |
| 21 | 259 | 258 | 166 | 75 | 2 | 15 | 201 | 2118 | 12433 | 24868 |
| 22 | 259 | 259 | 167 | 74 | 2 | 16 | 201 | 2190 | 13023 | 26048 |
| 23 | 260 | 260 | 168 | 74 | 2 | 15 | 201 | 2262 | 13613 | 27230 |
| 24 | 264 | 264 | 168 | 78 | 2 | 22 | 201 | 2334 | 14204 | 28412 |
| 25 | 263 | 263 | 169 | 76 | 2 | 16 | 201 | 2406 | 14796 | 29596 |
| 26 | 267 | 267 | 170 | 79 | 2 | 23 | 201 | 2478 | 15385 | 30773 |
| 27 | 269 | 269 | 170 | 80 | 2 | 20 | 201 | 2550 | 15975 | 31954 |
| 28 | 266 | 266 | 171 | 76 | 2 | 16 | 201 | 2622 | 16566 | 33136 |
| 29 | 267 | 266 | 172 | 77 | 2 | 18 | 201 | 2695 | 17156 | 34316 |
| 30 | 267 | 267 | 172 | 77 | 2 | 19 | 201 | 2767 | 17748 | 35500 |

Ended after 30 minutes. Sizes in MB; "VM_ALLOCATE" is OpenTUI's native memory, "Tag 240" Bun's allocator, "malloc" the malloc zones (dirty and compressed).

