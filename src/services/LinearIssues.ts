// Linear's issues as Linear's API lists them (tutti-94ru): what a run's pull reads to choose the
// issues it pulls by key (src/run/linearPull.ts), as bd's own pull of a whole team would overwrite
// every linked ticket. One GraphQL query, a page at a time, of the team's issues by key with their
// state's type: those changed since a time, or, with none, those neither completed nor canceled.
// It authenticates as bd linear does (tutti-n1yi): with bd's OAuth pair where both halves are set,
// exchanged for a token kept for the run, else with LINEAR_API_KEY; it sends them to api.linear.app
// and nothing else, and every other call to Linear is bd's. Linear wrote what it answers, so it is
// read leniently: an identifier that isn't a key is left out.
import { Clock, Context, Duration, Effect, type Layer, Option, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { linearCredentials, linearKeyVariable, linearOAuthVariables } from "../core/env.ts"
import { formatDuration } from "../project/configFile.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import { type LinearKey, linearKey } from "./linearSync.ts"

/** Linear's GraphQL endpoint: the one place tutti sends the key. */
export const linearApi = "https://api.linear.app/graphql"

/** Linear's OAuth token endpoint, where the OAuth pair is exchanged for a token. */
export const linearTokenUrl = "https://api.linear.app/oauth/token"

/**
 * The scope the pair's token asks for: bd's own. Linear keeps a client's tokens of the same scopes
 * side by side, where a token of other scopes would replace the one bd holds.
 */
export const tokenScope = "read,write"

/** How long before its expiry a token is exchanged again, as bd does. */
export const tokenMargin: Duration.Duration = Duration.minutes(5)

/** How long a whole listing may take, every page of it. */
export const listTimeLimit: Duration.Duration = Duration.seconds(30)

/** How many issues a page asks for: Linear's most. */
const pageSize = 250

/** A Linear issue, as a pull chooses by it. */
export interface ListedIssue {
  readonly key: LinearKey
  /** Its workflow state's type: backlog, unstarted (Todo), started, completed, canceled, triage. */
  readonly state: string
}

/** Linear's API couldn't list the team's issues: no key, the request failed, or its answer. */
export class LinearListFailed extends Schema.TaggedError<LinearListFailed>()("LinearListFailed", {
  /** Why, in a line. */
  reason: Schema.String,
}) {}

/** Lists a Linear team's issues. */
export interface LinearIssuesSource {
  /**
   * The issues of the team whose key is `team`: those changed since `since`, in ms since the epoch,
   * or, with null, every one neither completed nor canceled.
   */
  readonly list: (
    team: string,
    since: number | null,
  ) => Effect.Effect<ReadonlyArray<ListedIssue>, LinearListFailed>
}

/** Where a run lists Linear's issues from: none unless its layers give one (src/main.ts). */
export const LinearIssues = Context.Reference<LinearIssuesSource | null>(
  "tutti/services/LinearIssues",
  { defaultValue: () => null },
)

const query = `query TuttiPull($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: ${pageSize}, after: $after) {
    nodes { identifier state { type } }
    pageInfo { hasNextPage endCursor }
  }
}`

/** The query's filter: the team's issues changed since `since`, or those not done with null. */
export const filterOf = (team: string, since: number | null) => ({
  team: { key: { eq: team } },
  ...(since === null
    ? { state: { type: { nin: ["completed", "canceled"] } } }
    : { updatedAt: { gt: new Date(since).toISOString() } }),
})

const Page = Schema.Struct({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          identifier: Schema.String,
          state: Schema.optionalKey(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
        }),
      ),
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    }),
  }),
})

const Errors = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ message: Schema.String })).check(Schema.isMinLength(1)),
})

const Json = Schema.fromJsonString(Schema.Unknown)

/** A page of the listing: its issues, and the cursor of the next page, or null after the last. */
export interface ListedPage {
  readonly issues: ReadonlyArray<ListedIssue>
  readonly next: string | null
}

/** At most 200 characters of `text`, on one line. */
const clip = (text: string): string => {
  const line = sanitizeLine(text.trim().split("\n")[0] ?? "")
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * Reads what Linear's API answered a page's request with, its HTTP status and body: the page, or
 * why not, from Linear's first error where it gave one.
 */
export const readPage = (status: number, body: string): Result.Result<ListedPage, string> => {
  const json = Schema.decodeUnknownOption(Json)(body)
  const errors = Option.flatMap(json, Schema.decodeUnknownOption(Errors))
  if (Option.isSome(errors)) {
    const said = clip(errors.value.errors[0]?.message ?? "")
    return Result.fail(`Linear's API said: ${said || `HTTP ${status}`}`)
  }
  if (status < 200 || status >= 300) return Result.fail(`Linear's API answered HTTP ${status}`)
  const page = Option.flatMap(json, Schema.decodeUnknownOption(Page))
  if (Option.isNone(page)) return Result.fail("Linear's API answered with no list of issues")
  const { nodes, pageInfo } = page.value.data.issues
  const issues = nodes.flatMap((node) => {
    const key = linearKey(node.identifier)
    return key === undefined ? [] : [{ key, state: node.state?.type ?? "" }]
  })
  const next = pageInfo.hasNextPage ? (pageInfo.endCursor ?? null) : null
  return Result.succeed({ issues, next })
}

/** What a listing authenticates with: the API key, or bd's OAuth pair, which bd takes over it. */
export type Credential =
  | { readonly _tag: "Key"; readonly key: string }
  | { readonly _tag: "OAuth"; readonly clientId: string; readonly clientSecret: string }

/** The credential in `env` bd linear would use, or null with neither the key nor the whole pair. */
export const credentialOf = (
  env: Readonly<Record<string, string | undefined>>,
): Credential | null => {
  const set = linearCredentials(env)
  const [clientId, clientSecret] = linearOAuthVariables.map((name) => set[name])
  if (clientId !== undefined && clientSecret !== undefined) {
    return { _tag: "OAuth", clientId, clientSecret }
  }
  const key = set[linearKeyVariable]
  return key === undefined ? null : { _tag: "Key", key }
}

const TokenAnswer = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number })

