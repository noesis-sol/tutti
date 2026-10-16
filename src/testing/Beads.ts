// Beads' test layer (§ 3.3): an in-memory backlog with bd's semantics, so whole runs can be
// scripted. As bd 1.3 has it, an issue is ready when it is open, not deferred until later and not
// blocked: no blocks link to an issue that isn't closed, on it or on any of its ancestors (a blocked
// epic holds its subtickets back; a deferred or in-progress one doesn't). parent-child,
// discovered-from and related links don't block. A deferral whose date has passed wakes the issue
// as bd ready does. bd close refuses an issue with a live blocker or a child that isn't closed, and
// so does this. Time comes from Effect's Clock, so TestClock moves it.
import { Clock, Context, Effect, Layer, Ref } from "effect"
import {
  Beads,
  BeadsFailed,
  type Dependency,
  type DependencyType,
  HumanLabel,
  type Issue,
  type ListOptions,
  MetadataKey,
  metadataList,
  type NewIssue,
  type ReadyOptions,
  type Status,
  type Update,
} from "../services/Beads.ts"

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
  }
>()("tutti/testing/Beads/Backlog") {}

const notFound = (command: string, id: string) =>
  new BeadsFailed({ command, exitCode: 1, stderr: `Issue ${id} not found`, noSuchIssue: true })

