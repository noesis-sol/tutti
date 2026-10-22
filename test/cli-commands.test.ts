// `tutti answer`, `tutti plan` and `tutti requires` end to end (§ 8.1): `bun src/main.ts` started in
// a repository on real git, with the tests' environment and, for plan, a fake bd on the PATH. Each
// command's lines on stdout and stderr and its exit code: answer's listing and its errors as the
// command prints them (src/answer/answer.ts), plan's proposal and the problems it stops on
// (src/plan/plan.ts' settingsProblem and beadsProblem), and requires' exit codes.
import { describe, expect, setDefaultTimeout } from "bun:test"
import {
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
import {
  answerFile,
  attentionFolder,
  refusedFile,
  requestFile,
} from "../src/agent/attentionFiles.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Each test starts tutti as a bun process, which bun's 5 s default fails beside other checks; an
// answer no run takes waits its 10 s first.
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

/**
 * Plays the run's side for up to 30 s: once the answer to request r1 appears, it leaves a refusal saying
 * `refusal` beside it when given, and takes the answer, removing its file; the answer's text.
 */
const takeAnswer = async (dir: string, refusal?: string): Promise<string | undefined> => {
  const answer = join(dir, answerFile("r1"))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(answer)) {
      const text = readFileSync(answer, "utf8")
      if (refusal !== undefined) {
        writeFileSync(
          join(dir, refusedFile("r1")),
          JSON.stringify({ v: 1, request: "r1", reason: refusal }),
        )
      }
      unlinkSync(answer)
      return text
    }
    await Bun.sleep(20)
  }
  return undefined
}

