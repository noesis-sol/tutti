import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { unmergedLabel } from "../src/run/scope.ts"
import {
  forkKey,
  forkOf,
  labelAtEnd,
  loadUnmerged,
  mergedSince,
  namesTicket,
} from "../src/run/unmerged.ts"
import { Beads, BeadsFailed, type Issue } from "../src/services/Beads.ts"
import { Git, GitWriter, isHash } from "../src/services/Git.ts"
import { layer as backlogLayer, type Seed } from "../src/testing/Beads.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"
import { backlog, type Env, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** The scenario's value, or a test failure saying why it gave none. */
const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const issueOf = (ran: Ran<unknown>, id: string): Issue => {
  const issue = ran.issues.find((each) => each.id === id)
  if (issue === undefined) throw new Error(`no issue ${id}`)
  return issue
}

/** A worktree on `branch` cut from main, with a commit `message`; the worktree's folder. */
const work = (branch: string, message: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const path = `/repo-tutti/${branch.replace("/", "-")}`
    yield* git.addWorktree(repository.dir, path, { branch, base: "main" })
    yield* repository.commit(path, message, files)
    return path
  })

/** Another ticket's commit landing on main. */
const moveMain = (message = "Land something else", files: Files = { "main.txt": "moved\n" }) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    return yield* repository.commit(repository.dir, message, files)
  })

/** Takes the ticket up in the ledger, Working, as its dispatch does. */
const dispatched = (id: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
  })

const withLedger = <A, E>(effect: Effect.Effect<A, E, Env | Ledger>) =>
  Effect.provide(effect, Ledger.layer)

describe("namesTicket", () => {
  const part = fc.stringMatching(/^[a-z0-9]{1,6}$/)
  const id = fc.tuple(part, part).map(([a, b]) => `${a}-${b}`)
  const apart = fc.constantFrom(" ", ":", "(", ")", ",", "\n", "/", "[", "]")

  test("an ID set apart by other characters is named", () => {
    fc.assert(
      fc.property(fc.string(), apart, id, apart, fc.string(), (head, open, ticket, close, tail) => {
        expect(namesTicket(`${head}${open}${ticket}${close}${tail}`, ticket)).toBe(true)
      }),
    )
  })

  test("an ID at either end of the message is named", () => {
    fc.assert(
      fc.property(id, (ticket) => {
        expect(namesTicket(ticket, ticket)).toBe(true)
        expect(namesTicket(`${ticket}: Do it`, ticket)).toBe(true)
        expect(namesTicket(`Do it (${ticket})`, ticket)).toBe(true)
        expect(namesTicket(`Do it for ${ticket}.`, ticket)).toBe(true)
      }),
    )
  })

  test("an ID inside a longer one isn't: id3, xid, x-id, x.id, id-x, the child id.1", () => {
    fc.assert(
      fc.property(id, fc.stringMatching(/^[a-z0-9_]{1,3}$/), (ticket, more) => {
        for (const longer of [
          `${ticket}${more}`,
          `${more}${ticket}`,
          `${more}-${ticket}`,
          `${more}.${ticket}`,
          `${ticket}-${more}`,
          `${ticket}.${more}`,
        ]) {
          expect(namesTicket(`Do ${longer} now`, ticket)).toBe(false)
        }
      }),
    )
  })

  test("a message without the ID never names it, nor does any message an empty ID", () => {
    fc.assert(
      fc.property(fc.string(), id, (message, ticket) => {
        fc.pre(!message.includes(ticket))
        expect(namesTicket(message, ticket)).toBe(false)
        expect(namesTicket(message, "")).toBe(false)
      }),
    )
  })

  test("the ID named once as a whole is enough, after a longer one", () => {
    expect(namesTicket("tut-1.2 builds on tut-1", "tut-1")).toBe(true)
    expect(namesTicket("tut-1.2 builds on tut-12", "tut-1")).toBe(false)
  })
})

