// tutti init's Beads and project steps (§ 8.3) in the branches a whole init doesn't reach: bd that
// can't be installed here, lands off the PATH or doesn't come; bd init that commits; the ticket
// prefix's rename refused or failing; CHANGELOG.md already merging by union; the trust fix on a
// .claude.json it can't change; and a probe that failed naming nothing. Each step is called on its
// own, on a temp folder and a scripted machine like test/init.test.ts's.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, type FileSystem } from "effect"
import { type Machine, stepLine } from "../src/init/steps.ts"
import {
  applyPrefix,
  applyUnion,
  type BeadsInstall,
  findBeadsInstall,
  markTrusted,
  prefixRefusal,
  probeSteps,
  setUpBeads,
} from "../src/init/workers.ts"
import type { Beads } from "../src/services/Beads.ts"
import { stateFile } from "../src/services/Store.ts"
import * as TestBeads from "../src/testing/Beads.ts"

/** A temp repository's top and a home folder beside it. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-workers-")))
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(home)
  return { repo, home }
}

type Project = ReturnType<typeof newProject>

/** A command's answer: its stdout, or why it failed. */
type Answer = string | { readonly fail: string }

/**
 * A scripted macOS machine: bd on the PATH where `bd` says so, nothing else on it; each command
 * answered by `answer` ("" by default); the commands it ran, as typed.
 */
const scriptedMachine = (
  project: Project,
  options: {
    readonly bd?: () => boolean
    readonly executable?: (path: string) => boolean
    readonly answer?: (command: string, args: ReadonlyArray<string>) => Answer | undefined
  } = {},
) => {
  const ran: Array<string> = []
  const machine: Machine = {
    run: (command, args) =>
      Effect.suspend(() => {
        ran.push([command, ...args].join(" "))
        const answer = options.answer?.(command, args) ?? ""
        return typeof answer === "string" ? Effect.succeed(answer) : Effect.fail(answer.fail)
      }),
    which: (command) => (command === "bd" && (options.bd?.() ?? true) ? "/opt/bin/bd" : null),
    env: (name) => (name === "HOME" ? project.home : undefined),
    platform: "darwin",
    executable: options.executable ?? (() => false),
  }
  return { machine, ran }
}

