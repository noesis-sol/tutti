// The counter the fixtures share: a file in a temp folder, named by TUTTI_FIXTURE_COUNTER, that
// counts the runs of a fixture's test, so a fixture can fail on its first run and pass after.
import { existsSync, readFileSync, writeFileSync } from "node:fs"

/** Adds one to the counter and returns the run this is, starting at 1. */
export const countRun = (): number => {
  const file = process.env.TUTTI_FIXTURE_COUNTER
  if (file === undefined) throw new Error("TUTTI_FIXTURE_COUNTER is not set")
  const run = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1
  writeFileSync(file, String(run))
  return run
}
