// Stands in for a plain run's end in test/closed-stdout.test.ts, its stdout a pipe whose reader
// (head) goes after the first line. As tutti's main, it guards its output first, then prints log
// lines until its reader has gone, then writes its report through the printer: an organ line, the
// report saved to <dir>/report while it is drawn, its final line and the REPORT line, all to the
// closed pipe. Its scope's finalizer, the lock's release, writes <dir>/released. It exits 3.
import { Console, Effect } from "effect"
import { guardOutput, makePrinter, stdout } from "../../../src/print/organLine.ts"
import { runMain } from "../../../src/run/quit.ts"
import { makeTheme, orchestra } from "../../../src/ui/theme.ts"

const dir = process.argv[2]
if (dir === undefined) throw new Error("usage: plain-end.ts <dir>")

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
const printer = makePrinter(stdout, theme)

runMain(
  Effect.gen(function* () {
    yield* guardOutput
    yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(`${dir}/released`, "")))
    // The run's log lines, through Effect's Console, and the printer's, until head has gone.
    for (let i = 0; process.stdout.writable && i < 500; i++) {
      yield* Console.log(`log line ${i}`)
      yield* printer.say(`organ line ${i}`)
      yield* Effect.sleep("20 millis")
    }
    const step = yield* printer.organ("Writing the run report")
    yield* Effect.sleep("300 millis")
    yield* Effect.promise(() => Bun.write(`${dir}/report`, "the report\n"))
    yield* step.done("Run report written")
    yield* printer.say(`REPORT ${dir}/report`)
    yield* Effect.sync(() => {
      process.exitCode = 3
    })
  }).pipe(Effect.scoped),
)