/** `effect` on Bun's services and Beads' test layer with `seeds`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Beads | FileSystem.FileSystem>,
  seeds: ReadonlyArray<TestBeads.Seed> = [],
) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.provide(TestBeads.layer(seeds)), Effect.provide(BunServices.layer)),
  )

const ok = async <A, E>(exit: Promise<Exit.Exit<A, E>>): Promise<A> => {
  const done = await exit
  if (Exit.isFailure(done)) throw new Error(`expected a success, got ${done.cause}`)
  return done.value
}

const failure = async <A, E>(exit: Promise<Exit.Exit<A, E>>): Promise<E> => {
  const done = await exit
  if (Exit.isSuccess(done)) throw new Error("expected a failure")
  const reason = done.cause.reasons.find((each) => each._tag === "Fail")
  if (reason?._tag !== "Fail") throw new Error(`expected a failure, got ${done.cause}`)
  return reason.error
}

const brew: BeadsInstall = { method: "Homebrew", command: "brew install beads", manual: "" }

describe("installing bd", () => {
  test("no way to install it here: missing, with how to by hand, and nothing run", async () => {
    const project = newProject()
    const { machine, ran } = scriptedMachine(project, { bd: () => false })
    const install = findBeadsInstall({ ...machine, platform: "win32" })
    const steps = await ok(
      run(setUpBeads(machine, project.repo, { install, consent: true, prefix: null })),
    )
    expect(steps.map(stepLine)).toEqual([
      "✗ bd  not installed, and tutti can't install it here; install it in PowerShell: irm https://raw.githubusercontent.com/gastownhall/beads/main/install.ps1 | iex",
    ])
    expect(ran).toEqual([])

    const elsewhere = findBeadsInstall({ ...machine, platform: "aix" })
    const other = await ok(
      run(setUpBeads(machine, project.repo, { install: elsewhere, consent: true, prefix: null })),
    )
    expect(other.map(stepLine)).toEqual([
      "✗ bd  not installed, and tutti can't install it here; install it as https://beads.gascity.com/getting-started/installation says",
    ])
  })

  test("installed with Homebrew but off the PATH: where it is, and bd init doesn't run", async () => {
    const project = newProject()
    const local = join(project.home, ".local", "bin", "bd")
    const state = { installed: false }
    const { machine, ran } = scriptedMachine(project, {
      bd: () => false,
      executable: (path) => state.installed && path === local,
      answer: (command) => {
        if (command === "brew") state.installed = true
        return undefined
      },
    })
    const steps = await ok(
      run(setUpBeads(machine, project.repo, { install: brew, consent: true, prefix: null })),
    )
    const bin = join(project.home, ".local", "bin")
    expect(steps.map(stepLine)).toEqual([
      `✗ bd  installed with Homebrew, but it is in ${bin}, which isn't on your PATH: add it in your shell's profile (export PATH="$PATH":${bin}) and open a new terminal`,
    ])
    expect(ran).toEqual(["brew install beads"])
  })

  test("the install ran and no bd came: missing, with where to read how by hand", async () => {
    const project = newProject()
    const { machine, ran } = scriptedMachine(project, { bd: () => false })
    const steps = await ok(
      run(setUpBeads(machine, project.repo, { install: brew, consent: true, prefix: null })),
    )
    expect(steps.map(stepLine)).toEqual([
      "✗ bd  brew install beads ran, but bd isn't on the PATH; install it by hand: see https://beads.gascity.com/getting-started/installation",
    ])
    expect(ran).toEqual(["brew install beads"])
  })

  test("the install failed: why, with where to read how by hand", async () => {
    const project = newProject()
    const { machine } = scriptedMachine(project, {
      bd: () => false,
      answer: (command) =>
        command === "brew" ? { fail: "brew install beads exited 1" } : undefined,
    })
    const steps = await ok(
      run(setUpBeads(machine, project.repo, { install: brew, consent: true, prefix: null })),
    )
    expect(steps.map(stepLine)).toEqual([
      "✗ bd  brew install beads exited 1; install it by hand: see https://beads.gascity.com/getting-started/installation",
    ])
  })

  test("declined: not installed, and the command that would", async () => {
    const project = newProject()
    const { machine, ran } = scriptedMachine(project, { bd: () => false })
    const steps = await ok(
      run(setUpBeads(machine, project.repo, { install: brew, consent: false, prefix: null })),
    )
    expect(steps.map(stepLine)).toEqual([
      "✗ bd  not installed (declined); install it with brew install beads",
    ])
    expect(ran).toEqual([])
  })
})

/** A machine on which bd init makes a commit: HEAD is `before`, then `after` once bd init ran. */
const committingMachine = (project: Project, before: string, listed: string) => {
  const state = { initialised: false }
  return scriptedMachine(project, {
    answer: (command, args) => {
      if (command === "bd" && args[0] === "init") {
        state.initialised = true
        return ""
      }
      if (command === "git" && args[0] === "rev-parse") {
        return state.initialised ? "c0ffee\n" : before === "" ? { fail: "no HEAD" } : `${before}\n`
      }
      if (command === "git" && args[0] === "status") {
        return state.initialised
          ? " M README.md\n?? .tutti/settings.json\n?? AGENTS.md\n"
          : " M README.md\n"
      }
      if (
        command === "git" &&
        (args[0] === "ls-tree" || args[0] === "diff") &&
        args[1] !== "--cached"
      ) {
        return listed
      }
      return undefined
    },
  })
}

