// Effect's HttpClient test layer: each URL's answer scripted, by its href, and every request kept,
// with its headers, so that tests read what was asked for. A URL with no answer gets a 404; an
// answer of "never" never comes, for a time limit under TestClock.
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

/** A scripted answer: its status (200), headers and body (none). */
export interface Answer {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
}

/** A request the layer was sent: its URL, and its headers, lower-case. */
export interface Sent {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** A redirect to `location`, as a 302. */
export const redirect = (location: string): Answer => ({ status: 302, headers: { location } })

/** An HttpClient answering each URL in `answers` as scripted, keeping each request in `sent`. */
export const layer = (
  answers: Readonly<Record<string, Answer | "never">>,
  sent: Array<Sent> = [],
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.suspend(() => {
        sent.push({ url: url.href, headers: { ...request.headers } })
        const answer = Object.hasOwn(answers, url.href) ? answers[url.href] : undefined
        if (answer === "never") return Effect.never
        const {
          status = 200,
          headers = {},
          body,
        } = answer ?? ({ status: 404, body: "404: Not Found" } satisfies Answer)
        const bytes = body === undefined ? null : new Uint8Array(Buffer.from(body))
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(bytes, { status, headers })),
        )
      }),
    ),
  )
