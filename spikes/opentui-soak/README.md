# OpenTUI React soak (M0 spike 6)

The spike for spec § 14's M0 row (6): an `@opentui/react` app with 16 cards updating at 10 Hz over
one `scrollbox` transcript of up to 600 items (Markdown, code and diff elements, `stickyScroll`),
fed through `useSyncExternalStore` stores as § 3.5 describes. The findings are in
[docs/spikes/05-opentui-soak.md](../../docs/spikes/05-opentui-soak.md).

| File | What it is |
|---|---|
| `soak.tsx` | The app. Runs for `--minutes`, writing a memory sample each minute to `--out` (JSON lines) |
| `run-soak.ts` | Runs `soak.tsx` (or `--script core-text.ts`) in a pseudo-terminal (`Bun.Terminal`) of `--cols`×`--rows` (160×50), answering its colour queries, and prints the samples as they arrive |
| `core-text.ts` | The cards' text updates through `@opentui/core` alone, without React, sampled the same way |
| `store.ts` | The external store (throttled to 30 Hz) and the 10 Hz producer |
| `app.tsx` | The React tree: the cards, the transcript |
| `content.ts` | Deterministic Markdown, code and diffs |
| `memory.ts` | The samples: `process.memoryUsage()`, `bun:jsc`'s heap, and on macOS `vmmap -summary` (physical footprint, regions, malloc zones) |
| `summarize.ts` | Turns sample files into the report's tables and chart |
| `checks.ts`, `probe.tsx` | The renderer-option checks: signals, `destroy()`, the theme mode |
| `test-utils-check.tsx` | `captureCharFrame` and `captureSpans` from `@opentui/react/test-utils` at a fixed size |
| `act-probe.tsx` | Why `testRender`'s `dispose()` warns about `act()`, and the way around it |

```sh
bun spikes/opentui-soak/run-soak.ts --minutes 30 --window 600 --out soak-600.jsonl
bun spikes/opentui-soak/run-soak.ts --minutes 30 --window 200 --out soak-200.jsonl
bun spikes/opentui-soak/run-soak.ts --minutes 30 --window unbounded --out soak-unbounded.jsonl
bun spikes/opentui-soak/summarize.ts soak-600.jsonl soak-200.jsonl soak-unbounded.jsonl
bun spikes/opentui-soak/checks.ts
bun spikes/opentui-soak/test-utils-check.tsx --print
```

`--window` is the number of transcript items mounted at most: 200 or 600 as in § 7.5, or
`unbounded` as a control. `--cards 0`, `--append-every 0`, `--stream off` and `--preload N` turn
parts off, to tell which part grows; `--gc`, `--joined-card-text`, `--clear-measures` and
`--shrink-at M` are the diagnostics of the report's § 2 (the header of `soak.tsx` says what each
does). Set `NODE_ENV=production` for React's production build. `soak.tsx` also runs in a real
terminal, without `run-soak.ts`.

`checks.ts` exits 1: one of its 16 checks fails, because OpenTUI leaves mode 2027 set (the
report's § 4).

The spike isn't part of the project's check (`tsconfig.json` and `biome.json` cover `src`, `test`
and `scripts`). To type-check it: `bunx tsc --noEmit -p spikes/opentui-soak`.
