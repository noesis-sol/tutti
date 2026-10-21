// A test that writes what the suites see of the machine to the file TUTTI_FIXTURE_AIRTIGHT names,
// for test/airtight-env.test.ts: where the PATH finds each of the hidden tools and a few others,
// where machineWhich finds the hidden ones, and the names of the variables set. Not named
// *.test.ts, so bun test runs it only when given its path.
import { test } from "bun:test"
import { writeFileSync } from "node:fs"
import { hiddenTools } from "../../../scripts/test.ts"
import { machineWhich, testEnv, which } from "../../env.ts"

test("writes what it sees", () => {
  const tools = [...hiddenTools, "git", "sh", "bun"]
  writeFileSync(
    testEnv.TUTTI_FIXTURE_AIRTIGHT ?? "",
    JSON.stringify({
      which: Object.fromEntries(tools.map((tool) => [tool, which(tool)])),
      machineWhich: Object.fromEntries(hiddenTools.map((tool) => [tool, machineWhich(tool)])),
      variables: Object.keys(testEnv),
      machinePath: testEnv.TUTTI_TEST_MACHINE_PATH ?? null,
    }),
  )
})
