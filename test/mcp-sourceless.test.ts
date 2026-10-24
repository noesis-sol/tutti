// A Claude Code that predates mcp_servers' source field (an older --claude) lists servers without
// one: checkInit says it can't tell they are the ones tutti gave, not that workers got servers
// they weren't given (§ 4.6).
import { describe, expect, test } from "bun:test"
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit } from "effect"
import fc from "fast-check"
import {
  type ChosenServers,
  checkInit,
  chromeServer,
  inProcess,
  missingProblem,
  noServersNote,
  notGivenProblem,
  sourcelessProblem,
} from "../src/agent/mcp.ts"

const given: ChosenServers = {
  servers: [
    { name: "postgres", scope: "local", definition: { command: "pg-mcp" } },
    { name: "exa", scope: "project", definition: { type: "sse", url: "https://exa.example" } },
  ],
  note: null,
}

/** checkInit's problems for a system/init listing `servers`: none when it passes. */
const check = async (
  servers: ReadonlyArray<{ name: string; status: string; source?: string }>,
  chosen: ChosenServers = given,
) => {
  const exit = await Effect.runPromise(
    Effect.exit(checkInit({ mcp_servers: [...servers] }, chosen)),
  )
  if (Exit.isSuccess(exit)) return []
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`${exit.cause}`)
  return reason.error.problems
}

describe("checkInit: servers listed without a source", () => {
  test("chosen ones are named as listed without their source, not as not given", async () => {
    const problems = await check([
      { name: "postgres", status: "connected" },
      { name: "exa", status: "pending" },
    ])
    expect(problems).toEqual([sourcelessProblem(["postgres", "exa"])])
    expect(problems.join("\n")).not.toContain("weren't given")
    expect(problems.join("\n")).toContain("--claude")
  })

  test("tutti's own server, and Chrome when chosen, count as chosen", async () => {
    const own = inProcess("tutti", createSdkMcpServer({ name: "tutti" }), true)
    expect(
      await check(
        [
          { name: "tutti", status: "connected" },
          { name: chromeServer, status: "connected" },
        ],
        own,
      ),
    ).toEqual([sourcelessProblem(["tutti", chromeServer])])
  })

  test("one not chosen is still not given; one chosen and missing still missing", async () => {
    expect(
      await check([
        { name: "postgres", status: "connected" },
        { name: "firecrawl", status: "connected" },
      ]),
    ).toEqual([
      notGivenProblem(["firecrawl"]),
      sourcelessProblem(["postgres"]),
      missingProblem(["exa"]),
    ])
    expect(
      await check([{ name: chromeServer, status: "connected" }], {
        servers: [],
        chrome: false,
        note: null,
      }),
    ).toEqual([notGivenProblem([chromeServer])])
    expect(
      await check([{ name: "browserbase", status: "connected" }], {
        servers: [],
        note: noServersNote,
      }),
    ).toEqual([notGivenProblem(["browserbase"])])
  })

  test("any mix of sources names each chosen server without one, once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.constantFrom<string | undefined>("dynamic", "sdk", undefined), {
          minLength: 6,
          maxLength: 6,
        }),
        async (names, sources) => {
          const chosen: ChosenServers = {
            servers: names.map((n) => ({ name: n, scope: "user", definition: { command: n } })),
            note: null,
          }
          const listed = names.map((n, i) => {
            const source = sources[i]
            return source === undefined
              ? { name: n, status: "pending" }
              : { name: n, status: "pending", source }
          })
          const sourceless = names.filter((_, i) => sources[i] === undefined)
          expect(await check([...listed, ...listed], chosen)).toEqual(
            sourceless.length === 0 ? [] : [sourcelessProblem(sourceless)],
          )
        },
      ),
    )
  })
})
