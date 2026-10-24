// Beads' test layer (§ 3.3): an in-memory backlog with bd's semantics, so whole runs can be
// scripted. As bd 1.3 has it, an issue is ready when it is open, not deferred until later and not
// blocked: no blocks link to an issue that isn't closed, on it or on any of its ancestors (a blocked
// epic holds its subtickets back; a deferred or in-progress one doesn't). parent-child,
// discovered-from and related links don't block. A deferral whose date has passed wakes the issue
// as bd ready does. bd close refuses an issue with a live blocker or a child that isn't closed, and
// so does this. Time comes from Effect's Clock, so TestClock moves it. A test can also make the
// next call of any bd command fail or time out, as the test Git layer's fail does, which is how
// scenarios reach bd failing part-way through a run. Its answers are bd's --json output, decoded
// and judged as the live layer does, so a fault's output reaches the same judgement.
import { Clock, Context, Effect, Layer, Ref } from "effect"
import {
  type BdOutput,
  Beads,
  type BeadsError,
  type BeadsFailed,
  BeadsTimedOut,
  type BeadsUnreadable,
  bdFailed,
  type DependencyType,
  decodeDependencies,
  decodeIssue,
  decodeIssues,
  decodeQuestions,
  HumanLabel,
  type Issue,
  issueFor,
  judgeRead,
  judgeWrite,
  type ListOptions,
  type NewIssue,
  noSuchIssueError,
  type ReadyOptions,
  type Status,
  type Update,
} from "../services/Beads.ts"
import { TimeLimit } from "../services/exec.ts"

/** An issue to start the backlog with; what it leaves out takes bd's defaults. */
export interface Seed {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly design?: string
  readonly acceptance?: string
  readonly notes?: string
  readonly status?: Status
  readonly priority?: number
  readonly type?: string
  readonly assignee?: string
  readonly labels?: ReadonlyArray<string>
  readonly parent?: string
  /** The issues it waits for (blocks links). */
  readonly blockedBy?: ReadonlyArray<string>
  /** Any other links, by type. */
  readonly dependencies?: ReadonlyArray<{ readonly id: string; readonly type: DependencyType }>
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly deferUntil?: string
  readonly closeReason?: string
}

/**
 * What bd gives the next call of a command instead of what it would, judged as the live layer
 * judges bd's output: a read whose stdout decodes is bd's answer whatever the exit code, and one
 * whose stdout says bd has no such issue fails with noSuchIssue; a write that exits 0 is done, its
 * stdout decoded as the issue it gives (a write that gives none changes nothing).
 */
export interface Fault {
  /**
   * Only a call about this issue: the ID it is given, or the parent bd list or bd ready lists
   * under; any call when absent.
   */
  readonly id?: string
  /** The call times out (BeadsTimedOut) instead of failing (BeadsFailed). */
  readonly timedOut?: boolean
  /** 1 by default. */
  readonly exitCode?: number
  readonly stderr?: string
  /** "" by default. */
  readonly stdout?: string
  /** How many calls fail; 1 by default, every one with Infinity. */
  readonly times?: number
}

/** bd's stdout as bd show --json answers an ID it has no issue for, for a Fault's stdout. */
export const noSuchIssueStdout = JSON.stringify({ error: noSuchIssueError })

/** The bd commands a Fault's id is the parent of, not the issue. */
const listsUnder: ReadonlySet<string> = new Set(["list", "ready", "create"])

/** An issue as the backlog holds it: its links, the parent-child one among them. */
interface Stored {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly design: string
  readonly acceptance: string
  readonly notes: string
  readonly status: Status
  readonly priority: number
  readonly type: string
  readonly assignee: string
  readonly labels: ReadonlyArray<string>
  readonly links: ReadonlyArray<{ readonly id: string; readonly type: DependencyType }>
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly deferUntil?: string
  readonly closeReason: string
  /** Creation order, which breaks ties in bd's sorts. */
  readonly seq: number
}

/** The actor bd update --claim assigns an issue to. */
export const actor = "tutti"