const parentOf = (issue: Stored): string | undefined =>
  issue.links.find((link) => link.type === "parent-child")?.id

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

      /** The issue in the form bd ready and bd list give it: its links, by ID. */
      const brief = (issue: Stored): Issue => ({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        design: issue.design,
        acceptance: issue.acceptance,
        notes: issue.notes,
        status: issue.status,
        priority: issue.priority,
        type: issue.type,
        assignee: issue.assignee,
        labels: issue.labels,
        ...(parentOf(issue) === undefined ? {} : { parent: parentOf(issue) as string }),
        dependencies: issue.links.map((link) => ({ id: link.id, type: link.type })),
        metadata: issue.metadata,
        files: metadataList(issue.metadata, MetadataKey.files),
        predictedFiles: metadataList(issue.metadata, MetadataKey.predictedFiles),
        createdAt: issue.createdAt,
        ...(issue.deferUntil === undefined ? {} : { deferUntil: issue.deferUntil }),
        closeReason: issue.closeReason,
      })

      /** The issue in the form bd show gives it: each issue it links to, without its own links. */
      const full = (issues: ReadonlyMap<string, Stored>, issue: Stored): Issue => ({
        ...brief(issue),
        dependencies: issue.links.flatMap((link): Array<Dependency> => {
          const other = issues.get(link.id)
          return other === undefined
            ? []
            : [{ id: link.id, type: link.type, issue: { ...brief(other), dependencies: [] } }]
        }),
      })

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

      /**
       * Changes the issue, or fails as bd does when it has none by that ID, or when the change
       * would close it and bd refuses to.
       */
      const change = (command: string, id: string, f: (issue: Stored) => Stored) =>
        Effect.flatMap(
          Ref.modify(state, (issues): [Issue | BeadsFailed, Map<string, Stored>] => {
            const issue = issues.get(id)
            if (issue === undefined) return [notFound(command, id), issues]
            const changed = f(issue)
            const refusal =
              changed.status === "closed" && issue.status !== "closed"
                ? refusesToClose(issues, issue)
                : undefined
            if (refusal !== undefined) {
              const refused = new BeadsFailed({
                command,
                exitCode: 1,
                stderr: refusal,
                noSuchIssue: false,
              })
              return [refused, issues]
            }
            return [brief(changed), new Map(issues).set(id, changed)]
          }),
          (issue) => (issue instanceof BeadsFailed ? Effect.fail(issue) : Effect.succeed(issue)),
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
          return [...issues.values()]
            .filter(
              (issue) =>
                isReady(issues, issue, now) &&
                (options.parent === undefined || isDescendant(issues, issue, options.parent)) &&
                !issue.labels.some((label) => options.excludeLabels?.includes(label)) &&
                !options.excludeTypes?.includes(issue.type),
            )
            .sort(byPriorityThen(false))
            .map(brief)
        })

      const show = (id: string) =>
        Effect.flatMap(Ref.get(state), (issues) => {
          const issue = issues.get(id)
          return issue === undefined
            ? Effect.fail(notFound(`bd show ${id} --json`, id))
            : Effect.succeed(full(issues, issue))
        })

      const list = (options: ListOptions = {}) =>
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
            .sort(byPriorityThen(true))
            .map(brief),
        )

      const update = (id: string, update: Update) =>
        change(`bd update ${id}`, id, (issue) => {
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
        Effect.gen(function* () {
          const command = `bd dep add ${id} ${link.id}`
          const issues = yield* Ref.get(state)
          if (!issues.has(link.id)) return yield* notFound(command, link.id)
          yield* change(command, id, (issue) => ({ ...issue, links: withLink(issue.links, link) }))
        })

      const create = (issue: NewIssue) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const issues = yield* Ref.get(state)
          for (const id of [
            ...(issue.parent === undefined ? [] : [issue.parent]),
            ...(issue.blockedBy ?? []),
            ...(issue.blocks ?? []),
            ...(issue.discoveredFrom ?? []),
          ]) {
            if (!issues.has(id)) return yield* notFound("bd create", id)
          }
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
          return brief(stored)
        })

      const beads = Beads.of({
        ready,
        show,
        list,
        update,
        close: (id, reason) =>
          change(`bd close ${id}`, id, (issue) => ({
            ...issue,
            status: "closed",
            closeReason: reason ?? issue.closeReason,
          })),
        defer: (id, deferral = {}) =>
          change(`bd defer ${id}`, id, (issue) => {
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
        addLabel: (id, label) =>
          Effect.asVoid(
            change(`bd label add ${id} ${label}`, id, (issue) => ({
              ...issue,
              labels: issue.labels.includes(label) ? issue.labels : [...issue.labels, label],
            })),
          ),
        removeLabel: (id, label) =>
          Effect.asVoid(
            change(`bd label remove ${id} ${label}`, id, (issue) => ({
              ...issue,
              labels: issue.labels.filter((other) => other !== label),
            })),
          ),
        addDependency: (id, dependsOn, type = "blocks") => addLink(id, { id: dependsOn, type }),
        dependencies: (id, options = {}) =>
          Effect.flatMap(show(id), (issue) =>
            Effect.map(Ref.get(state), (issues) => {
              const linked: ReadonlyArray<Dependency> =
                options.direction === "up"
                  ? [...issues.values()].flatMap((other) =>
                      other.links
                        .filter((link) => link.id === id)
                        .map((link) => ({
                          id: other.id,
                          type: link.type,
                          issue: { ...brief(other), dependencies: [] },
                        })),
                    )
                  : issue.dependencies
              return linked.filter(
                (link) => options.type === undefined || link.type === options.type,
              )
            }),
          ),
        create,
        questions: () =>
          Effect.map(list(), (issues) =>
            issues.filter((issue) => issue.labels.includes(HumanLabel)),
          ),
        metadata: (id) => Effect.map(show(id), (issue) => issue.metadata),
        setMetadata: (id, key, value) =>
          Effect.asVoid(update(id, { setMetadata: { [key]: value } })),
        unsetMetadata: (id, key) => Effect.asVoid(update(id, { unsetMetadata: [key] })),
      })

      const backlog = Backlog.of({
        issues: Effect.map(Ref.get(state), (issues) =>
          [...issues.values()].sort((a, b) => a.seq - b.seq).map((issue) => full(issues, issue)),
        ),
        get: (id) =>
          Effect.map(Ref.get(state), (issues) => {
            const issue = issues.get(id)
            return issue === undefined ? undefined : full(issues, issue)
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
      })

      return Context.make(Beads, beads).pipe(Context.add(Backlog, backlog))
    }),
  )
