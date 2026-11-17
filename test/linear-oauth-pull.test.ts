// A run's pulls list Linear's issues with bd's OAuth pair too (tutti-n1yi): where both halves are
// set, as bd linear does, the pair is exchanged for a token at Linear's token endpoint, with bd's
// scopes so the token bd holds stays, and the token is kept for the run until near its expiry, or
// until Linear answers 401 for it; else LINEAR_API_KEY is sent as before.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import fc from "fast-check"
import {
  credentialOf,
  linearApi,
  linearTokenUrl,
  liveLinearIssues,
  readToken,
  tokenScope,
} from "../src/services/LinearIssues.ts"
import { linearKey } from "../src/services/linearSync.ts"

const pair = { LINEAR_OAUTH_CLIENT_ID: "client-id", LINEAR_OAUTH_CLIENT_SECRET: "client-secret" }

const page = JSON.stringify({
  data: {
    issues: {
      nodes: [{ identifier: "NOE-1", state: { type: "unstarted" } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
})

/** A request the fake Linear was sent: where, its Authorization header, and its body as text. */
interface Sent {
  readonly url: string
  readonly authorization: string | undefined
  readonly body: string
}

/**
 * A fake Linear: the token endpoint answers `tokens` in turn (status and body), the last again
 * after them; the API answers 401 to a token in `refused`, else a page of NOE-1.
 */
const fakeLinear = (
  tokens: ReadonlyArray<readonly [number, unknown]>,
  refused: ReadonlyArray<string> = [],
) => {
  const sent: Array<Sent> = []
  let exchanged = 0
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array()
        const authorization = request.headers.authorization
        sent.push({ url: url.href, authorization, body: new TextDecoder().decode(body) })
        if (url.href === linearTokenUrl) {
          const [status, answer] = tokens[Math.min(exchanged, tokens.length - 1)] ?? [500, {}]
          exchanged += 1
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(answer), { status }),
          )
        }
        const denied = refused.some((token) => authorization === `Bearer ${token}`)
        return HttpClientResponse.fromWeb(
          request,
          denied
            ? new Response(JSON.stringify({ errors: [{ message: "Authentication required" }] }), {
                status: 401,
              })
            : new Response(page, { status: 200 }),
        )
      }),
    ),
  )
  return { sent, http }
}

const token = (value: string, expiresIn = 2_591_999) =>
  [
    200,
    { access_token: value, token_type: "Bearer", expires_in: expiresIn, scope: "read write" },
  ] as const

const NOE1 = [{ key: linearKey("NOE-1"), state: "unstarted" }]

describe("the credential a listing uses", () => {
  test("bd's OAuth pair where both halves are set, over the key; else the key; else none", () => {
    expect(credentialOf({ ...pair, LINEAR_API_KEY: "lin_api_test" })).toEqual({
      _tag: "OAuth",
      clientId: "client-id",
      clientSecret: "client-secret",
    })
    expect(
      credentialOf({ LINEAR_OAUTH_CLIENT_ID: "client-id", LINEAR_API_KEY: "lin_api_test" }),
    ).toEqual({ _tag: "Key", key: "lin_api_test" })
    expect(credentialOf({ ...pair, LINEAR_OAUTH_CLIENT_SECRET: "" })).toBeNull()
    expect(credentialOf({})).toBeNull()
  })
})

describe("Linear's token endpoint's answers", () => {
  test("a token and how long it holds, Linear's error, an HTTP status, or no token, as why", () => {
    expect(readToken(200, JSON.stringify(token("t-1")[1]))).toEqual(
      Result.succeed({ token: "t-1", expiresIn: 2_591_999 }),
    )
    expect(
      readToken(
        400,
        JSON.stringify({
          error: "invalid_client",
          error_description: "Client authentication failed",
        }),
      ),
    ).toEqual(Result.fail("Linear refused the OAuth pair: Client authentication failed"))
    expect(readToken(401, JSON.stringify({ error: "invalid_client" }))).toEqual(
      Result.fail("Linear refused the OAuth pair: invalid_client"),
    )
    expect(readToken(502, "<html>down</html>")).toEqual(
      Result.fail("Linear's token endpoint answered HTTP 502"),
    )
    expect(readToken(200, JSON.stringify({ access_token: "", expires_in: 10 }))).toEqual(
      Result.fail("Linear's token endpoint answered with no token"),
    )
  })

  test("any body reads as a token or a reason on one line, never more", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.oneof(
          fc.string(),
          fc
            .record({ access_token: fc.string(), expires_in: fc.integer() })
            .map((answer) => JSON.stringify(answer)),
          fc
            .record({ error: fc.string(), error_description: fc.string() })
            .map((answer) => JSON.stringify(answer)),
        ),
        (status, body) => {
          const read = readToken(status, body)
          if (Result.isFailure(read)) expect(read.failure).not.toMatch(/[\n\r]/)
          else expect(read.success.token).not.toBe("")
        },
      ),
    )
  })
})

