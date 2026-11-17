// Linear's API, the one place tutti calls Linear itself (tutti-qatu, tutti-pkqj): tutti linear setup
// reads the teams the key reaches and a team's workflow states, to write bd's configuration, and a
// run's pulls list a team's issues (src/services/LinearIssues.ts). Everything else tutti does with
// Linear goes through bd linear (src/services/linearSync.ts). Every request is `sendToLinear`'s, a
// GraphQL one `askLinear`'s: the key, or the OAuth pair's token, is sent to api.linear.app and
// nowhere else, as the Authorization header of a POST to its GraphQL endpoint, with no redirect
// followed, no cookie and no trace header, within linearApiTimeLimit; it is never written down or
// printed, and what Linear answers is said without it, on one line.
import { Context, Duration, Effect, Layer, Option, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { sanitizeLine } from "../text/sanitize.ts"

/** Linear's GraphQL endpoint: the only URL the key is sent to. */
export const linearEndpoint = "https://api.linear.app/graphql"

/** Where a person creates a personal API key in Linear. */
export const linearKeysPage = "https://linear.app/settings/account/security"

/** How long one call to Linear's API may take. */
export const linearApiTimeLimit = Duration.seconds(30)

/** A Linear team the key reaches: its ID (what bd's linear.team_id names), key and name. */
export interface LinearTeam {
  readonly id: string
  /** What its issues' identifiers start with: NOE in NOE-12. */
  readonly key: string
  readonly name: string
}

/** One of a team's workflow states: its type (backlog, unstarted, started, …) and position in it. */
export interface LinearState {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly position: number
}

/** A call to Linear's API that failed: why, said without the key. */
export class LinearApiFailed extends Schema.TaggedError<LinearApiFailed>()("LinearApiFailed", {
  why: Schema.String,
}) {}

const Team = Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String })
const State = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  position: Schema.Number,
})

const GraphqlErrors = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      extensions: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ code: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
      ),
    }),
  ).check(Schema.isMinLength(1)),
})

const Json = Schema.fromJsonString(Schema.Unknown)

const TeamsAnswer = Schema.Struct({
  data: Schema.Struct({ teams: Schema.Struct({ nodes: Schema.Array(Team) }) }),
})

const StatesAnswer = Schema.Struct({
  data: Schema.Struct({
    team: Schema.Struct({ states: Schema.Struct({ nodes: Schema.Array(State) }) }),
  }),
})

// 250 is the most a page of Linear's API holds: no key reaches as many teams, nor a team as many states.
const teamsQuery = "query Teams { teams(first: 250) { nodes { id key name } } }"
const statesQuery =
  "query States($team: String!) { team(id: $team) { states(first: 250) { nodes { id name type position } } } }"

