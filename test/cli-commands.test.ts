// `tutti answer`, `tutti plan`, `tutti playbook` and `tutti requires` (§ 8.1). Through the binary,
// `bun src/main.ts` started in a repository on real git with the tests' environment and, for plan, a
// fake bd on the PATH, a case or two of each command, proving its exit code and its lines on stdout
// and stderr reach the terminal. The rest runs the command in-process, over in-memory git: answer's
// errors as the command prints them (src/answer/answer.ts), and the problems plan stops on
// (src/plan/plan.ts' settingsProblem and beadsProblem). What the in-process tests of each command
// already cover (test/attention-files.test.ts, test/plan-command.test.ts, test/requires.test.ts,
// test/playbook-run.test.ts) isn't run again here.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Duration, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import {
  answerFile,
  attentionFolder,
  refusedFile,
  requestFile,
} from "../src/agent/attentionFiles.ts"
import { TakeWithin } from "../src/answer/answer.ts"
import { tuttiWith } from "../src/cli/commands.ts"
import { Beads } from "../src/services/Beads.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// A case through the binary starts tutti as a bun process, which bun's 5 s default fails beside
// other checks.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const depAdded = join(import.meta.dir, "fixtures", "bd", "dep-add.json")

/** A fresh folder for a test's own files. */
const folder = (): string => realpathSync(mkdtempSync(join(tmpdir(), "tutti-cli-commands-")))

/** `bun src/main.ts …args` started in `cwd`, `bin` first on its PATH: its exit code and output. */
const tutti = async (cwd: string, args: ReadonlyArray<string>, bin?: string) => {
  const proc = Bun.spawn(["bun", main, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...testEnv,
      ...(bin === undefined ? {} : { PATH: `${bin}:${testEnv.PATH ?? ""}` }),
    },
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/**
 * `tutti …args` run in-process in `dir` over in-memory git, with `beads` for its Beads and
 * `provide` around it: its exit, the lines it logged and those it wrote to stderr.
 */
const inProcess = async (
  dir: string,
  args: ReadonlyArray<string>,
  beads: () => Layer.Layer<Beads, never, BunServices.BunServices> = () => beadsLayer(),
  provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = (effect) => effect,
) => {
  const printed: Array<string> = []
  const errors: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
    error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
  })
  const services = () => Layer.mergeAll(beads(), gitLayer({ dir, files: {} }), lockLayer())
  const exit = await Effect.runPromise(
    Command.runWith(tuttiWith(Effect.succeed(dir), services), {
      version: "test",
      renderErrors: false,
    })(args).pipe(
      provide,
      Effect.provideService(Console.Console, console),
      Effect.exit,
      Effect.provide(BunServices.layer),
    ),
  )
  return { failed: exit._tag === "Failure", printed, errors }
}

// tutti playbook

describe("tutti playbook", () => {
  const seeded = {
    id: "L1",
    text: "Reset the parser's cursor between files.",
    scope: ["src/parse/**"],
    kind: "strategy",
    evidence: [{ ticket: "t-1", event: "check@1" }],
    state: "proposed",
    helpful: 0,
    harmful: 0,
    held_clean: 0,
    held_bad: 0,
    measured: [],
    admitted_at: "2026-11-06T09:00:00Z",
    version: 1,
  }

  test("approves, and refuses what it can't do, in the main checkout", async () => {
    const repo = makeRepo()
    mkdirSync(join(repo.dir, ".tutti"), { recursive: true })
    writeFileSync(join(repo.dir, ".tutti", "playbook.jsonl"), `${JSON.stringify(seeded)}\n`)
    const approved = await tutti(repo.dir, ["playbook", "approve", "L1"])
    expect(approved).toMatchObject({ code: 0, stdout: "L1 approved.\n" })
    expect(readFileSync(join(repo.dir, ".tutti", "playbook.jsonl"), "utf8")).toContain(
      '"state":"active"',
    )
    const refused = await tutti(repo.dir, ["playbook", "retire", "L9"])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("tutti playbook: no lesson L9")
  })
})

// tutti answer

/** An open permission request, as the run writes its file. */
const request = {
  v: 1,
  id: "r1",
  ticket: "t-1",
  kind: "permission",
  tool: "Bash",
  summary: "rm -rf build",
  answers: ["allow", "allow-run", "deny"],
  default_to_no: false,
  suppress_always_allow_rule: false,
  created_at: "2026-10-22T10:00:00Z",
}