const TokenError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
})

/** A token of the OAuth pair, and how long it holds, in seconds. */
export interface Token {
  readonly token: string
  readonly expiresIn: number
}

/**
 * Reads what Linear's token endpoint answered the pair's exchange with, its HTTP status and body:
 * the token, or why not, from Linear's error where it gave one.
 */
export const readToken = (status: number, body: string): Result.Result<Token, string> => {
  const json = Schema.decodeUnknownOption(Json)(body)
  const error = Option.flatMap(json, Schema.decodeUnknownOption(TokenError))
  if (Option.isSome(error)) {
    const said = clip(error.value.error_description ?? "") || clip(error.value.error)
    return Result.fail(`Linear refused the OAuth pair: ${said || `HTTP ${status}`}`)
  }
  if (status < 200 || status >= 300) {
    return Result.fail(`Linear's token endpoint answered HTTP ${status}`)
  }
  const answer = Option.flatMap(json, Schema.decodeUnknownOption(TokenAnswer))
  if (Option.isNone(answer) || answer.value.access_token === "") {
    return Result.fail("Linear's token endpoint answered with no token")
  }
  return Result.succeed({ token: answer.value.access_token, expiresIn: answer.value.expires_in })
}

/** Why a request didn't reach Linear's API or its answer couldn't be read, in a line. */
const requestWhy = (error: unknown): string =>
  clip(error instanceof Error ? error.message : String(error)) || "the request failed"

/**
 * The source over Linear's API, through `http` (the platform's fetch by default), with the
 * credential in `env`: tutti's own environment by default. The OAuth pair's token is kept for the
 * source's life, a run's, until `tokenMargin` before it expires, or Linear answers 401 for it: then
 * the page is asked again once, with a new token.
 */
export const liveLinearIssues = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
): LinearIssuesSource => {
  // The pair's token and when it expires, in ms since the epoch; a run's pulls never overlap.
  let held: { readonly token: string; readonly expires: number } | null = null
  return {
    list: (team, since) =>
      Effect.gen(function* () {
        const credential = credentialOf(env)
        if (credential === null) {
          return yield* new LinearListFailed({
            reason: `no ${linearKeyVariable} (nor ${linearOAuthVariables.join(" and ")}) in the environment to list Linear's issues with`,
          })
        }
        const client = yield* HttpClient.HttpClient
        // The status and body `request` was answered with, or why it wasn't.
        const send = (request: HttpClientRequest.HttpClientRequest, what: string) =>
          Effect.result(
            Effect.flatMap(client.execute(request), (response) =>
              Effect.map(response.text, (body) => ({ status: response.status, body })),
            ),
          ).pipe(
            Effect.flatMap((answered) =>
              Result.isSuccess(answered)
                ? Effect.succeed(answered.success)
                : Effect.fail(
                    new LinearListFailed({
                      reason: `could not reach ${what}: ${requestWhy(answered.failure)}`,
                    }),
                  ),
            ),
          )
        // What the Authorization header carries: the key, or the pair's token, exchanged anew where
        // none is held or the one held is near its expiry.
        const authorization = Effect.gen(function* () {
          if (credential._tag === "Key") return credential.key
          const now = yield* Clock.currentTimeMillis
          if (held !== null && now < held.expires - Duration.toMillis(tokenMargin)) {
            return `Bearer ${held.token}`
          }
          held = null
          const request = HttpClientRequest.post(linearTokenUrl).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "client_credentials",
              client_id: credential.clientId,
              client_secret: credential.clientSecret,
              scope: tokenScope,
              actor: "application",
            }),
          )
          const answered = yield* send(request, "Linear's token endpoint")
          const read = readToken(answered.status, answered.body)
          if (Result.isFailure(read)) return yield* new LinearListFailed({ reason: read.failure })
          held = { token: read.success.token, expires: now + read.success.expiresIn * 1000 }
          return `Bearer ${held.token}`
        })
        // A page of the listing, from the one after the cursor `after`, or the first.
        const page = (after: string | null): Effect.Effect<ListedPage, LinearListFailed> =>
          Effect.gen(function* () {
            const ask = Effect.flatMap(authorization, (value) =>
              send(
                HttpClientRequest.post(linearApi).pipe(
                  HttpClientRequest.setHeaders({ authorization: value }),
                  HttpClientRequest.bodyText(
                    JSON.stringify({ query, variables: { filter: filterOf(team, since), after } }),
                    "application/json",
                  ),
                ),
                "Linear's API",
              ),
            )
            let answered = yield* ask
            if (answered.status === 401 && credential._tag === "OAuth") {
              held = null
              answered = yield* ask
            }
            const read = readPage(answered.status, answered.body)
            if (Result.isFailure(read)) return yield* new LinearListFailed({ reason: read.failure })
            return read.success
          })
        const issues: Array<ListedIssue> = []
        let after: string | null = null
        do {
          const read: ListedPage = yield* page(after)
          issues.push(...read.issues)
          after = read.next
        } while (after !== null)
        return issues
      }).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provide(http),
        Effect.timeoutOrElse({
          duration: listTimeLimit,
          orElse: () =>
            Effect.fail(
              new LinearListFailed({
                reason: `Linear's API took longer than ${formatDuration(listTimeLimit)}`,
              }),
            ),
        }),
      ),
  }
}