describe("forkOf", () => {
  const issue = (metadata: Record<string, unknown>) => ({ metadata }) as unknown as Issue

  test("a commit hash, abbreviated or whole, is the fork", () => {
    expect(forkOf(issue({ [forkKey]: "abc1234" }))).toBe("abc1234")
    expect(forkOf(issue({ [forkKey]: "a".repeat(40) }))).toBe("a".repeat(40))
  })

  test("anything else is none: git could take it for an option or a range", () => {
    for (const value of ["--all", "main", "abc", "ABC1234", "abc1234..main", 1234567, null]) {
      expect(forkOf(issue({ [forkKey]: value }))).toBeUndefined()
    }
    expect(forkOf(issue({}))).toBeUndefined()
  })

  test("isHash takes only lowercase hex of 7 to 64 characters", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(isHash(text)).toBe(/^[0-9a-f]{7,64}$/.test(text))
      }),
    )
  })
})

describe("labelled as the run ends", () => {
  test("a ticket closed and not merged is labelled, its fork noted; one in progress isn't", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").ticket("b").seeds },
      withLedger(
        Effect.gen(function* () {
          const beads = yield* Beads
          const repository = yield* Repository
          const fork = yield* repository.head("main")
          for (const id of ["a", "b"]) {
            yield* dispatched(id)
            yield* work(`tutti/${id}`, `${id}: Do it`, { [`${id}.txt`]: `${id}\n` })
            yield* beads.update(id, { claim: true })
          }
          yield* beads.close("a", "done")
          yield* moveMain()
          const ledger = yield* Ledger
          yield* ledger.transition("a", Move.Verified({ place: 1 }))
          yield* ledger.transition("a", Move.RunEnded({ why: "quit" }))
          yield* ledger.transition("b", Move.RunEnded({ why: "quit" }))
          yield* labelAtEnd(options)
          return fork
        }),
      ),
    )
    const fork = resultOf(ran)
    expect(issueOf(ran, "a").labels).toContain(unmergedLabel)
    expect(issueOf(ran, "a").metadata[forkKey]).toBe(fork)
    expect(issueOf(ran, "b").labels).not.toContain(unmergedLabel)
    expect(issueOf(ran, "b").metadata[forkKey]).toBeUndefined()
    expect(ran.log).toContain(
      "  a is closed but not merged, labelled 'unmerged': tickets it blocks wait until tutti/a is merged into main, in later runs too",
    )
    expect(ran.log.some((line) => line.includes("b is closed"))).toBe(false)
    expect(
      ran.events.filter((record) => record.kind === "info").map((record) => record.ticket),
    ).toEqual(["a"])
  })

  test("a ticket labelled already keeps its fork; one merged in this run loses its label", async () => {
    const ran = await scenario(
      {
        backlog: backlog()
          .ticket("a", {
            status: "closed",
            labels: [unmergedLabel],
            metadata: { [forkKey]: "abc1234" },
          })
          .ticket("c", { status: "closed", labels: [unmergedLabel] }).seeds,
      },
      withLedger(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          for (const id of ["a", "c"]) yield* dispatched(id)
          yield* ledger.transition("a", Move.Verified({ place: 1 }))
          yield* ledger.transition("a", Move.RunEnded({ why: "quit" }))
          yield* ledger.transition("c", Move.NoChange())
          yield* labelAtEnd(options)
        }),
      ),
    )
    resultOf(ran)
    expect(issueOf(ran, "a").labels).toEqual([unmergedLabel])
    expect(issueOf(ran, "a").metadata[forkKey]).toBe("abc1234")
    expect(issueOf(ran, "c").labels).toEqual([])
    expect(ran.log).toEqual([])
  })

  test("bd failing to label it is LABEL_FAILED, and the run goes on", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a", { status: "closed" }).ticket("b", { status: "closed" })
          .seeds,
      },
      withLedger(
        Effect.gen(function* () {
          for (const id of ["a", "b"]) {
            yield* dispatched(id)
            yield* (yield* Ledger).transition(id, Move.Verified({ place: 1 }))
          }
          const beads = yield* Beads
          const refused = new BeadsFailed({
            command: "bd label add a unmerged",
            exitCode: 1,
            stderr: "database is locked",
            noSuchIssue: false,
          })
          yield* labelAtEnd(options).pipe(
            Effect.provideService(Beads, {
              ...beads,
              addLabel: (id, label) =>
                id === "a" ? Effect.fail(refused) : beads.addLabel(id, label),
            }),
          )
        }),
      ),
    )
    resultOf(ran)
    expect(issueOf(ran, "a").labels).toEqual([])
    expect(issueOf(ran, "b").labels).toEqual([unmergedLabel])
    expect(ran.log).toContain(
      "  LABEL_FAILED: bd could not label a 'unmerged': database is locked; later runs may start the tickets it blocks before it merges (bd label add a unmerged)",
    )
    expect(ran.events.find((record) => record.kind === "warn")).toMatchObject({ ticket: "a" })
  })
})

