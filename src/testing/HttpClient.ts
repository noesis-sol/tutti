// Effect's HttpClient test layer: each URL's answer scripted, by its href, and every request kept,
// with its headers and body, so that tests read what was asked for. A URL with no answer gets a
// 404; an answer of "never" never comes, for a time limit under TestClock; a list of answers is
// given in turn, its last again once the list is through.
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

/** A scripted answer: its status (200), headers and body (none). */
export interface Answer {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
}

/** A request the layer was sent: its URL, its headers, lower-case, and its body's text. */
export interface Sent {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** Empty with no body, or one that isn't bytes. */
  readonly body: string
}

/** A redirect to `location`, as a 302. */
export const redirect = (location: string): Answer => ({ status: 302, headers: { location } })

/** An HttpClient answering each URL in `answers` as scripted, keeping each request in `sent`. */
export const layer = (
  answers: Readonly<Record<string, Answer | "never" | ReadonlyArray<Answer>>>,
  sent: Array<Sent> = [],
): Layer.Layer<HttpClient.HttpClient> => {
  // How many requests each URL was sent, for its list of answers.
  const turns = new Map<string, number>()
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.suspend(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
        sent.push({ url: url.href, headers: { ...request.headers }, body })
        const scripted = Object.hasOwn(answers, url.href) ? answers[url.href] : undefined
        const turn = turns.get(url.href) ?? 0
        turns.set(url.href, turn + 1)
        const answer = Array.isArray(scripted)
          ? scripted[Math.min(turn, scripted.length - 1)]
          : scripted
        if (answer === "never") return Effect.never
        const answered = answer ?? ({ status: 404, body: "404: Not Found" } satisfies Answer)
        const { status = 200, headers = {} } = answered
        const bytes =
          answered.body === undefined ? null : new Uint8Array(Buffer.from(answered.body))
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(bytes, { status, headers })),
        )
      }),
    ),
  )
}
