// Transcripts' test layer (§ 3.3): the files in memory, with the live layer's operations. Each
// worker's transcript is kept as the lines messages.jsonl would hold, so what a test reads back has
// been through the file's encoding. Time comes from Effect's Clock, so TestClock moves it.
import { Context, Effect, Layer } from "effect"
import { decodeItem, type Item, makeTranscripts, Transcripts } from "../agent/Transcripts.ts"

/** The files the test layer keeps, for a test to look at. */
export class Files extends Context.Service<
  Files,
  {
    /** The items of the worker's transcript, as messages.jsonl would hold them. */
    messages(worker: string): Effect.Effect<ReadonlyArray<Item>>
    /** What was written to the worker's stderr.log. */
    stderr(worker: string): Effect.Effect<string>
  }
>()("tutti/testing/Transcripts/Files") {}

/**
 * A Transcripts in memory, and Files, to read what it wrote. `earlier` holds the lines each
 * worker's messages.jsonl starts with, as an earlier run left them.
 */
export const layer = (
  earlier: Readonly<Record<string, ReadonlyArray<string>>> = {},
): Layer.Layer<Transcripts | Files> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const lines = new Map<string, Array<string>>(
        Object.entries(earlier).map(([worker, start]) => [worker, [...start]]),
      )
      const stderr = new Map<string, string>()
      const transcripts = yield* makeTranscripts({
        append: (worker, line) => {
          const file = lines.get(worker) ?? []
          file.push(line.replace(/\n$/, ""))
          lines.set(worker, file)
        },
        stderr: (worker, text) => stderr.set(worker, (stderr.get(worker) ?? "") + text),
        linesBackward: (worker) => [...(lines.get(worker) ?? [])].reverse(),
        release: () => {},
      })
      const files = Files.of({
        messages: (worker) =>
          Effect.sync(() =>
            (lines.get(worker) ?? []).flatMap((line) => {
              const item = decodeItem(line)
              return item === undefined ? [] : [item]
            }),
          ),
        stderr: (worker) => Effect.sync(() => stderr.get(worker) ?? ""),
      })
      return Context.make(Transcripts, transcripts).pipe(Context.add(Files, files))
    }),
  )
