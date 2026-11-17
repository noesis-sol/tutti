// Linear's API, the one place tutti calls Linear itself (tutti-qatu): tutti linear setup reads the
// teams the key reaches and a team's workflow states, to write bd's configuration. Everything else
// tutti does with Linear goes through bd linear (src/services/linearSync.ts). The key is sent to
// api.linear.app and nowhere else, as the Authorization header of a POST to its GraphQL endpoint,
// with no redirect followed, no cookie and no trace header; it is never written down or printed,
// and what Linear answers is said without it.
import { Context, Duration, Effect, Layer, Result, Schema } from "effect"
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
      extensions: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
    }),
  ),
})

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

/** What Linear's errors say, on one line: the first's message. */
const errorsWhy = (body: unknown): string | null => {
  const decoded = Schema.decodeUnknownOption(GraphqlErrors)(body)
  if (decoded._tag === "None") return null
  const first = decoded.value.errors[0]
  if (first === undefined) return null
  const refused = first.extensions?.code === "AUTHENTICATION_ERROR"
  return `${refused ? "Linear refused the key: " : ""}${sanitizeLine(first.message)}`
}

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
          Effect.gen(function* () {
            const request = HttpClientRequest.post(linearEndpoint, {
              headers: { authorization: key, accept: "application/json" },
            }).pipe(
              HttpClientRequest.bodyText(JSON.stringify({ query, variables }), "application/json"),
            )
            const response = yield* client.execute(request)
            const text = yield* response.text
            const json = Result.getOrUndefined(
              Result.try({ try: (): unknown => JSON.parse(text), catch: () => undefined }),
            )
            const said = errorsWhy(json)
            if (response.status === 401 || response.status === 403) {
              return yield* new LinearApiFailed({
                why: said ?? `Linear refused the key (HTTP ${response.status})`,
              })
            }
            if (said !== null) return yield* new LinearApiFailed({ why: said })
            if (response.status < 200 || response.status >= 300) {
              return yield* new LinearApiFailed({ why: `Linear answered HTTP ${response.status}` })
            }
            const decoded = Schema.decodeUnknownOption(schema)(json)
            if (decoded._tag === "None") {
              return yield* new LinearApiFailed({ why: "Linear's answer isn't what tutti reads" })
            }
            return decoded.value
          }).pipe(
            Effect.catchTag("HttpClientError", (error) =>
              Effect.fail(
                new LinearApiFailed({
                  why: `could not reach Linear: ${sanitizeLine(error.reason._tag)}`,
                }),
              ),
            ),
            Effect.timeoutOrElse({
              duration: linearApiTimeLimit,
              orElse: () =>
                Effect.fail(
                  new LinearApiFailed({
                    why: `Linear didn't answer within ${Duration.format(linearApiTimeLimit)}`,
                  }),
                ),
            }),
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.provideService(FetchHttpClient.RequestInit, {
              redirect: "error",
              credentials: "omit",
            }),
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
