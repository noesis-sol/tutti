// The Beads service (§ 3.3): every bd call a run makes, each through exec with orchestra's limits
// (30 s for a read, 2 min for an update), and bd's --json output decoded with Schema into Issues.
// A read is judged by its output, as orchestra's are: a list that decodes is bd's answer even when
// bd exits non-zero over something beside the read. An update is judged by its exit code.
import {
  Context,
  type Duration,
  Effect,
  type FileSystem,
  Layer,
  Option,
  Result,
  Schema,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { formatDuration } from "../project/configFile.ts"
import {
  type Command,
  defaultMaxOutputBytes,
  exec,
  type Output,
  outputCut,
  showCommand,
  TimeLimit,
} from "./exec.ts"

/** bd's built-in statuses; a project may configure more, so any other string can come back too. */
export type Status =
  | "open"
  | "in_progress"
  | "blocked"
  | "deferred"
  | "closed"
  | "pinned"
  | "hooked"
  | (string & {})

/** How one issue links to another; bd has more types than these, which come back as written. */
export type DependencyType =
  | "blocks"
  | "parent-child"
  | "discovered-from"
  | "related"
  | (string & {})

/** A link from an issue to one it depends on (or, from `dependencies(id, "up")`, one depending on it). */
export interface Dependency {
  readonly id: string
  readonly type: DependencyType
  /** The issue at the other end, as bd show and bd dep list give it; bd ready and bd list don't. */
  readonly issue?: Issue
}

export interface Issue {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly design: string
  readonly acceptance: string
  readonly notes: string
  readonly status: Status
  /** 0 (critical) to 4 (backlog); absent when bd gives none. */
  readonly priority?: number
  /** bd's issue type: task, bug, feature, epic, chore, … */
  readonly type: string
  readonly assignee: string
  readonly labels: ReadonlyArray<string>
  /** The issue this one is a subticket of (a parent-child link). */
  readonly parent?: string
  readonly dependencies: ReadonlyArray<Dependency>
  /** The custom metadata, an object; bd gives it as one or as one encoded in a string. */
  readonly metadata: Readonly<Record<string, unknown>>
  /** The files the metadata lists under `files`, in any of the forms `metadataList` reads. */
  readonly files: ReadonlyArray<string>
  /** The files the predictor expects the ticket to change, under `predicted_files`. */
  readonly predictedFiles: ReadonlyArray<string>
  /** RFC 3339. */
  readonly createdAt: string
  /** When a ticket deferred until a date is due again, RFC 3339. */
  readonly deferUntil?: string
  /** What was said as the ticket closed. */
  readonly closeReason: string
}

/** The metadata keys tutti reads, shared with orchestra (§ 11). */
export const MetadataKey = {
  files: "files",
  predictedFiles: "predicted_files",
} as const

/** The label of a question for the maintainer (§ 2). */
export const HumanLabel = "human"

/** bd exited with a code other than 0, or couldn't be started (127). */
export class BeadsFailed extends Schema.TaggedError<BeadsFailed>()("BeadsFailed", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
  /** bd has no issue by the ID it was given, as one deleted from it, rather than failing to say. */
  noSuchIssue: Schema.Boolean,
}) {}

/** bd ran past its time limit, and its process group was killed. */
export class BeadsTimedOut extends Schema.TaggedError<BeadsTimedOut>()("BeadsTimedOut", {
  command: Schema.String,
  timeLimit: Schema.Duration,
}) {}

/** bd's output didn't decode into what the command gives. */
export class BeadsUnreadable extends Schema.TaggedError<BeadsUnreadable>()("BeadsUnreadable", {
  command: Schema.String,
  reason: Schema.String,
  /** The start of the output, for the log. */
  output: Schema.String,
}) {}

export type BeadsError = BeadsFailed | BeadsTimedOut | BeadsUnreadable

/** What bd said of its failure, in a few words. */
export const beadsWhy = (error: BeadsError): string => {
  switch (error._tag) {
    case "BeadsFailed":
      return (error.stderr.trim().split("\n")[0] ?? "") || `exit code ${error.exitCode}`
    case "BeadsTimedOut":
      return `bd took longer than ${formatDuration(error.timeLimit)}`
    case "BeadsUnreadable":
      return error.reason
  }
}

// bd's JSON, as far as tutti reads it. Unknown keys are dropped, and a missing or null text is "".
const Text = Schema.optionalKey(Schema.NullOr(Schema.String))