/** Labels the ticket as a run that ends with it closed and not merged does, its fork noted. */
const labelNow = (id: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const beads = yield* Beads
    const repository = yield* Repository
    for (const branch of [`tutti/${id}`, `wt/${id}`]) {
      const fork = yield* Effect.result(git.mergeBase(repository.dir, "main", branch))
      if (fork._tag === "Success") yield* beads.setMetadata(id, forkKey, fork.success)
    }
    yield* beads.addLabel(id, unmergedLabel)
  })

/** Merges the branch into main by hand: a fast-forward. */
const fastForward = (branch: string) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* (yield* Git).fastForward(repository.dir, branch)
  })

const closed = (id: string): Seed => ({ id, status: "closed" })

describe("checked as the run starts", () => {
  for (const prefix of ["tutti", "wt"]) {
    test(`merged by hand on ${prefix}/<id>: the label is removed`, async () => {
      const ran = await scenario(
        { backlog: [closed("a")] },
        Effect.gen(function* () {
          yield* work(`${prefix}/a`, "a: Do it", { "a.txt": "a\n" })
          yield* labelNow("a")
          yield* fastForward(`${prefix}/a`)
          return yield* loadUnmerged(options)
        }),
      )
      expect(resultOf(ran)).toEqual([])
      expect(issueOf(ran, "a").labels).toEqual([])
      expect(ran.log).toHaveLength(1)
      expect(ran.log[0]).toMatch(
        /^ {2}a, left unmerged by an earlier run, is on main now \([0-9a-f]{7} a: Do it\); its 'unmerged' label is removed$/,
      )
    })

    test(`not merged on ${prefix}/<id>: kept, labelled, and handed back`, async () => {
      const ran = await scenario(
        { backlog: [closed("a")] },
        Effect.gen(function* () {
          yield* work(`${prefix}/a`, "a: Do it", { "a.txt": "a\n" })
          yield* labelNow("a")
          yield* moveMain()
          return yield* loadUnmerged(options)
        }),
      )
      const left = resultOf(ran)
      expect(left.map((each) => [each.issue.id, each.branch])).toEqual([["a", `${prefix}/a`]])
      expect(issueOf(ran, "a").labels).toEqual([unmergedLabel])
      expect(ran.log).toEqual([
        `  a was left unmerged by an earlier run; tickets it blocks wait until ${prefix}/a is merged into main or its 'unmerged' label is removed`,
      ])
    })
  }

  test("squash-merged by hand, its branch kept: a commit on main naming it is its merge", async () => {
    const ran = await scenario(
      { backlog: [closed("a")] },
      Effect.gen(function* () {
        yield* work("wt/a", "a: Do it", { "a.txt": "a\n" })
        yield* labelNow("a")
        yield* moveMain()
        yield* moveMain("Squash wt/a (a)", { "a.txt": "a\n" })
        return yield* loadUnmerged(options)
      }),
    )
    expect(resultOf(ran)).toEqual([])
    expect(issueOf(ran, "a").labels).toEqual([])
  })

  test("main naming it without holding the branch's changes isn't its merge", async () => {
    const ran = await scenario(
      { backlog: [closed("a")] },
      Effect.gen(function* () {
        yield* work("tutti/a", "a: Do it", { "a.txt": "a\n" })
        yield* labelNow("a")
        yield* moveMain("b: builds on a")
        return yield* loadUnmerged(options)
      }),
    )
    expect(resultOf(ran).map((each) => each.issue.id)).toEqual(["a"])
    expect(issueOf(ran, "a").labels).toEqual([unmergedLabel])
  })

  test("a branch with no commits of its own, on main, isn't merged by an older commit naming it", async () => {
    const ran = await scenario(
      { backlog: [closed("a")] },
      Effect.gen(function* () {
        yield* moveMain("Plan a")
        const repository = yield* Repository
        yield* (yield* Git).createBranch(repository.dir, "tutti/a", "main")
        yield* labelNow("a")
        return yield* loadUnmerged(options)
      }),
    )
    expect(resultOf(ran).map((each) => each.issue.id)).toEqual(["a"])
    expect(issueOf(ran, "a").labels).toEqual([unmergedLabel])
  })

  test("its branch gone: a commit on main since the fork naming it is its merge", async () => {
    const ran = await scenario(
      { backlog: [closed("a"), closed("b")] },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* moveMain("Older work on a")
        for (const id of ["a", "b"]) {
          const path = yield* work(`tutti/${id}`, `${id}: Do it`, { [`${id}.txt`]: `${id}\n` })
          yield* labelNow(id)
          yield* git.removeWorktree(repository.dir, path, { force: true })
          yield* git.deleteBranch(repository.dir, `tutti/${id}`, { force: true })
        }
        yield* moveMain("Land a by hand (a)", { "a.txt": "a\n" })
        return yield* loadUnmerged(options)
      }),
    )
    // b: only the commit before its fork names a ticket, and not b.
    expect(resultOf(ran).map((each) => [each.issue.id, each.branch])).toEqual([["b", undefined]])
    expect(issueOf(ran, "a").labels).toEqual([])
    expect(ran.log).toContain(
      "  b was left unmerged by an earlier run; tickets it blocks wait until tutti/b is merged into main or its 'unmerged' label is removed",
    )
  })

  test("its branch gone and no fork noted: git can't tell, and the label stays", async () => {
    const ran = await scenario(
      { backlog: [{ ...closed("a"), labels: [unmergedLabel] }] },
      Effect.gen(function* () {
        yield* moveMain("Land a (a)")
        return yield* loadUnmerged(options)
      }),
    )
    expect(resultOf(ran).map((each) => each.issue.id)).toEqual(["a"])
    expect(issueOf(ran, "a").labels).toEqual([unmergedLabel])
  })

  test("only closed tickets are checked; mergedSince alone changes nothing", async () => {
    const ran = await scenario(
      { backlog: [{ id: "o", labels: [unmergedLabel] }, closed("a")] },
      Effect.gen(function* () {
        yield* work("tutti/a", "a: Do it", { "a.txt": "a\n" })
        yield* labelNow("a")
        yield* fastForward("tutti/a")
        const beads = yield* Beads
        const found = yield* mergedSince(yield* beads.show("a"), options)
        const left = yield* loadUnmerged(options)
        return { found, left }
      }),
    )
    const { found, left } = resultOf(ran)
    expect(found.branch).toBe("tutti/a")
    expect(found.merged?.subject).toBe("a: Do it")
    expect(left).toEqual([])
    expect(issueOf(ran, "o").labels).toEqual([unmergedLabel])
  })
})

