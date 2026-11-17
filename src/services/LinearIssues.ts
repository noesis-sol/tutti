// Linear's issues as Linear's API lists them (tutti-94ru): what a run's pull reads to choose the
// issues it pulls by key (src/run/linearPull.ts), as bd's own pull of a whole team would overwrite
// every linked ticket. One GraphQL query, a page at a time, of the team's issues by key with their
// state's type: those changed since a time, or, with none, those neither completed nor canceled.
// It sends LINEAR_API_KEY to api.linear.app and nothing else; every other call to Linear is bd's.
// Linear wrote what it answers, so it is read leniently: an identifier that isn't a key is left out.
import { Context, Duration, Effect, type Layer, Option, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { linearKeyVariable } from "../core/env.ts"
import { formatDuration } from "../project/configFile.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import { type LinearKey, linearKey } from "./linearSync.ts"

/** Linear's GraphQL endpoint: the one place tutti sends the key. */
export const linearApi = "https://api.linear.app/graphql"

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

/** Why a request didn't reach Linear's API or its answer couldn't be read, in a line. */
const requestWhy = (error: unknown): string =>
  clip(error instanceof Error ? error.message : String(error)) || "the request failed"

/**
 * The source over Linear's API, through `http` (the platform's fetch by default), with the key in
 * `env`: tutti's own environment by default.
 */
export const liveLinearIssues = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
): LinearIssuesSource => ({
  list: (team, since) =>
    Effect.gen(function* () {
      const key = env[linearKeyVariable] ?? ""
      if (key === "") {
        return yield* new LinearListFailed({
          reason: `no ${linearKeyVariable} in the environment to list Linear's issues with`,
        })
      }
      const client = yield* HttpClient.HttpClient
      // A page of the listing, from the one after the cursor `after`, or the first.
      const page = (after: string | null): Effect.Effect<ListedPage, LinearListFailed> =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(linearApi).pipe(
            HttpClientRequest.setHeaders({ authorization: key }),
            HttpClientRequest.bodyText(
              JSON.stringify({ query, variables: { filter: filterOf(team, since), after } }),
              "application/json",
            ),
          )
          const answered = yield* Effect.result(
            Effect.flatMap(client.execute(request), (response) =>
              Effect.map(response.text, (body) => ({ status: response.status, body })),
            ),
          )
          if (Result.isFailure(answered)) {
            return yield* new LinearListFailed({
              reason: `could not reach Linear's API: ${requestWhy(answered.failure)}`,
            })
          }
          const read = readPage(answered.success.status, answered.success.body)
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
})