const issueFields = {
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  description: Text,
  design: Text,
  acceptance_criteria: Text,
  notes: Text,
  issue_type: Text,
  assignee: Text,
  parent: Text,
  created_at: Text,
  defer_until: Text,
  close_reason: Text,
  priority: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  labels: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  metadata: Schema.optionalKey(Schema.Unknown),
}

/** A dependency as bd ready and bd list give it: a link. */
const BdLink = Schema.Struct({
  issue_id: Text,
  depends_on_id: Schema.String,
  type: Schema.String,
})

/** A dependency as bd show and bd dep list give it: the linked issue, with the link's type. */
const BdLinkedIssue = Schema.Struct({ ...issueFields, dependency_type: Schema.String })

const BdIssue = Schema.Struct({
  ...issueFields,
  dependencies: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Union([BdLink, BdLinkedIssue]))),
  ),
})

type BdFields = Schema.Schema.Type<typeof BdLinkedIssue> | Schema.Schema.Type<typeof BdIssue>

const Json = Schema.fromJsonString(Schema.Unknown)
/** bd's v2 envelope, `{schema_version, data}`; BD_JSON_ENVELOPE=0 asks for the bare payload. */
const Envelope = Schema.Struct({ data: Schema.Unknown })
const MetadataObject = Schema.Record(Schema.String, Schema.Unknown)
const Metadata = Schema.Union([MetadataObject, Schema.fromJsonString(MetadataObject)])
const Paths = Schema.Array(Schema.String)
const PathsInString = Schema.fromJsonString(Paths)
/** What bd --json prints on stdout as it fails. */
const BdError = Schema.fromJsonString(Schema.Struct({ error: Schema.String }))

/** The error bd show --json gives for an ID it has no issue for (bd 1.3). */
export const noSuchIssueError = "no issues found matching the provided IDs"

/** The metadata as an object: {} when it is neither an object nor one encoded in a string. */
const metadataOf = (raw: unknown): Readonly<Record<string, unknown>> =>
  raw === undefined ? {} : Option.getOrElse(Schema.decodeUnknownOption(Metadata)(raw), () => ({}))

/**
 * The paths the metadata lists at key, as orchestra reads them: a list, a list encoded in a string,
 * or a string of paths separated by commas or white space (`--set-metadata files=a.ts,b.ts`).
 */