slow.describe("with real git", () => {
  test("labelled at the end, then found merged by hand on tutti/ and wt/ branches", async () => {
    const repo = makeRepo()
    const real = { repo: repo.dir, base: "main" }
    const branches = { a: "tutti/a", o: "wt/o", s: "tutti/s" } as const
    const paths = Object.fromEntries(
      Object.entries(branches).map(([id, branch]) => {
        const path = repo.worktree(branch)
        repo.commit(`${id}: Do it`, { [`${id}.txt`]: `${id}\n` }, path)
        return [id, path]
      }),
    )
    repo.commit("Land something else", { "main.txt": "moved\n" })
    const forks = Object.fromEntries(
      Object.entries(branches).map(([id, branch]) => [
        id,
        repo.git(["merge-base", "main", branch]).trim(),
      ]),
    )
    const live = Layer.mergeAll(
      Git.layer().pipe(Layer.provideMerge(GitWriter.layer), Layer.provideMerge(BunServices.layer)),
      backlogLayer(Object.keys(branches).map(closed)),
    )
    const ran = await scenario(
      {},
      withLedger(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          // o was orchestra's, labelled on wt/o as it labels a ticket; a and s are this run's.
          const beads = yield* Beads
          yield* beads.setMetadata("o", forkKey, forks.o as string)
          yield* beads.addLabel("o", unmergedLabel)
          for (const id of ["a", "s"]) {
            yield* dispatched(id)
            yield* ledger.transition(id, Move.Verified({ place: 1 }))
            yield* ledger.transition(id, Move.RunEnded({ why: "quit" }))
          }
          yield* labelAtEnd(real)
          const before = yield* loadUnmerged(real)
          // Merged by hand: a rebased and fast-forwarded, o with a merge commit, s squashed.
          yield* Effect.sync(() => {
            repo.git(["rebase", "--quiet", "main"], paths.a)
            repo.git(["merge", "--quiet", "--ff-only", "tutti/a"])
            repo.git(["merge", "--quiet", "--no-ff", "-m", "Merge wt/o", "wt/o"])
            repo.git(["merge", "--quiet", "--squash", "tutti/s"])
            repo.git(["commit", "--quiet", "-m", "Squash tutti/s (s)"])
          })
          const after = yield* loadUnmerged(real)
          return { before, after, issues: yield* beads.list({ all: true }) }
        }),
      ).pipe(Effect.provide(live)),
    )
    const { before, after, issues } = resultOf(ran)
    expect(before.map((each) => [each.issue.id, each.branch]).sort()).toEqual([
      ["a", "tutti/a"],
      ["o", "wt/o"],
      ["s", "tutti/s"],
    ])
    expect(after).toEqual([])
    expect(issues.map((issue) => [issue.id, issue.labels, issue.metadata[forkKey]]).sort()).toEqual(
      Object.keys(branches).map((id) => [id, [], forks[id]]),
    )
  })
})