/** A repository whose run has the request open, as its file under .tutti/run/attention/. */
const withRequest = () => {
  const repo = makeRepo()
  mkdirSync(join(repo.dir, attentionFolder), { recursive: true })
  writeFileSync(join(repo.dir, requestFile(request.id)), `${JSON.stringify(request)}\n`)
  return repo
}

/** A folder whose run has the request open, for the command run in-process. */
const withRequestIn = () => {
  const dir = folder()
  mkdirSync(join(dir, attentionFolder), { recursive: true })
  writeFileSync(join(dir, requestFile(request.id)), `${JSON.stringify(request)}\n`)
  return dir
}

/**
 * Plays the run's side for up to 30 s: once the answer to request r1 appears, it leaves a refusal
 * saying `refusal` beside it, and takes the answer, removing its file.
 */
const refuseAnswer = async (dir: string, refusal: string): Promise<void> => {
  const answer = join(dir, answerFile("r1"))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(answer)) {
      writeFileSync(
        join(dir, refusedFile("r1")),
        JSON.stringify({ v: 1, request: "r1", reason: refusal }),
      )
      unlinkSync(answer)
      return
    }
    await Bun.sleep(20)
  }
}

describe("tutti answer", () => {
  slow.test("a request without an answer: exit 1, and how to answer it", async () => {
    const repo = withRequest()
    const { code, stdout, stderr } = await tutti(repo.dir, ["answer", "r1"])
    expect(stderr).toBe("tutti answer: say how to answer request r1: allow, allow-run or deny\n")
    expect(stdout).toBe("")
    expect(code).toBe(1)
  })

  test("a request that isn't open: it fails, there is no such request", async () => {
    const dir = withRequestIn()
    for (const id of ["r2", "../r1"]) {
      const { failed, errors } = await inProcess(dir, ["answer", id, "allow"])
      expect(errors).toEqual([
        `tutti answer: there is no open request ${id}; tutti answer lists them`,
      ])
      expect(failed).toBe(true)
    }
  })

  test("a request whose file can't be read: it fails, saying why", async () => {
    const dir = folder()
    mkdirSync(join(dir, attentionFolder), { recursive: true })
    const elsewhere = join(folder(), "r1.json")
    writeFileSync(elsewhere, `${JSON.stringify(request)}\n`)
    symlinkSync(elsewhere, join(dir, requestFile("r1")))
    writeFileSync(join(dir, requestFile("r2")), "not json\n")

    const linked = await inProcess(dir, ["answer", "r1", "allow"])
    expect(linked.errors).toEqual([
      "tutti answer: not answered: its file can't be read: it is a symbolic link",
    ])
    expect(linked.failed).toBe(true)

    const broken = await inProcess(dir, ["answer", "r2", "deny"])
    expect(broken.errors).toHaveLength(1)
    expect(broken.errors[0]).toStartWith(
      "tutti answer: not answered: its file can't be read: it isn't JSON: ",
    )
    expect(broken.failed).toBe(true)
    expect(existsSync(join(dir, answerFile("r1")))).toBe(false)
    expect(existsSync(join(dir, answerFile("r2")))).toBe(false)
  })

  test("an answer that doesn't fit the request: it fails, nothing written", async () => {
    const dir = withRequestIn()
    const { failed, errors } = await inProcess(dir, ["answer", "r1", "allow", "--choice", "yes"])
    expect(errors).toEqual(["tutti answer: not answered: choices answer a question's allow only"])
    expect(failed).toBe(true)
    expect(existsSync(join(dir, answerFile("r1")))).toBe(false)
  })

  test("an answer already waiting for the run: it fails, and the first one stays", async () => {
    const dir = withRequestIn()
    const waiting = `${JSON.stringify({ v: 1, request: "r1", answer: "deny" })}\n`
    writeFileSync(join(dir, answerFile("r1")), waiting)
    const { failed, errors } = await inProcess(dir, ["answer", "r1", "allow"])
    expect(errors).toEqual([
      "tutti answer: an answer to request r1 is already waiting for the run to take it",
    ])
    expect(failed).toBe(true)
    expect(readFileSync(join(dir, answerFile("r1")), "utf8")).toBe(waiting)
  })

  test("an answer that can't be written: it fails, saying why", async () => {
    const dir = withRequestIn()
    const attention = join(dir, attentionFolder)
    chmodSync(attention, 0o555)
    try {
      const { failed, printed, errors } = await inProcess(dir, ["answer", "r1", "deny"])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toStartWith("tutti answer: the answer to request r1 couldn't be written: ")
      expect(errors[0]).toContain("EACCES")
      expect(printed).toEqual([])
      expect(failed).toBe(true)
    } finally {
      chmodSync(attention, 0o755)
    }
    expect(existsSync(join(dir, answerFile("r1")))).toBe(false)
  })

  // The wait is the command's own, 10 s: TakeWithin makes it shorter.
  test("an answer no run takes: it fails after the wait, and the answer withdrawn", async () => {
    const dir = withRequestIn()
    const { failed, errors } = await inProcess(
      dir,
      ["answer", "r1", "deny"],
      () => beadsLayer(),
      Effect.provideService(TakeWithin, Duration.millis(300)),
    )
    expect(errors).toEqual([
      "tutti answer: the run didn't take the answer to request r1 within 0.3 s, so it was withdrawn; is tutti running in this repository?",
    ])
    expect(failed).toBe(true)
    expect(existsSync(join(dir, answerFile("r1")))).toBe(false)
    // Without it, the wait is § 4.5's 10 s.
    const wait = Effect.runSync(
      Effect.gen(function* () {
        return yield* TakeWithin
      }),
    )
    expect(Duration.toSeconds(wait)).toBe(10)
  })

  test("an answer the run refuses: it fails, with the run's reason", async () => {
    const dir = withRequestIn()
    const [, { failed, printed, errors }] = await Promise.all([
      refuseAnswer(dir, "the request was answered in the dashboard"),
      inProcess(dir, ["answer", "r1", "allow"]),
    ])
    expect(errors).toEqual([
      "tutti answer: the run refused the answer: the request was answered in the dashboard",
    ])
    expect(printed).toEqual([])
    expect(failed).toBe(true)
    expect(existsSync(join(dir, refusedFile("r1")))).toBe(false)
  })
})