describe("bd init", () => {
  test("committing the repository's first commit: the files it committed and those it added", async () => {
    const project = newProject()
    const { machine, ran } = committingMachine(
      project,
      "",
      ".beads/config.yaml\n.beads/issues.jsonl\n.gitattributes\n",
    )
    const steps = await ok(
      run(setUpBeads(machine, project.repo, { install: brew, consent: true, prefix: null })),
    )
    expect(ran).toContain("git ls-tree -r --name-only c0ffee")
    expect(steps).toEqual([
      {
        kind: "done",
        label: "Beads",
        detail:
          "ran bd init (maintainer, not contributing to someone else's repo; auto-export off); bd committed .beads/ and .gitattributes; it added .tutti/ and AGENTS.md, to commit with .tutti/",
        commit: [".tutti/", "AGENTS.md"],
      },
    ])
  })

  test("committing on top of HEAD: the files that commit changed", async () => {
    const project = newProject()
    const { machine, ran } = committingMachine(project, "abc123", ".beads/config.yaml\n")
    const steps = await ok(
      run(
        setUpBeads(machine, project.repo, {
          install: brew,
          consent: true,
          prefix: { prefix: "tt", was: null, tickets: 0 },
        }),
      ),
    )
    expect(ran).toContain(
      "bd init --non-interactive --role maintainer --init-if-missing --prefix tt",
    )
    expect(ran).toContain("git diff --name-only abc123 c0ffee")
    expect(steps.map(stepLine)).toEqual([
      "✓ Beads  ran bd init (maintainer, not contributing to someone else's repo; auto-export off); bd committed .beads/; it added .tutti/ and AGENTS.md, to commit with .tutti/",
      "✓ ticket prefix  tt, for the new Beads",
    ])
  })

  test("failing: missing, saying why, and no prefix step", async () => {
    const project = newProject()
    const { machine } = scriptedMachine(project, {
      answer: (command, args) =>
        command === "bd" && args[0] === "init" ? { fail: "bd init exited 1: no dolt" } : undefined,
    })
    const steps = await ok(
      run(
        setUpBeads(machine, project.repo, {
          install: brew,
          consent: true,
          prefix: { prefix: "tt", was: null, tickets: 0 },
        }),
      ),
    )
    expect(steps.map(stepLine)).toEqual(["✗ Beads  bd init exited 1: no dolt"])
  })
})

/** A machine whose bd says the prefix is `tutti`, with the branches `refs` lists. */
const beadsMachine = (project: Project, refs: string, rename: Answer = "") =>
  scriptedMachine(project, {
    answer: (command, args) =>
      command === "git" && args[0] === "for-each-ref"
        ? refs
        : command === "bd" && args[0] === "rename-prefix"
          ? rename
          : undefined,
  })

const plan = { prefix: "tt", was: "tutti", tickets: 3 }

describe("renaming the ticket prefix", () => {
  test("refused while tickets not closed have a branch, tutti's or orchestra's", async () => {
    const project = newProject()
    const { machine } = beadsMachine(
      project,
      "tutti/tutti-1\nwt/tutti-2\ntutti/tutti-3\ntutti/gone\n",
    )
    const seeds = [
      { id: "tutti-1" },
      { id: "tutti-2", status: "in_progress" as const },
      { id: "tutti-3", status: "closed" as const },
    ]
    // In bd list's order; the closed ticket's branch and one with no ticket don't count.
    expect(await ok(run(prefixRefusal(machine, project.repo), seeds))).toBe(
      "tutti/tutti-2 and tutti/tutti-1 have a branch",
    )
    const { machine: one } = beadsMachine(project, "wt/tutti-2\n")
    expect(await ok(run(prefixRefusal(one, project.repo), seeds))).toBe(
      "tutti/tutti-2 has a branch",
    )
  })

  test("refused while the last run left workers in state.json", async () => {
    const project = newProject()
    const { machine } = beadsMachine(project, "")
    const state = join(project.repo, stateFile)
    mkdirSync(join(project.repo, ".tutti", "run"), { recursive: true })
    writeFileSync(state, JSON.stringify({ version: 1, tickets: { "tutti-1": {} } }))
    expect(await ok(run(prefixRefusal(machine, project.repo)))).toBe(
      `the last run left workers in ${stateFile}, which the next run carries on with`,
    )
    // No workers, or a file that isn't JSON, carries nothing.
    for (const text of [JSON.stringify({ version: 1, tickets: {} }), "{not json", "[]"]) {
      writeFileSync(state, text)
      expect(await ok(run(prefixRefusal(machine, project.repo)))).toBeNull()
    }
  })

  test("refused while tickets are closed but unmerged, each reason named", async () => {
    const project = newProject()
    const { machine } = beadsMachine(project, "tutti/tutti-1\n")
    mkdirSync(join(project.repo, ".tutti", "run"), { recursive: true })
    writeFileSync(join(project.repo, stateFile), JSON.stringify({ tickets: { "tutti-1": {} } }))
    const seeds = [
      { id: "tutti-1" },
      { id: "tutti-2", status: "closed" as const, labels: ["unmerged"] },
      { id: "tutti-3", status: "closed" as const, labels: ["unmerged"] },
    ]
    expect(await ok(run(prefixRefusal(machine, project.repo), seeds))).toBe(
      `tutti/tutti-1 has a branch, the last run left workers in ${stateFile}, which the next run carries on with and tutti-3 and tutti-2 are labelled unmerged`,
    )
  })

  test("applyPrefix refused: the prefix kept, why, and bd rename-prefix not run", async () => {
    const project = newProject()
    const { machine, ran } = beadsMachine(project, "")
    const steps = await ok(
      run(applyPrefix(machine, project.repo, plan), [
        { id: "tutti-1", status: "closed", labels: ["unmerged"] },
      ]),
    )
    expect(steps.map(stepLine)).toEqual([
      "✗ ticket prefix  tutti, kept: the tickets can't be renamed to tt while tutti-1 is labelled unmerged",
    ])
    expect(ran.some((command) => command.startsWith("bd rename-prefix"))).toBe(false)
  })

  test("bd rename-prefix failing: the prefix kept, and why", async () => {
    const project = newProject()
    const { machine, ran } = beadsMachine(project, "", {
      fail: "bd rename-prefix exited 1: locked",
    })
    const steps = await ok(run(applyPrefix(machine, project.repo, plan)))
    expect(ran).toContain("bd rename-prefix tt-")
    expect(steps.map(stepLine)).toEqual([
      "✗ ticket prefix  tutti, kept: bd rename-prefix exited 1: locked",
    ])
  })

  test("the same prefix is kept, and a new Beads has no step", async () => {
    const project = newProject()
    const { machine, ran } = beadsMachine(project, "")
    const same = await ok(run(applyPrefix(machine, project.repo, { ...plan, prefix: "tutti" })))
    expect(same.map(stepLine)).toEqual(["• ticket prefix  tutti, kept"])
    expect(await ok(run(applyPrefix(machine, project.repo, { ...plan, was: null })))).toEqual([])
    expect(ran).toEqual([])
  })
})