describe("Git.holds", () => {
  /** main and a branch from it: the branch changes `a.txt`, main as `onMain` says. */
  const cases = [
    { name: "main without the branch's change", onMain: { "b.txt": "b\n" }, holds: false },
    { name: "main with it, squashed", onMain: { "a.txt": "a\n" }, holds: true },
    {
      name: "main changing the same file otherwise (a conflict)",
      onMain: { "a.txt": "x\n" },
      holds: false,
    },
  ] as const

  for (const each of cases) {
    test(`in memory: ${each.name}`, async () => {
      const ran = await scenario(
        {},
        Effect.gen(function* () {
          yield* work("tutti/a", "a: Do it", { "a.txt": "a\n" })
          yield* moveMain("Move main", each.onMain)
          return yield* (yield* Git).holds("/repo", "main", "tutti/a")
        }),
      )
      expect(resultOf(ran)).toBe(each.holds)
    })

    slow.test(`with real git: ${each.name}`, async () => {
      const repo = makeRepo()
      repo.commit("a: Do it", { "a.txt": "a\n" }, repo.worktree("tutti/a"))
      repo.commit("Move main", each.onMain)
      const holds = await Effect.runPromise(
        Effect.flatMap(Effect.service(Git), (git) => git.holds(repo.dir, "main", "tutti/a")).pipe(
          Effect.provide(
            Git.layer().pipe(
              Layer.provideMerge(GitWriter.layer),
              Layer.provideMerge(BunServices.layer),
            ),
          ),
        ),
      )
      expect(holds).toBe(each.holds)
    })
  }
})