/** The prefix of the IDs create gives an issue without a parent. */
export const idPrefix = "test"

/** The backlog behind the test layer, for a test to look at or change as a worker would. */
export class Backlog extends Context.Service<
  Backlog,
  {
    /** Every issue, closed or not, as bd show gives it, in creation order. */
    readonly issues: Effect.Effect<ReadonlyArray<Issue>>
    /** The issue as bd show gives it, if the backlog has it. */
    get(id: string): Effect.Effect<Issue | undefined>
    /** Adds the issue, or replaces the one with its ID. */
    put(seed: Seed): Effect.Effect<void>
    /**
     * Makes the next call of the bd command op (`list`, `show`, `update`, `label add`, `dep list`,
     * `human list`, …) give the fault's output, which fails it unless it decodes.
     */
    fail(op: string, fault?: Fault): Effect.Effect<void>
  }
>()("tutti/testing/Beads/Backlog") {}

const parentOf = (issue: Stored): string | undefined =>
  issue.links.find((link) => link.type === "parent-child")?.id

/** The command line a call of op about id shows. */
const commandOf = (op: string, id: string | undefined) =>
  `bd ${op}${id === undefined ? "" : listsUnder.has(op) ? ` --parent=${id}` : ` ${id}`} --json`

type Decode<A> = (
  command: string,
  stdout: string,
) => Effect.Effect<A, BeadsUnreadable | BeadsFailed>

/** The issue's own fields as bd's JSON gives them. */
const bdFields = (issue: Stored) => ({
  id: issue.id,
  title: issue.title,
  description: issue.description,
  design: issue.design,
  acceptance_criteria: issue.acceptance,
  notes: issue.notes,
  status: issue.status,
  priority: issue.priority,
  issue_type: issue.type,
  assignee: issue.assignee,
  labels: issue.labels,
  ...(parentOf(issue) === undefined ? {} : { parent: parentOf(issue) }),
  metadata: issue.metadata,
  created_at: issue.createdAt,
  ...(issue.deferUntil === undefined ? {} : { defer_until: issue.deferUntil }),
  close_reason: issue.closeReason,
})

/** The issue as bd ready, bd list and bd's writes give it: its links, by ID. */
const brief = (issue: Stored) => ({
  ...bdFields(issue),
  dependencies: issue.links.map((link) => ({
    issue_id: issue.id,
    depends_on_id: link.id,
    type: link.type,
  })),
})

/** The issue as bd show gives it: each issue it links to, without its own links. */
const full = (issues: ReadonlyMap<string, Stored>, issue: Stored) => ({
  ...bdFields(issue),
  dependencies: issue.links.flatMap((link) => {
    const other = issues.get(link.id)
    return other === undefined ? [] : [linked(other, link.type)]
  }),
})

/** An issue as bd show and bd dep list give one linked to another. */
const linked = (issue: Stored, type: DependencyType) => ({
  ...bdFields(issue),
  dependency_type: type,
})

/** The issue as bd show gives it, decoded as the live layer decodes it. */
const shown = (issues: ReadonlyMap<string, Stored>, issue: Stored): Effect.Effect<Issue> =>
  Effect.orDie(
    issueFor(issue.id, commandOf("show", issue.id), JSON.stringify([full(issues, issue)])),
  )

const withLink = (
  links: Stored["links"],
  link: { readonly id: string; readonly type: DependencyType },
): Stored["links"] =>
  // bd keeps one link per pair of issues.
  [...links.filter((other) => other.id !== link.id), link]

const appended = (notes: string, note: string) => (notes === "" ? note : `${notes}\n${note}`)

/** Whether a metadata value is the text bd list --metadata-field compares it to. */
const metadataIs = (value: unknown, text: string) =>
  typeof value === "string" ? value === text : JSON.stringify(value) === text