// tutti plan

/**
 * A bin folder whose bd runs `script`, a shell script's body given the bd's own folder, logging its
 * arguments to `log`.
 */
const fakeBd = (script: (root: string) => string) => {
  const root = folder()
  const bin = join(root, "bin")
  const log = join(root, "bd.log")
  mkdirSync(bin)
  writeFileSync(join(bin, "bd"), `#!/bin/sh\necho "$*" >> '${log}'\n${script(root)}`, {
    mode: 0o755,
  })
  return { bin, root, log }
}

/** A bd that lists `issues` as the open tickets, adds links, and answers `[]` to the rest. */
const listingBd = (issues: ReadonlyArray<object>) => {
  const bd = fakeBd(
    (root) => `case "$1" in
  list) cat '${join(root, "list.json")}' ;;
  dep) cat '${depAdded}' ;;
  *) echo '[]' ;;
esac
`,
  )
  writeFileSync(join(bd.root, "list.json"), JSON.stringify(issues))
  return bd
}

/** An open ticket as bd list gives it. */
const issue = (id: string, priority: number, description: string, created_at: string) => ({
  id,
  title: id,
  description,
  status: "open",
  priority,
  issue_type: "task",
  created_at,
  dependencies: [],
})

/** Two tickets naming the same function, t-1 the higher-priority one. */
const overlapping = [
  issue("t-1", 1, "Retry in `Loop.merge`.", "2026-10-01T00:00:00Z"),
  issue("t-2", 2, "Log each rebase in Loop.merge().", "2026-10-02T00:00:00Z"),
]
// The source declaring the function both name, so that it links them (declared.ts).
const loopSource = "export class Loop {\n  merge() {\n  }\n}\n"

/** The live Beads layer over `bd`'s bd, in `dir`, with these time limits. */
const beadsOver =
  (
    dir: string,
    bd: { readonly bin: string },
    timeLimits?: { readonly read: Duration.Input; readonly write: Duration.Input },
  ) =>
  () =>
    Beads.layer({ cwd: dir, command: join(bd.bin, "bd"), ...(timeLimits && { timeLimits }) })