describe("CHANGELOG.md merge=union", () => {
  test("already merging by union: kept, and .gitattributes not written", async () => {
    const project = newProject()
    writeFileSync(join(project.repo, "CHANGELOG.md"), "# Changelog\n")
    const { machine, ran } = scriptedMachine(project, {
      answer: (command, args) =>
        command === "git" && args[0] === "check-attr" ? "CHANGELOG.md: merge: union\n" : undefined,
    })
    const steps = await ok(run(applyUnion(machine, project.repo, true)))
    expect(ran).toEqual(["git check-attr merge -- CHANGELOG.md"])
    expect(steps.map(stepLine)).toEqual([
      "• changelog  CHANGELOG.md merges by union: two tickets adding entries at the same spot keep both",
    ])
    expect(() => readFileSync(join(project.repo, ".gitattributes"))).toThrow()
  })
})

describe("marking the checkout trusted", () => {
  test("a .claude.json that can't be read, other than missing, fails and is left alone", async () => {
    const project = newProject()
    // A folder where the file is: reading it fails, and not because it isn't there.
    const file = join(project.home, ".claude.json")
    mkdirSync(file)
    const why = await failure(run(markTrusted(file, project.repo)))
    expect(why).toStartWith(`${file} can't be read: `)
  })

  test("a .claude.json that isn't a JSON object, or isn't JSON, fails and is left as it is", async () => {
    const project = newProject()
    const file = join(project.home, ".claude.json")
    for (const text of ["[1, 2]", "null", '"text"', "42"]) {
      writeFileSync(file, text)
      expect(await failure(run(markTrusted(file, project.repo)))).toBe(
        `${file} isn't a JSON object; it was left as it is`,
      )
      expect(readFileSync(file, "utf8")).toBe(text)
    }
    writeFileSync(file, "{oops")
    expect(await failure(run(markTrusted(file, project.repo)))).toBe(
      `${file} isn't valid JSON; it was left as it is`,
    )
    expect(readFileSync(file, "utf8")).toBe("{oops")
  })
})

describe("the login probe's steps", () => {
  test("a probe that failed naming no failure: missing login, with its cause", () => {
    const steps = probeSteps(Exit.die(new Error("the SDK went away")))
    expect(steps).toHaveLength(1)
    expect(steps[0]?.kind).toBe("missing")
    expect(steps[0]?.label).toBe("login")
    expect(steps[0]?.detail).toStartWith("the probe failed: ")
    expect(steps[0]?.detail).toContain("the SDK went away")
  })
})
