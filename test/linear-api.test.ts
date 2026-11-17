// Linear's API client (tutti-pkqj), the one place tutti sends LINEAR_API_KEY: tutti linear setup's
// teams and states and a run's listing of issues all ask through askLinear, which posts to
// api.linear.app's GraphQL endpoint alone with the key as the Authorization header, reads Linear's
// errors and statuses into a line said without the key, and gives up past its time limit.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Result, Schema } from "effect"
import { HttpClient, HttpClientError } from "effect/http"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  askLinear,
  LinearApi,
  linearEndpoint,
  linearTimedOutWhy,
  readAnswer,
} from "../src/services/LinearApi.ts"
import { liveLinearIssues } from "../src/services/LinearIssues.ts"
import * as TestHttp from "../src/testing/HttpClient.ts"

const key = "lin_api_SECRETsecret0123456789"

const Viewer = Schema.Struct({
  data: Schema.Struct({ viewer: Schema.Struct({ id: Schema.String }) }),
})

describe("LinearApi's live layer", () => {
  const teamsBody = JSON.stringify({
    data: { teams: { nodes: [{ id: "team-eng", key: "ENG", name: "Engineering" }] } },
  })

  /** What `use` gives over an HttpClient answering Linear's endpoint with `answer`, and what it sent. */
  const call = async <A>(
    answer: TestHttp.Answer,
    use: (api: LinearApi["Service"]) => Effect.Effect<A, unknown>,
  ) => {
    const sent: Array<TestHttp.Sent> = []
    const result = await Effect.runPromise(
      Effect.result(Effect.flatMap(LinearApi, use)).pipe(
        Effect.provide(
          LinearApi.layer(key).pipe(
            Layer.provide(TestHttp.layer({ [linearEndpoint]: answer }, sent)),
          ),
        ),
      ),
    )
    return { result, sent }
  }

  test("sends the key to api.linear.app's GraphQL endpoint alone, and reads the teams", async () => {
    const { result, sent } = await call({ body: teamsBody }, (api) => api.teams())
    expect(result).toEqual(Result.succeed([{ id: "team-eng", key: "ENG", name: "Engineering" }]))
    expect(sent.map((each) => each.url)).toEqual(["https://api.linear.app/graphql"])
    expect(sent[0]?.headers.authorization).toBe(key)
  })

  test("reads a team's states", async () => {
    const body = JSON.stringify({
      data: {
        team: {
          states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 1.5 }] },
        },
      },
    })
    const { result } = await call({ body }, (api) => api.states("team-eng"))
    expect(result).toEqual(
      Result.succeed([{ id: "s1", name: "Todo", type: "unstarted", position: 1.5 }]),
    )
  })

  for (const [name, answer, why] of [
    [
      "an authentication error",
      {
        status: 400,
        body: JSON.stringify({
          errors: [
            {
              message: "Authentication required, not authenticated",
              extensions: { code: "AUTHENTICATION_ERROR" },
            },
          ],
        }),
      },
      "Linear refused the key: Authentication required, not authenticated",
    ],
    ["a 401 with no body", { status: 401 }, "Linear refused the key (HTTP 401)"],
    ["a 500", { status: 500, body: "oops" }, "Linear answered HTTP 500"],
    [
      "a 401 with Linear's error",
      { status: 401, body: JSON.stringify({ errors: [{ message: "Invalid API key" }] }) },
      "Linear refused the key: Invalid API key",
    ],
    [
      "another error of Linear's",
      { status: 400, body: JSON.stringify({ errors: [{ message: "Entity not found: Team" }] }) },
      "Linear said: Entity not found: Team",
    ],
    ["an answer of another shape", { body: "{}" }, "Linear's answer isn't what tutti reads"],
  ] as const) {
    test(`fails on ${name}, saying why without the key`, async () => {
      const { result } = await call(answer, (api) => api.teams())
      if (Result.isSuccess(result)) throw new Error("it read the teams")
      expect(result.failure).toMatchObject({ _tag: "LinearApiFailed", why })
      expect(JSON.stringify(result.failure)).not.toContain(key)
    })
  }
})

describe("askLinear", () => {
  test("posts the query and its variables as JSON, with the key and nothing else of tutti's", async () => {
    const sent: Array<TestHttp.Sent> = []
    const answer = { body: JSON.stringify({ data: { viewer: { id: "u1" } } }) }
    const got = await Effect.runPromise(
      askLinear(key, "query Viewer { viewer { id } }", { team: "t" }, Viewer).pipe(
        Effect.provide(TestHttp.layer({ [linearEndpoint]: answer }, sent)),
      ),
    )
    expect(got.data.viewer.id).toBe("u1")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(linearEndpoint)
    expect(sent[0]?.headers.authorization).toBe(key)
    expect(sent[0]?.headers["content-type"]).toBe("application/json")
    expect(Object.keys(sent[0]?.headers ?? {}).filter((name) => name.includes("trace"))).toEqual([])
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      query: "query Viewer { viewer { id } }",
      variables: { team: "t" },
    })
  })

  test("says Linear didn't answer within its time limit, for setup and the pulls alike", async () => {
    const http = TestHttp.layer({ [linearEndpoint]: "never" })
    const timedOut = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.flip(effect))
          yield* TestClock.adjust("30 seconds")
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(TestClock.layer())),
      )
    expect(linearTimedOutWhy).toBe("Linear didn't answer within 30s")
    const teams = await timedOut(
      Effect.flatMap(LinearApi, (api) => api.teams()).pipe(
        Effect.provide(LinearApi.layer(key).pipe(Layer.provide(http))),
      ),
    )
    expect(teams).toMatchObject({ _tag: "LinearApiFailed", why: linearTimedOutWhy })
    const issues = await timedOut(liveLinearIssues({ LINEAR_API_KEY: key }, http).list("NOE", null))
    expect(issues).toMatchObject({ _tag: "LinearApiFailed", why: linearTimedOutWhy })
  })

  test("says it could not reach Linear, without the key", async () => {
    const unreachable = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "connection refused",
            }),
          }),
        ),
      ),
    )
    const failed = await Effect.runPromise(
      Effect.flip(askLinear(key, "query { viewer { id } }", {}, Viewer)).pipe(
        Effect.provide(unreachable),
      ),
    )
    expect(failed.why).toBe(
      `could not reach Linear: Transport: connection refused (POST ${linearEndpoint})`,
    )
    expect(JSON.stringify(failed)).not.toContain(key)
  })
})

describe("readAnswer", () => {
  test("any status and body read as the answer or a reason on one line, never more", () => {
    const errors = fc
      .record({
        message: fc.string(),
        extensions: fc.option(
          fc.record({ code: fc.option(fc.constantFrom("AUTHENTICATION_ERROR", "OTHER")) }),
        ),
      })
      .map((error) => JSON.stringify({ errors: [error] }))
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.oneof(
          fc.string(),
          errors,
          fc.string().map((id) => JSON.stringify({ data: { viewer: { id } } })),
        ),
        (status, body) => {
          const read = readAnswer(status, body, Viewer)
          if (Result.isFailure(read)) {
            expect(read.failure).not.toMatch(/[\n\r]/)
            expect(read.failure.length).toBeLessThan(260)
            expect(read.failure).toMatch(/^Linear/)
          } else {
            expect(status).toBeGreaterThanOrEqual(200)
            expect(status).toBeLessThan(300)
          }
        },
      ),
    )
  })
})