export const metadataList = (
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<string> => {
  const value = Object.hasOwn(metadata, key) ? metadata[key] : undefined
  const list = Schema.decodeUnknownOption(Paths)(value)
  if (Option.isSome(list)) return list.value
  if (typeof value !== "string") return []
  if (value.trim().startsWith("[")) {
    const inString = Schema.decodeUnknownOption(PathsInString)(value)
    if (Option.isSome(inString)) return inString.value
  }
  // A list that isn't quite JSON (["a.ts", 'b.ts'), a missing bracket) leaves its quotes and brackets
  // on the words it splits into: they aren't part of any path.
  return value
    .split(/[,\s]+/)
    .map((word) => word.replace(/^["'`[\]]+|["'`[\]]+$/g, ""))
    .filter((word) => word !== "")
}

const text = (value: string | null | undefined): string => value ?? ""

const toIssue = (bd: BdFields, dependencies: ReadonlyArray<Dependency>): Issue => {
  const metadata = metadataOf(bd.metadata)
  const parent =
    text(bd.parent) || dependencies.find((dependency) => dependency.type === "parent-child")?.id
  return {
    id: bd.id,
    title: bd.title,
    description: text(bd.description),
    design: text(bd.design),
    acceptance: text(bd.acceptance_criteria),
    notes: text(bd.notes),
    status: bd.status,
    ...(typeof bd.priority === "number" ? { priority: bd.priority } : {}),
    type: text(bd.issue_type),
    assignee: text(bd.assignee),
    labels: bd.labels ?? [],
    ...(parent ? { parent } : {}),
    dependencies,
    metadata,
    files: metadataList(metadata, MetadataKey.files),
    predictedFiles: metadataList(metadata, MetadataKey.predictedFiles),
    createdAt: text(bd.created_at),
    ...(bd.defer_until ? { deferUntil: bd.defer_until } : {}),
    closeReason: text(bd.close_reason),
  }
}

const fromBd = (bd: Schema.Schema.Type<typeof BdIssue>): Issue =>
  toIssue(
    bd,
    (bd.dependencies ?? []).map((dependency) =>
      "depends_on_id" in dependency
        ? { id: dependency.depends_on_id, type: dependency.type }
        : { id: dependency.id, type: dependency.dependency_type, issue: toIssue(dependency, []) },
    ),
  )

/** At most `max` characters of text, for an error. */
const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

/** The payload of bd's output: the JSON, out of its envelope when it has one. */
export const bdPayload = (stdout: string): Result.Result<unknown, string> =>
  Result.map(
    Result.mapError(Schema.decodeUnknownResult(Json)(stdout), () => "not JSON"),
    (json) =>
      Option.match(Schema.decodeUnknownOption(Envelope)(json), {
        onNone: () => json,
        onSome: (envelope) => envelope.data,
      }),
  )

const decodeWith =
  <A>(schema: Schema.Decoder<A>, what: string) =>
  (command: string, stdout: string): Effect.Effect<A, BeadsUnreadable> => {
    const decoded = Result.flatMap(bdPayload(stdout), (data) =>
      Result.mapError(Schema.decodeUnknownResult(schema)(data), (error) => error.message),
    )
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.fail(
          new BeadsUnreadable({
            command,
            reason: clip(`${what}: ${decoded.failure}`, 500),
            output: clip(stdout.trim(), 200),
          }),
        )
  }

const decodeBdIssues = decodeWith(Schema.Array(BdIssue), "a list of issues")
const decodeBdIssueOrList = decodeWith(
  Schema.Union([BdIssue, Schema.NonEmptyArray(BdIssue)]),
  "an issue",
)
const decodeBdQuestions = decodeWith(Schema.NullOr(Schema.Array(BdIssue)), "a list of issues")
const decodeBdLinked = decodeWith(Schema.Array(BdLinkedIssue), "a list of linked issues")

/** Decodes the output of a bd command that lists issues: ready, list. */
export const decodeIssues = (
  command: string,
  stdout: string,
): Effect.Effect<ReadonlyArray<Issue>, BeadsUnreadable> =>
  Effect.map(decodeBdIssues(command, stdout), (issues) => issues.map(fromBd))

/** Decodes the output of bd human list, which is null, not [], when there are no questions. */
export const decodeQuestions = (
  command: string,
  stdout: string,
): Effect.Effect<ReadonlyArray<Issue>, BeadsUnreadable> =>
  Effect.map(decodeBdQuestions(command, stdout), (issues) => (issues ?? []).map(fromBd))

/** Decodes the output of a bd command that gives one issue: show, update, close, defer, create. */
export const decodeIssue = (
  command: string,
  stdout: string,
): Effect.Effect<Issue, BeadsUnreadable> =>
  Effect.map(decodeBdIssueOrList(command, stdout), (issue) =>
    fromBd(Array.isArray(issue) ? issue[0] : issue),
  )

/**
 * The issue bd gives for `id` in the output of bd show: bd answers an ID it has no issue for with one
 * whose ID starts with it (a deleted ticket's follow-up, say), and that is bd having no such issue.
 */
export const issueFor = (
  id: string,
  command: string,
  stdout: string,
): Effect.Effect<Issue, BeadsFailed | BeadsUnreadable> =>
  Effect.flatMap(decodeBdIssueOrList(command, stdout), (decoded) => {
    const issues = Array.isArray(decoded) ? decoded : [decoded]
    const issue = issues.find((each) => each.id === id)
    return issue === undefined
      ? Effect.fail(
          new BeadsFailed({
            command,
            exitCode: 1,
            stderr: `bd has no such ticket: ${command} gave ${issues[0]?.id}, another ticket`,
            noSuchIssue: true,
          }),
        )
      : Effect.succeed(fromBd(issue))
  })

/** Decodes the output of bd dep list: the linked issues, each with how it links. */
export const decodeDependencies = (
  command: string,
  stdout: string,
): Effect.Effect<ReadonlyArray<Dependency>, BeadsUnreadable> =>
  Effect.map(decodeBdLinked(command, stdout), (linked) =>
    linked.map((issue) => ({
      id: issue.id,
      type: issue.dependency_type,
      issue: toIssue(issue, []),
    })),
  )

/** Whether bd's output says it has no issue by the ID it was given. */
export const saysNoSuchIssue = (stdout: string): boolean =>
  Option.match(Schema.decodeUnknownOption(BdError)(stdout.trim()), {
    onNone: () => false,
    onSome: (error) => error.error === noSuchIssueError,
  })

/** What bd printed and how it exited: what a call is judged by. */
export interface BdOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** bd failing with this output: it has no such issue when its stdout says so. */
export const bdFailed = (command: string, output: BdOutput): BeadsFailed =>
  new BeadsFailed({
    command,
    exitCode: output.exitCode,
    stderr: output.stderr,
    noSuchIssue: saysNoSuchIssue(output.stdout),
  })

/** A read is bd's answer when its output decodes, whatever bd's exit code. */
export const judgeRead = <A>(
  command: string,
  output: BdOutput,
  decode: (command: string, stdout: string) => Effect.Effect<A, BeadsUnreadable | BeadsFailed>,
): Effect.Effect<A, BeadsUnreadable | BeadsFailed> =>
  decode(command, output.stdout).pipe(
    Effect.catchTag("BeadsUnreadable", (unreadable) =>
      Effect.fail(output.exitCode === 0 ? unreadable : bdFailed(command, output)),
    ),
  )

/** An update is done when bd exits 0. */
export const judgeWrite = (command: string, output: BdOutput): Effect.Effect<void, BeadsFailed> =>
  output.exitCode === 0 ? Effect.void : Effect.fail(bdFailed(command, output))

export interface ReadyOptions {
  /** Only this issue's descendants. */
  readonly parent?: string
  readonly excludeLabels?: ReadonlyArray<string>
  readonly excludeTypes?: ReadonlyArray<string>
}

export interface ListOptions {
  /** Closed issues too; bd list leaves them out otherwise. */
  readonly all?: boolean
  readonly status?: Status
  /** Only this issue's subtickets, one level down. */
  readonly parent?: string
  /** Only issues carrying every one of these labels. */
  readonly labels?: ReadonlyArray<string>
  /** Only issues whose metadata gives each key this value. */
  readonly metadata?: Readonly<Record<string, string>>
}

export interface Update {
  /** Assign it to the actor and put it in progress, as bd update --claim does. */
  readonly claim?: boolean
  readonly status?: Status
  readonly appendNotes?: string
  /** Each key set to its value, keeping the others. */
  readonly setMetadata?: Readonly<Record<string, string>>
  readonly unsetMetadata?: ReadonlyArray<string>
}

export interface Deferral {
  /** Appended to the notes. */
  readonly reason?: string
  /** When it is due again, in any form bd defer --until takes; none defers it indefinitely. */
  readonly until?: string
}

export interface NewIssue {
  readonly title: string
  readonly description?: string
  readonly acceptance?: string
  /** bd's issue type; bd's default (task) when absent. */
  readonly type?: string
  readonly priority?: number
  readonly parent?: string
  /** The issues it waits for. */
  readonly blockedBy?: ReadonlyArray<string>
  /** The issues that wait for it. */
  readonly blocks?: ReadonlyArray<string>
  readonly discoveredFrom?: ReadonlyArray<string>
  readonly labels?: ReadonlyArray<string>
  readonly metadata?: Readonly<Record<string, unknown>>
  /**
   * The caller has made sure bd has the parent and the linked issues by those very IDs (bd just gave
   * them): create doesn't show them first.
   */
  readonly checked?: boolean
}

/** For a write whose caller has made sure bd has its issues by those very IDs. */
export interface Checked {
  readonly checked?: boolean
}

export type Direction = "down" | "up"

export class Beads extends Context.Service<
  Beads,
  {
    /** bd ready: the open issues not blocked, nor deferred until later, in bd's order. */
    ready(options?: ReadyOptions): Effect.Effect<ReadonlyArray<Issue>, BeadsError>
    /** bd show: the issue, with the issues it depends on. */
    show(id: string): Effect.Effect<Issue, BeadsError>
    /** bd list: the issues that aren't closed, or every one with `all`. */
    list(options?: ListOptions): Effect.Effect<ReadonlyArray<Issue>, BeadsError>
    update(id: string, update: Update): Effect.Effect<Issue, BeadsError>
    close(id: string, reason?: string): Effect.Effect<Issue, BeadsError>
    /** bd defer: sets the issue aside, indefinitely or until a date. */
    defer(id: string, deferral?: Deferral): Effect.Effect<Issue, BeadsError>
    addLabel(id: string, label: string): Effect.Effect<void, BeadsError>
    removeLabel(id: string, label: string): Effect.Effect<void, BeadsError>
    /** bd dep add: `id` depends on `dependsOn`; a blocks link unless another type is given. */
    addDependency(
      id: string,
      dependsOn: string,
      type?: DependencyType,
      options?: Checked,
    ): Effect.Effect<void, BeadsError>
    /** bd dep list: what the issue depends on ("down", the default), or what depends on it ("up"). */
    dependencies(
      id: string,
      options?: { readonly direction?: Direction; readonly type?: DependencyType },
    ): Effect.Effect<ReadonlyArray<Dependency>, BeadsError>
    create(issue: NewIssue): Effect.Effect<Issue, BeadsError>
    /** bd human list: the questions for the maintainer that aren't closed. */
    questions(): Effect.Effect<ReadonlyArray<Issue>, BeadsError>
    /** The issue's metadata, from bd show. */
    metadata(id: string): Effect.Effect<Readonly<Record<string, unknown>>, BeadsError>
    /** Sets one key of the issue's metadata to a string, keeping the others. */
    setMetadata(id: string, key: string, value: string): Effect.Effect<void, BeadsError>
    unsetMetadata(id: string, key: string): Effect.Effect<void, BeadsError>
  }
>()("tutti/services/Beads") {
  /**
   * bd in the repository at cwd. `command`, `timeLimits` and `maxOutputBytes` (exec's cap on the
   * output kept) are there for tests.
   */
  static readonly layer = (options: {
    readonly cwd: string
    readonly command?: string
    readonly timeLimits?: { readonly read: Duration.Input; readonly write: Duration.Input }
    readonly maxOutputBytes?: number
  }) =>
    Layer.effect(
      Beads,
      Effect.gen(function* () {
        const context = yield* Effect.context<
          ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
        >()
        const bin = options.command ?? "bd"
        const limits = options.timeLimits ?? TimeLimit
        const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes

        const bd = (args: ReadonlyArray<string>, timeLimit: Duration.Input) => {
          const command: Command = {
            command: bin,
            args,
            timeLimit,
            cwd: options.cwd,
            maxOutputBytes,
            // Pins the --json shape. Only bd gets it, as orchestra does.
            env: { BD_JSON_ENVELOPE: "0", NO_COLOR: "1" },
          }
          const shown = showCommand({ command: "bd", args })
          return exec(command).pipe(
            Effect.catchTags({
              CommandTimedOut: (error) =>
                Effect.fail(new BeadsTimedOut({ command: shown, timeLimit: error.timeLimit })),
              CommandNotRun: (error) =>
                Effect.fail(
                  new BeadsFailed({
                    command: shown,
                    exitCode: 127,
                    stderr: error.reason,
                    noSuchIssue: false,
                  }),
                ),
            }),
            Effect.provideContext(context),
            Effect.map((output) => ({ shown, output })),
          )
        }

        // bd's stdout past exec's cap lost its start, so it isn't decoded: it would fail as "not
        // JSON", or worse, decode as the last issues of a list. bd exiting 0 says so; failing, it
        // fails with its exit code.
        const whole =
          <A>(
            output: Output,
            decode: (
              command: string,
              stdout: string,
            ) => Effect.Effect<A, BeadsUnreadable | BeadsFailed>,
          ) =>
          (command: string, stdout: string) =>
            output.truncated.stdout
              ? Effect.fail(
                  new BeadsUnreadable({
                    command,
                    reason: outputCut(maxOutputBytes, "bd's"),
                    output: "",
                  }),
                )
              : decode(command, stdout)

        const read = <A>(
          args: ReadonlyArray<string>,
          decode: (
            command: string,
            stdout: string,
          ) => Effect.Effect<A, BeadsUnreadable | BeadsFailed>,
        ) =>
          Effect.flatMap(bd(args, limits.read), ({ shown, output }) =>
            judgeRead(shown, output, whole(output, decode)),
          )

        const write = (args: ReadonlyArray<string>) =>
          Effect.flatMap(bd(args, limits.write), ({ shown, output }) =>
            Effect.as(judgeWrite(shown, output), { shown, output }),
          )

        const writeIssue = (args: ReadonlyArray<string>) =>
          Effect.flatMap(write(args), ({ shown, output }) =>
            whole(output, decodeIssue)(shown, output.stdout),
          )

        const show = (id: string) =>
          read(["show", id, "--json"], (command, stdout) => issueFor(id, command, stdout))

        // bd's writes, like its show, act on an issue whose ID starts with the one they are given:
        // each ID is shown first, and bd having no issue by one fails the write before it is made.
        // A show that fails otherwise leaves the write to say whether bd can make it.
        const confirmed = <A, E, R>(ids: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) =>
          Effect.andThen(
            Effect.forEach(
              ids,
              (id) =>
                Effect.catchIf(
                  show(id),
                  (error) => !(error._tag === "BeadsFailed" && error.noSuchIssue),
                  () => Effect.void,
                ),
              { discard: true },
            ),
            effect,
          )

        const flag = (name: string, value: string | undefined): ReadonlyArray<string> =>
          value === undefined ? [] : [`--${name}=${value}`]
        const listFlag = (name: string, values: ReadonlyArray<string> | undefined) =>
          values === undefined || values.length === 0 ? [] : [`--${name}=${values.join(",")}`]

        const update = (id: string, change: Update) =>
          confirmed(
            [id],
            writeIssue([
              "update",
              id,
              "--json",
              ...(change.claim ? ["--claim"] : []),
              ...flag("status", change.status),
              ...flag("append-notes", change.appendNotes),
              ...Object.entries(change.setMetadata ?? {}).map(
                ([key, value]) => `--set-metadata=${key}=${value}`,
              ),
              ...(change.unsetMetadata ?? []).map((key) => `--unset-metadata=${key}`),
            ]),
          )

        return Beads.of({
          ready: (ready = {}) =>
            read(
              [
                "ready",
                "--json",
                "--limit=0",
                ...flag("parent", ready.parent),
                ...listFlag("exclude-label", ready.excludeLabels),
                ...listFlag("exclude-type", ready.excludeTypes),
              ],
              decodeIssues,
            ),
          show,
          list: (list = {}) =>
            read(
              [
                "list",
                "--json",
                "--limit=0",
                ...(list.all ? ["--all"] : []),
                ...flag("status", list.status),
                ...flag("parent", list.parent),
                ...(list.labels ?? []).map((label) => `--label=${label}`),
                ...Object.entries(list.metadata ?? {}).map(
                  ([key, value]) => `--metadata-field=${key}=${value}`,
                ),
              ],
              decodeIssues,
            ),
          update,
          close: (id, reason) =>
            confirmed([id], writeIssue(["close", id, "--json", ...flag("reason", reason)])),
          defer: (id, deferral = {}) =>
            confirmed(
              [id],
              writeIssue([
                "defer",
                id,
                "--json",
                ...flag("reason", deferral.reason),
                ...flag("until", deferral.until),
              ]),
            ),
          addLabel: (id, label) =>
            confirmed([id], Effect.asVoid(write(["label", "add", id, label, "--json"]))),
          removeLabel: (id, label) =>
            confirmed([id], Effect.asVoid(write(["label", "remove", id, label, "--json"]))),
          addDependency: (id, dependsOn, type = "blocks", options = {}) =>
            confirmed(
              options.checked ? [] : [id, dependsOn],
              Effect.asVoid(write(["dep", "add", id, dependsOn, "--json", `--type=${type}`])),
            ),
          dependencies: (id, dependencies = {}) =>
            confirmed(
              [id],
              read(
                [
                  "dep",
                  "list",
                  id,
                  "--json",
                  ...flag("direction", dependencies.direction),
                  ...flag("type", dependencies.type),
                ],
                decodeDependencies,
              ),
            ),
          create: (issue) =>
            confirmed(
              issue.checked
                ? []
                : [
                    ...(issue.parent === undefined ? [] : [issue.parent]),
                    ...(issue.blockedBy ?? []),
                    ...(issue.blocks ?? []),
                    ...(issue.discoveredFrom ?? []),
                  ],
              writeIssue([
                "create",
                "--json",
                `--title=${issue.title}`,
                ...flag("description", issue.description),
                ...flag("acceptance", issue.acceptance),
                ...flag("type", issue.type),
                ...flag("priority", issue.priority?.toString()),
                ...flag("parent", issue.parent),
                ...(issue.blockedBy ?? []).map((id) => `--deps=blocked-by:${id}`),
                ...(issue.blocks ?? []).map((id) => `--deps=blocks:${id}`),
                ...(issue.discoveredFrom ?? []).map((id) => `--deps=discovered-from:${id}`),
                ...listFlag("labels", issue.labels),
                ...flag(
                  "metadata",
                  issue.metadata === undefined ? undefined : JSON.stringify(issue.metadata),
                ),
              ]),
            ),
          questions: () => read(["human", "list", "--json"], decodeQuestions),
          metadata: (id) => Effect.map(show(id), (issue) => issue.metadata),
          setMetadata: (id, key, value) =>
            Effect.asVoid(update(id, { setMetadata: { [key]: value } })),
          unsetMetadata: (id, key) => Effect.asVoid(update(id, { unsetMetadata: [key] })),
        })
      }),
    )
}