describe("tutti plan", () => {
  slow.test("bd failing to list the tickets: exit 1, its exit code and stderr", async () => {
    const repo = makeRepo()
    const bd = fakeBd(() => "echo 'no beads database found' >&2\nexit 3\n")
    const { code, stdout, stderr } = await tutti(repo.dir, ["plan"], bd.bin)
    expect(stderr).toMatch(
      /^tutti plan: cannot read the open tickets: bd list .* exited with 3: no beads database found\n$/,
    )
    expect(stdout).toBe("")
    expect(code).toBe(1)
  })

  slow.test("two tickets naming one function: the proposal, and nothing changed", async () => {
    const repo = makeRepo()
    repo.commit("Loop", { "src/run/loop.ts": loopSource })
    const bd = listingBd(overlapping)
    const { code, stdout, stderr } = await tutti(repo.dir, ["plan"], bd.bin)
    expect(stdout).toBe(
      "Proposed 1 blocks link between the 2 open tickets:\n" +
        "  t-2 (P2) waits for t-1 (P1): both touch Loop.merge\n" +
        "Nothing changed. Add them with: tutti plan --apply\n",
    )
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(readFileSync(bd.log, "utf8")).not.toContain("dep add")
  })

  test("settings that aren't JSON: it fails, naming the file and its problem", async () => {
    const dir = folder()
    mkdirSync(join(dir, ".tutti"))
    writeFileSync(join(dir, ".tutti", "settings.json"), "nope\n")
    const bd = listingBd([])
    const { failed, printed, errors } = await inProcess(dir, ["plan"], beadsOver(dir, bd))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith(
      `tutti plan: ${join(dir, ".tutti", "settings.json")} isn't valid JSON: `,
    )
    expect(printed).toEqual([])
    expect(failed).toBe(true)
    expect(existsSync(bd.log)).toBe(false)
  })

  test("settings with an unknown key: it fails, naming the file, the key and its problem", async () => {
    const dir = folder()
    mkdirSync(join(dir, ".tutti"))
    writeFileSync(join(dir, ".tutti", "settings.json"), '{"bogus": 1}\n')
    const bd = listingBd([])
    const { failed, errors } = await inProcess(dir, ["plan"], beadsOver(dir, bd))
    expect(errors).toEqual([
      `tutti plan: ${join(dir, ".tutti", "settings.json")}: bogus: unknown key "bogus"`,
    ])
    expect(failed).toBe(true)
  })

  test("bd listing what isn't a list of tickets: it fails, saying why", async () => {
    const dir = folder()
    const bd = fakeBd(() => "echo 'garbage'\n")
    const { failed, errors } = await inProcess(dir, ["plan"], beadsOver(dir, bd))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(
      /^tutti plan: cannot read the open tickets: \S*bd list .*: a list of issues: not JSON$/,
    )
    expect(failed).toBe(true)
  })

  // bd's read limit is 30 s: the Beads layer is given a shorter one.
  test("bd taking too long to list the tickets: it fails, saying so", async () => {
    const dir = folder()
    const bd = fakeBd(() => "sleep 30\n")
    const { failed, errors } = await inProcess(
      dir,
      ["plan"],
      beadsOver(dir, bd, { read: "300 millis", write: "300 millis" }),
    )
    expect(failed).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(
      /^tutti plan: cannot read the open tickets: \S*bd list .* took too long$/,
    )
  })
})

// tutti requires

const requiring = (requires: ReadonlyArray<object>) => `${JSON.stringify({ requires }, null, 2)}\n`

describe("tutti requires", () => {
  slow.test("outside a repository: exit 2, and why", async () => {
    const outside = folder()
    const { code, stdout, stderr } = await tutti(outside, ["requires"])
    expect(stderr).toStartWith(`tutti requires: ${outside} isn't in a git checkout: `)
    expect(stdout).toBe("")
    expect(code).toBe(2)
  })

  slow.test("an entry missing with --no-install: exit 2, its install not run", async () => {
    const repo = makeRepo()
    repo.commit("Requires", {
      ".tutti/settings.json": requiring([
        { name: "shell", check: "true", manual: "Install a shell." },
        { name: "marker", check: "test -f marker", install: "touch marker" },
      ]),
    })
    const { code, stdout, stderr } = await tutti(repo.dir, ["requires", "--no-install"])
    expect(stdout).toStartWith("shell: met\nmarker: missing: ")
    expect(stderr).toStartWith("REQUIREMENTS_MISSING: marker (")
    expect(code).toBe(2)
    expect(existsSync(join(repo.dir, "marker"))).toBe(false)
  })
})