describe("tutti answer", () => {
  slow.test("with no requests open, says there are none", async () => {
    const repo = makeRepo()
    const { code, stdout, stderr } = await tutti(repo.dir, ["answer"])
    expect(stdout).toBe("No open requests.\n")
    expect(stderr).toBe("")
    expect(code).toBe(0)
  })

  slow.test("lists an open request, and --json gives its file's fields", async () => {
    const repo = withRequest()
    const listed = await tutti(repo.dir, ["answer"])
    expect(listed.stdout).toBe(
      "r1  t-1  permission: Bash(rm -rf build)\n    answer with: tutti answer r1 allow | allow-run | deny\n",
    )
    expect(listed.code).toBe(0)

    const json = await tutti(repo.dir, ["answer", "--json"])
    expect(JSON.parse(json.stdout)).toEqual([request])
    expect(json.stderr).toBe("")
    expect(json.code).toBe(0)
  })

  slow.test("a request without an answer: exit 1, and how to answer it", async () => {
    const repo = withRequest()
    const { code, stdout, stderr } = await tutti(repo.dir, ["answer", "r1"])
    expect(stderr).toBe("tutti answer: say how to answer request r1: allow, allow-run or deny\n")
    expect(stdout).toBe("")
    expect(code).toBe(1)
  })

  slow.test("a request that isn't open: exit 1, there is no such request", async () => {
    const repo = withRequest()
    for (const id of ["r2", "../r1"]) {
      const { code, stderr } = await tutti(repo.dir, ["answer", id, "allow"])
      expect(stderr).toBe(`tutti answer: there is no open request ${id}; tutti answer lists them\n`)
      expect(code).toBe(1)
    }
  })

  slow.test("a request whose file can't be read: exit 1, and why", async () => {
    const repo = makeRepo()
    const attention = join(repo.dir, attentionFolder)
    mkdirSync(attention, { recursive: true })
    const elsewhere = join(folder(), "r1.json")
    writeFileSync(elsewhere, `${JSON.stringify(request)}\n`)
    symlinkSync(elsewhere, join(repo.dir, requestFile("r1")))
    writeFileSync(join(repo.dir, requestFile("r2")), "not json\n")

    const linked = await tutti(repo.dir, ["answer", "r1", "allow"])
    expect(linked.stderr).toBe(
      "tutti answer: not answered: its file can't be read: it is a symbolic link\n",
    )
    expect(linked.code).toBe(1)

    const broken = await tutti(repo.dir, ["answer", "r2", "deny"])
    expect(broken.stderr).toStartWith(
      "tutti answer: not answered: its file can't be read: it isn't JSON: ",
    )
    expect(broken.code).toBe(1)
    expect(existsSync(join(repo.dir, answerFile("r1")))).toBe(false)
    expect(existsSync(join(repo.dir, answerFile("r2")))).toBe(false)
  })

  slow.test("an answer that doesn't fit the request: exit 1, nothing written", async () => {
    const repo = withRequest()
    const { code, stderr } = await tutti(repo.dir, ["answer", "r1", "allow", "--choice", "yes"])
    expect(stderr).toBe("tutti answer: not answered: choices answer a question's allow only\n")
    expect(code).toBe(1)
    expect(existsSync(join(repo.dir, answerFile("r1")))).toBe(false)
  })

  slow.test("an answer already waiting for the run: exit 1, and the first one stays", async () => {
    const repo = withRequest()
    const waiting = `${JSON.stringify({ v: 1, request: "r1", answer: "deny" })}\n`
    writeFileSync(join(repo.dir, answerFile("r1")), waiting)
    const { code, stderr } = await tutti(repo.dir, ["answer", "r1", "allow"])
    expect(stderr).toBe(
      "tutti answer: an answer to request r1 is already waiting for the run to take it\n",
    )
    expect(code).toBe(1)
    expect(readFileSync(join(repo.dir, answerFile("r1")), "utf8")).toBe(waiting)
  })

  slow.test("an answer no run takes: exit 1 after 10 s, and the answer withdrawn", async () => {
    const repo = withRequest()
    const started = Date.now()
    const { code, stdout, stderr } = await tutti(repo.dir, ["answer", "r1", "deny"])
    expect(stderr).toBe(
      "tutti answer: the run didn't take the answer to request r1 within 10 s, so it was withdrawn; is tutti running in this repository?\n",
    )
    expect(stdout).toBe("")
    expect(code).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000)
    expect(existsSync(join(repo.dir, answerFile("r1")))).toBe(false)
  })

  slow.test("an answer the run takes: exit 0, and the answer as written", async () => {
    const repo = withRequest()
    const [taken, { code, stdout, stderr }] = await Promise.all([
      takeAnswer(repo.dir),
      tutti(repo.dir, ["answer", "r1", "deny", "--reason", "not now"]),
    ])
    expect(JSON.parse(taken ?? "null")).toEqual({
      v: 1,
      request: "r1",
      answer: "deny",
      reason: "not now",
    })
    expect(stdout).toBe("The run took the answer to request r1: deny.\n")
    expect(stderr).toBe("")
    expect(code).toBe(0)
  })

  slow.test("an answer the run refuses: exit 1, and the run's reason", async () => {
    const repo = withRequest()
    const [, { code, stdout, stderr }] = await Promise.all([
      takeAnswer(repo.dir, "the request was answered in the dashboard"),
      tutti(repo.dir, ["answer", "r1", "allow"]),
    ])
    expect(stderr).toBe(
      "tutti answer: the run refused the answer: the request was answered in the dashboard\n",
    )
    expect(stdout).toBe("")
    expect(code).toBe(1)
    expect(existsSync(join(repo.dir, refusedFile("r1")))).toBe(false)
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

describe("tutti plan", () => {
  slow.test("without .tutti/settings.json, reads the tickets with the defaults", async () => {
    const repo = makeRepo()
    const bd = listingBd([])
    const { code, stdout, stderr } = await tutti(repo.dir, ["plan"], bd.bin)
    expect(stdout).toBe(
      "No links to add: no two of the 0 open tickets touch the same code without being ordered already.\n",
    )
    expect(stderr).toBe("")
    expect(code).toBe(0)
  })

  slow.test("settings that aren't JSON: exit 1, the file and its problem", async () => {
    const repo = makeRepo()
    repo.write({ ".tutti/settings.json": "nope\n" })
    const bd = listingBd([])
    const { code, stdout, stderr } = await tutti(repo.dir, ["plan"], bd.bin)
    expect(stderr).toStartWith(
      `tutti plan: ${join(repo.dir, ".tutti", "settings.json")} isn't valid JSON: `,
    )
    expect(stdout).toBe("")
    expect(code).toBe(1)
    expect(existsSync(bd.log)).toBe(false)
  })

  slow.test("settings with an unknown key: exit 1, the file, the key and its problem", async () => {
    const repo = makeRepo()
    repo.write({ ".tutti/settings.json": '{"bogus": 1}\n' })
    const bd = listingBd([])
    const { code, stderr } = await tutti(repo.dir, ["plan"], bd.bin)
    expect(stderr).toBe(
      `tutti plan: ${join(repo.dir, ".tutti", "settings.json")}: bogus: unknown key "bogus"\n`,
    )
    expect(code).toBe(1)
  })

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

  slow.test("bd listing what isn't a list of tickets: exit 1, and why", async () => {
    const repo = makeRepo()
    const bd = fakeBd(() => "echo 'garbage'\n")
    const { code, stderr } = await tutti(repo.dir, ["plan"], bd.bin)
    expect(stderr).toMatch(
      /^tutti plan: cannot read the open tickets: bd list .*: a list of issues: not JSON\n$/,
    )
    expect(code).toBe(1)
  })

  slow.test("two tickets naming one function: the proposal, and nothing changed", async () => {
    const repo = makeRepo()
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

  slow.test("--apply adds the proposed link with bd dep add", async () => {
    const repo = makeRepo()
    const bd = listingBd(overlapping)
    const { code, stdout, stderr } = await tutti(repo.dir, ["plan", "--apply"], bd.bin)
    expect(stdout).toBe(
      "Adding 1 blocks link between the 2 open tickets:\n" +
        "  t-2 (P2) waits for t-1 (P1): both touch Loop.merge\n" +
        "Added 1 link.\n",
    )
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(readFileSync(bd.log, "utf8")).toContain("dep add t-2 t-1 --json --type=blocks\n")
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

  slow.test("no requires list: exit 0, and that there is none", async () => {
    const repo = makeRepo()
    const { code, stdout } = await tutti(repo.dir, ["requires"])
    expect(stdout).toBe("No requirements: .tutti/settings.json has no 'requires' list.\n")
    expect(code).toBe(0)
  })

  slow.test("an entry whose check passes: its line, exit 0", async () => {
    const repo = makeRepo()
    repo.commit("Requires", {
      ".tutti/settings.json": requiring([
        { name: "shell", check: "true", manual: "Install a shell." },
      ]),
    })
    const { code, stdout, stderr } = await tutti(repo.dir, ["requires"])
    expect(stdout).toBe("shell: met\n")
    expect(stderr).toBe("")
    expect(code).toBe(0)
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
