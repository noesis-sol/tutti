// Gates for the suites that don't run by default (§ 13). Use slow.test / slow.describe for tests
// that use real git or other slow tools, run when TUTTI_SLOW=1 (scripts/check-full.sh sets it), and
// live.test / live.describe for contract tests against the real Agent SDK, run when TUTTI_LIVE=1,
// and linearLive.test / linearLive.describe for those against a real Linear team, run when
// TUTTI_LIVE_LINEAR=1 and LINEAR_API_KEY is in the environment.
import { describe, test } from "bun:test"
import { testEnv } from "./env.ts"

const on = (name: string): boolean => testEnv[name] === "1"

export const slow = {
  test: test.skipIf(!on("TUTTI_SLOW")),
  describe: describe.skipIf(!on("TUTTI_SLOW")),
}

export const live = {
  test: test.skipIf(!on("TUTTI_LIVE")),
  describe: describe.skipIf(!on("TUTTI_LIVE")),
}

const linearOn = on("TUTTI_LIVE_LINEAR") && (testEnv.LINEAR_API_KEY ?? "") !== ""

export const linearLive = {
  test: test.skipIf(!linearOn),
  describe: describe.skipIf(!linearOn),
}