/** At most 200 characters of `text`, on one line: how a reason quotes what Linear wrote. */
export const clip = (text: string): string => {
  const line = sanitizeLine(text.trim().split("\n")[0] ?? "")
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/** Why a call failed when Linear didn't answer within linearApiTimeLimit. */
export const linearTimedOutWhy = `Linear didn't answer within ${Duration.format(linearApiTimeLimit)}`

/**
 * Reads what Linear's API answered, its HTTP status and body, with `schema`: the answer, or why
 * not, on one line: from Linear's first error where it gave one, else from the status.
 */
export const readAnswer = <A>(
  status: number,
  body: string,
  schema: Schema.Decoder<A>,
): Result.Result<A, string> => {
  const json = Schema.decodeUnknownOption(Json)(body)
  const refused = status === 401 || status === 403
  const error = Option.getOrUndefined(
    Option.flatMap(json, Schema.decodeUnknownOption(GraphqlErrors)),
  )?.errors[0]
  if (error !== undefined) {
    const auth = refused || error.extensions?.code === "AUTHENTICATION_ERROR"
    return Result.fail(
      `${auth ? "Linear refused the key" : "Linear said"}: ${clip(error.message) || `HTTP ${status}`}`,
    )
  }
  if (refused) return Result.fail(`Linear refused the key (HTTP ${status})`)
  if (status < 200 || status >= 300) return Result.fail(`Linear answered HTTP ${status}`)
  const answer = Option.flatMap(json, Schema.decodeUnknownOption(schema))
  if (Option.isNone(answer)) return Result.fail("Linear's answer isn't what tutti reads")
  return Result.succeed(answer.value)
}

/** `effect`, failing as Linear not answering past linearApiTimeLimit. */
export const withinLinearTimeLimit = <A, R>(
  effect: Effect.Effect<A, LinearApiFailed, R>,
): Effect.Effect<A, LinearApiFailed, R> =>
  Effect.timeoutOrElse(effect, {
    duration: linearApiTimeLimit,
    orElse: () => Effect.fail(new LinearApiFailed({ why: linearTimedOutWhy })),
  })

/** What Linear answered a request: its HTTP status and body. */
export interface LinearAnswered {
  readonly status: number
  readonly body: string
}

/**
 * What Linear answered `request`, sent through `HttpClient` with no redirect followed, no cookie
 * and no trace header, within linearApiTimeLimit, or why `what` couldn't be reached: every request
 * tutti sends Linear, and with it the key or the OAuth pair.
 */
export const sendToLinear = (
  request: HttpClientRequest.HttpClientRequest,
  what = "Linear",
): Effect.Effect<LinearAnswered, LinearApiFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* Effect.mapError(
      Effect.flatMap(client.execute(request), (response) =>
        Effect.map(response.text, (body) => ({ status: response.status, body })),
      ),
      (error) =>
        new LinearApiFailed({
          why: `could not reach ${what}: ${clip(error.message) || error.reason._tag}`,
        }),
    )
  }).pipe(
    withinLinearTimeLimit,
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" }),
  )

/**
 * The POST of the GraphQL `query` with `variables` to Linear's endpoint, with `authorization` as
 * its Authorization header: the personal API key, or `Bearer` and the OAuth pair's token.
 */
export const graphqlRequest = (
  authorization: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(linearEndpoint, {
    headers: { authorization, accept: "application/json" },
  }).pipe(HttpClientRequest.bodyText(JSON.stringify({ query, variables }), "application/json"))

/**
 * Linear's answer to the GraphQL `query` with `variables`, read with `schema`, asked with the
 * personal API key `key` through `HttpClient`.
 */
export const askLinear = <A>(
  key: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, LinearApiFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const answered = yield* sendToLinear(graphqlRequest(key, query, variables))
    const read = readAnswer(answered.status, answered.body, schema)
    if (Result.isFailure(read)) return yield* new LinearApiFailed({ why: read.failure })
    return read.success
  })

export class LinearApi extends Context.Service<
  LinearApi,
  {
    /** The teams the key reaches, in Linear's order. */
    teams(): Effect.Effect<ReadonlyArray<LinearTeam>, LinearApiFailed>
    /** The team's workflow states, archived ones left out, in Linear's order. */
    states(teamId: string): Effect.Effect<ReadonlyArray<LinearState>, LinearApiFailed>
  }
>()("tutti/services/LinearApi") {
  /** Linear's API with the personal API key `key`, through `HttpClient`. */
  static readonly layer = (key: string): Layer.Layer<LinearApi, never, HttpClient.HttpClient> =>
    Layer.effect(
      LinearApi,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        /** Linear's answer to `query`, decoded with `schema`. */
        const ask = <A>(
          query: string,
          variables: Readonly<Record<string, string>>,
          schema: Schema.Decoder<A>,
        ): Effect.Effect<A, LinearApiFailed> =>
          Effect.provideService(
            askLinear(key, query, variables, schema),
            HttpClient.HttpClient,
            client,
          )
        return LinearApi.of({
          teams: Effect.fn("LinearApi.teams")(() =>
            Effect.map(ask(teamsQuery, {}, TeamsAnswer), (answer) => answer.data.teams.nodes),
          ),
          states: Effect.fn("LinearApi.states")((teamId: string) =>
            Effect.map(
              ask(statesQuery, { team: teamId }, StatesAnswer),
              (answer) => answer.data.team.states.nodes,
            ),
          ),
        })
      }),
    )

  /** Linear's API with the key `key`, over the platform's fetch. */
  static readonly live = (key: string): Layer.Layer<LinearApi> =>
    LinearApi.layer(key).pipe(Layer.provide(FetchHttpClient.layer))
}