describe("the live source with bd's OAuth pair", () => {
  test("exchanges the pair once, with bd's scope, and lists with the token for the run", async () => {
    const linear = fakeLinear([token("t-1")])
    const source = liveLinearIssues({ ...pair, LINEAR_API_KEY: "lin_api_test" }, linear.http)
    expect(await Effect.runPromise(source.list("NOE", null))).toEqual(NOE1)
    expect(await Effect.runPromise(source.list("NOE", 60_000))).toEqual(NOE1)
    expect(linear.sent.map((each) => [each.url, each.authorization])).toEqual([
      [linearTokenUrl, undefined],
      [linearApi, "Bearer t-1"],
      [linearApi, "Bearer t-1"],
    ])
    const form = new URLSearchParams(linear.sent[0]?.body ?? "")
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id",
      client_secret: "client-secret",
      scope: tokenScope,
      actor: "application",
    })
    expect(tokenScope).toBe("read,write")
    // The secret goes to the token endpoint alone.
    for (const each of linear.sent.slice(1)) expect(each.body).not.toContain("client-secret")
  })

  test("exchanges it again for a token near its expiry", async () => {
    const linear = fakeLinear([token("t-1", 60), token("t-2")])
    const source = liveLinearIssues(pair, linear.http)
    await Effect.runPromise(source.list("NOE", null))
    await Effect.runPromise(source.list("NOE", null))
    await Effect.runPromise(source.list("NOE", null))
    expect(linear.sent.map((each) => each.authorization ?? each.url)).toEqual([
      linearTokenUrl,
      "Bearer t-1",
      linearTokenUrl,
      "Bearer t-2",
      "Bearer t-2",
    ])
  })

  test("a token Linear answers 401 for is exchanged again, and the page asked once more", async () => {
    const linear = fakeLinear([token("t-1"), token("t-2")], ["t-1"])
    const source = liveLinearIssues(pair, linear.http)
    expect(await Effect.runPromise(source.list("NOE", null))).toEqual(NOE1)
    expect(linear.sent.map((each) => each.authorization ?? each.url)).toEqual([
      linearTokenUrl,
      "Bearer t-1",
      linearTokenUrl,
      "Bearer t-2",
    ])
    // Refused again, the listing fails with Linear's word rather than ask a third time.
    const refused = fakeLinear([token("t-1")], ["t-1"])
    const failed = await Effect.runPromise(
      Effect.flip(liveLinearIssues(pair, refused.http).list("NOE", null)),
    )
    expect(failed.reason).toBe("Linear's API said: Authentication required")
    expect(refused.sent).toHaveLength(4)
  })

  test("a refused exchange fails the listing, asks Linear's API nothing, and keeps nothing", async () => {
    const linear = fakeLinear([
      [400, { error: "invalid_client", error_description: "Client authentication failed" }],
      token("t-2"),
    ])
    const source = liveLinearIssues(pair, linear.http)
    const failed = await Effect.runPromise(Effect.flip(source.list("NOE", null)))
    expect(failed.reason).toBe("Linear refused the OAuth pair: Client authentication failed")
    expect(failed.reason).not.toContain("client-secret")
    expect(linear.sent.map((each) => each.url)).toEqual([linearTokenUrl])
    expect(await Effect.runPromise(source.list("NOE", null))).toEqual(NOE1)
  })
})