const store = (seed: Seed, seq: number, now: number): Stored => {
  const links = [
    ...(seed.parent === undefined ? [] : [{ id: seed.parent, type: "parent-child" }]),
    ...(seed.blockedBy ?? []).map((id) => ({ id, type: "blocks" })),
    ...(seed.dependencies ?? []),
  ].reduce(withLink, [])
  return {
    id: seed.id,
    title: seed.title ?? seed.id,
    description: seed.description ?? "",
    design: seed.design ?? "",
    acceptance: seed.acceptance ?? "",
    notes: seed.notes ?? "",
    status: seed.status ?? "open",
    priority: seed.priority ?? 2,
    type: seed.type ?? "task",
    assignee: seed.assignee ?? "",
    labels: [...new Set(seed.labels ?? [])],
    links,
    metadata: seed.metadata ?? {},
    createdAt: new Date(now).toISOString(),
    ...(seed.deferUntil === undefined ? {} : { deferUntil: seed.deferUntil }),
    closeReason: seed.closeReason ?? "",
    seq,
  }
}

/** An in-memory Beads, and its Backlog, starting with these issues. */
export const layer = (seeds: ReadonlyArray<Seed> = []): Layer.Layer<Beads | Backlog> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const state = yield* Ref.make(
        new Map(seeds.map((seed, seq) => [seed.id, store(seed, seq, start)] as const)),
      )
      let seq = seeds.length

      const ancestors = (issues: ReadonlyMap<string, Stored>, issue: Stored): Array<Stored> => {
        const found: Array<Stored> = []
        const seen = new Set([issue.id])
        for (let id = parentOf(issue); id !== undefined && !seen.has(id); ) {
          seen.add(id)
          const parent = issues.get(id)
          if (parent === undefined) break
          found.push(parent)
          id = parentOf(parent)
        }
        return found
      }

      const blockedByLink = (issues: ReadonlyMap<string, Stored>, issue: Stored): boolean =>
        issue.links.some((link) => {
          const blocker = issues.get(link.id)
          return link.type === "blocks" && blocker !== undefined && blocker.status !== "closed"
        })

      const isReady = (issues: ReadonlyMap<string, Stored>, issue: Stored, now: number) =>
        issue.status === "open" &&
        (issue.deferUntil === undefined || Date.parse(issue.deferUntil) <= now) &&
        ![issue, ...ancestors(issues, issue)].some((each) => blockedByLink(issues, each))

      const isDescendant = (issues: ReadonlyMap<string, Stored>, issue: Stored, of: string) =>
        ancestors(issues, issue).some((ancestor) => ancestor.id === of)

      const byPriorityThen = (newest: boolean) => (a: Stored, b: Stored) =>
        a.priority - b.priority || (newest ? b.seq - a.seq : a.seq - b.seq)

      /** Why bd refuses to close the issue, if it does: a live blocker, or a child not closed. */
      const refusesToClose = (issues: ReadonlyMap<string, Stored>, issue: Stored) => {
        const blockers = issue.links
          .filter((link) => link.type === "blocks" && issues.get(link.id)?.status !== "closed")
          .map((link) => link.id)
        if (blockers.length > 0) {
          return `cannot close blocked issue: ${issue.id} is blocked by [${blockers.join(" ")}]`
        }
        const open = [...issues.values()].filter(
          (other) => parentOf(other) === issue.id && other.status !== "closed",
        ).length
        return open === 0 ? undefined : `cannot close ${issue.id}: ${open} open child issue(s)`
      }

      /** bd's output for a call that went through. */
      const ok = (value: unknown): BdOutput => ({
        exitCode: 0,
        stdout: JSON.stringify(value),
        stderr: "",
      })

      /**
       * bd show's failure for an ID the backlog has no issue for: the live layer shows each issue a
       * write is about first, and fails the write with it.
       */
      const missing = (id: string): BdOutput => ({
        exitCode: 1,
        stdout: noSuchIssueStdout,
        stderr: `Issue ${id} not found`,
      })
      const confirm = (issues: ReadonlyMap<string, Stored>, ids: ReadonlyArray<string>) =>
        Effect.forEach(
          ids,
          (id) =>
            issues.has(id)
              ? Effect.void
              : Effect.fail(bdFailed(commandOf("show", id), missing(id))),
          { discard: true },
        )

      /** Changes the issue, as bd's write gives it, unless the change would close it and bd refuses to. */
      const change = (id: string, f: (issue: Stored) => Stored) =>
        Effect.flatMap(Ref.get(state), (issues) =>
          Effect.andThen(
            confirm(issues, [id]),
            Ref.modify(state, (issues): [BdOutput, Map<string, Stored>] => {
              const issue = issues.get(id) as Stored
              const changed = f(issue)
              const refusal =
                changed.status === "closed" && issue.status !== "closed"
                  ? refusesToClose(issues, issue)
                  : undefined
              if (refusal !== undefined) {
                return [{ exitCode: 1, stdout: "", stderr: refusal }, issues]
              }
              return [ok([brief(changed)]), new Map(issues).set(id, changed)]
            }),
          ),
        )

      const ready = (options: ReadyOptions = {}) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          // bd ready wakes an issue whose deferral has passed, as bd undefer would.
          const issues = yield* Ref.updateAndGet(
            state,
            (issues) =>
              new Map(
                [...issues].map(([id, issue]) => {
                  if (issue.status !== "deferred" || issue.deferUntil === undefined) {
                    return [id, issue]
                  }
                  if (Date.parse(issue.deferUntil) > now) return [id, issue]
                  const { deferUntil: _, ...woken } = issue
                  return [id, { ...woken, status: "open" }]
                }),
              ),
          )
          return ok(
            [...issues.values()]
              .filter(
                (issue) =>
                  isReady(issues, issue, now) &&
                  (options.parent === undefined || isDescendant(issues, issue, options.parent)) &&
                  !issue.labels.some((label) => options.excludeLabels?.includes(label)) &&
                  !options.excludeTypes?.includes(issue.type),
              )
              .sort(byPriorityThen(false))
              .map(brief),
          )
        })

      const show = (id: string) =>
        Effect.map(Ref.get(state), (issues) => {
          const issue = issues.get(id)
          return issue === undefined ? missing(id) : ok([full(issues, issue)])
        })

      const listed = (options: ListOptions = {}) =>
        Effect.map(Ref.get(state), (issues) =>
          [...issues.values()]
            .filter(
              (issue) =>
                (options.status === undefined
                  ? options.all || issue.status !== "closed"
                  : issue.status === options.status) &&
                (options.parent === undefined || parentOf(issue) === options.parent) &&
                (options.labels ?? []).every((label) => issue.labels.includes(label)) &&
                Object.entries(options.metadata ?? {}).every(
                  ([key, value]) =>
                    Object.hasOwn(issue.metadata, key) && metadataIs(issue.metadata[key], value),
                ),
            )
            .sort(byPriorityThen(true)),
        )

      const update = (id: string, update: Update) =>
        change(id, (issue) => {
          const metadata: Record<string, unknown> = { ...issue.metadata, ...update.setMetadata }
          for (const key of update.unsetMetadata ?? []) delete metadata[key]
          return {
            ...issue,
            ...(update.claim ? { assignee: actor, status: "in_progress" } : {}),
            ...(update.status === undefined ? {} : { status: update.status }),
            notes:
              update.appendNotes === undefined
                ? issue.notes
                : appended(issue.notes, update.appendNotes),
            metadata,
          }
        })

      const addLink = (id: string, link: { readonly id: string; readonly type: DependencyType }) =>
        Effect.flatMap(Ref.get(state), (issues) =>
          Effect.andThen(
            confirm(issues, [link.id]),
            change(id, (issue) => ({ ...issue, links: withLink(issue.links, link) })),
          ),
        )

      const create = (issue: NewIssue) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const issues = yield* Ref.get(state)
          yield* confirm(issues, [
            ...(issue.parent === undefined ? [] : [issue.parent]),
            ...(issue.blockedBy ?? []),
            ...(issue.blocks ?? []),
            ...(issue.discoveredFrom ?? []),
          ])
          // bd numbers a subticket after its parent: <parent>.1, <parent>.2, …
          const children = [...issues.values()].filter(
            (other) => issue.parent !== undefined && parentOf(other) === issue.parent,
          ).length
          seq += 1
          const id =
            issue.parent === undefined ? `${idPrefix}-${seq}` : `${issue.parent}.${children + 1}`
          const stored = store(
            {
              id,
              title: issue.title,
              ...(issue.description === undefined ? {} : { description: issue.description }),
              ...(issue.acceptance === undefined ? {} : { acceptance: issue.acceptance }),
              ...(issue.type === undefined ? {} : { type: issue.type }),
              ...(issue.priority === undefined ? {} : { priority: issue.priority }),
              ...(issue.parent === undefined ? {} : { parent: issue.parent }),
              ...(issue.blockedBy === undefined ? {} : { blockedBy: issue.blockedBy }),
              dependencies: (issue.discoveredFrom ?? []).map((from) => ({
                id: from,
                type: "discovered-from",
              })),
              ...(issue.labels === undefined ? {} : { labels: issue.labels }),
              ...(issue.metadata === undefined ? {} : { metadata: issue.metadata }),
            },
            seq,
            now,
          )
          yield* Ref.update(state, (issues) => new Map(issues).set(id, stored))
          for (const blocked of issue.blocks ?? []) yield* addLink(blocked, { id, type: "blocks" })
          return ok(brief(stored))
        })

      const dependencies = (
        id: string,
        options: Parameters<Beads["Service"]["dependencies"]>[1] = {},
      ) =>
        Effect.flatMap(Ref.get(state), (issues) =>
          Effect.as(
            confirm(issues, [id]),
            ok(
              (options.direction === "up"
                ? [...issues.values()].flatMap((other) =>
                    other.links
                      .filter((link) => link.id === id)
                      .map((link) => [other, link.type] as const),
                  )
                : (issues.get(id) as Stored).links.flatMap((link) => {
                    const other = issues.get(link.id)
                    return other === undefined ? [] : [[other, link.type] as const]
                  })
              )
                .filter(([, type]) => options.type === undefined || type === options.type)
                .map(([other, type]) => linked(other, type)),
            ),
          ),
        )

      const faults: Array<{ readonly op: string; readonly fault: Fault; left: number }> = []

      /**
       * What bd gives the call of op (about id), or what a test made it give instead, judged as the
       * live layer judges bd's output and decoded as it decodes it.
       */
      const answer = <A>(
        kind: "read" | "write",
        op: string,
        id: string | undefined,
        call: Effect.Effect<BdOutput, BeadsError>,
        decode: Decode<A>,
      ): Effect.Effect<A, BeadsError> =>
        Effect.suspend(() => {
          const command = commandOf(op, id)
          const found = faults.find(
            (each) => each.op === op && (each.fault.id === undefined || each.fault.id === id),
          )
          if (found !== undefined) {
            found.left -= 1
            if (found.left <= 0) faults.splice(faults.indexOf(found), 1)
          }
          const fault = found?.fault
          const output: Effect.Effect<BdOutput, BeadsError> =
            fault === undefined
              ? call
              : fault.timedOut
                ? Effect.fail(new BeadsTimedOut({ command, timeLimit: TimeLimit[kind] }))
                : Effect.succeed({
                    exitCode: fault.exitCode ?? 1,
                    stdout: fault.stdout ?? "",
                    stderr: fault.stderr ?? `Error: bd ${op} failed`,
                  })
          return Effect.flatMap(output, (output) =>
            kind === "read"
              ? judgeRead(command, output, decode)
              : Effect.andThen(judgeWrite(command, output), decode(command, output.stdout)),
          )
        })

      const nothing: Decode<void> = () => Effect.void
      const decodeShow =
        (id: string): Decode<Issue> =>
        (command, stdout) =>
          issueFor(id, command, stdout)

      const beads = Beads.of({
        ready: (options) => answer("read", "ready", options?.parent, ready(options), decodeIssues),
        show: (id) => answer("read", "show", id, show(id), decodeShow(id)),
        list: (options) =>
          answer(
            "read",
            "list",
            options?.parent,
            Effect.map(listed(options), (issues) => ok(issues.map(brief))),
            decodeIssues,
          ),
        update: (id, changes) => answer("write", "update", id, update(id, changes), decodeIssue),
        close: (id, reason) =>
          answer(
            "write",
            "close",
            id,
            change(id, (issue) => ({
              ...issue,
              status: "closed",
              closeReason: reason ?? issue.closeReason,
            })),
            decodeIssue,
          ),
        defer: (id, deferral = {}) =>
          answer(
            "write",
            "defer",
            id,
            change(id, (issue) => {
              const { deferUntil: _, ...rest } = issue
              return {
                ...rest,
                status: "deferred",
                ...(deferral.until === undefined ? {} : { deferUntil: deferral.until }),
                notes:
                  deferral.reason === undefined
                    ? issue.notes
                    : appended(issue.notes, deferral.reason),
              }
            }),
            decodeIssue,
          ),
        addLabel: (id, label) =>
          answer(
            "write",
            "label add",
            id,
            change(id, (issue) => ({
              ...issue,
              labels: issue.labels.includes(label) ? issue.labels : [...issue.labels, label],
            })),
            nothing,
          ),
        removeLabel: (id, label) =>
          answer(
            "write",
            "label remove",
            id,
            change(id, (issue) => ({
              ...issue,
              labels: issue.labels.filter((other) => other !== label),
            })),
            nothing,
          ),
        addDependency: (id, dependsOn, type = "blocks") =>
          answer("write", "dep add", id, addLink(id, { id: dependsOn, type }), nothing),
        dependencies: (id, options) =>
          answer("read", "dep list", id, dependencies(id, options), decodeDependencies),
        create: (issue) => answer("write", "create", issue.parent, create(issue), decodeIssue),
        questions: () =>
          answer(
            "read",
            "human list",
            undefined,
            Effect.map(listed(), (issues) => {
              const questions = issues.filter((issue) => issue.labels.includes(HumanLabel))
              // bd human list gives null, not [], when there are none.
              return ok(questions.length === 0 ? null : questions.map(brief))
            }),
            decodeQuestions,
          ),
        metadata: (id) =>
          answer("read", "show", id, show(id), (command, stdout) =>
            Effect.map(issueFor(id, command, stdout), (issue) => issue.metadata),
          ),
        setMetadata: (id, key, value) =>
          answer(
            "write",
            "update",
            id,
            update(id, { setMetadata: { [key]: value } }),
            (command, stdout) => Effect.asVoid(decodeIssue(command, stdout)),
          ),
        unsetMetadata: (id, key) =>
          answer("write", "update", id, update(id, { unsetMetadata: [key] }), (command, stdout) =>
            Effect.asVoid(decodeIssue(command, stdout)),
          ),
      })

      const backlog = Backlog.of({
        issues: Effect.flatMap(Ref.get(state), (issues) =>
          Effect.forEach(
            [...issues.values()].sort((a, b) => a.seq - b.seq),
            (issue) => shown(issues, issue),
          ),
        ),
        get: (id) =>
          Effect.flatMap(Ref.get(state), (issues) => {
            const issue = issues.get(id)
            return issue === undefined ? Effect.succeed(undefined) : shown(issues, issue)
          }),
        put: (seed) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Ref.update(state, (issues) => {
              const existing = issues.get(seed.id)
              if (existing === undefined) seq += 1
              const stored = store(seed, existing?.seq ?? seq, now)
              return new Map(issues).set(seed.id, stored)
            }),
          ),
        fail: (op, fault = {}) =>
          Effect.sync(() => void faults.push({ op, fault, left: fault.times ?? 1 })),
      })

      return Context.make(Beads, beads).pipe(Context.add(Backlog, backlog))
    }),
  )
