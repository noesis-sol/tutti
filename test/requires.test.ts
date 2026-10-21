// The project's requires list (§ 8.4's `requires`), as orchestra 0.9.1's: the entries the settings
// take and refuse; the check of the list, installing what it can, and the lines that say how each
// was found; the README's section on what to install, generated from the list; init's steps for
// it; `tutti requires`; and the note on the list in a worker's standing rules.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import fc from "fast-check"
import { type RequiresFlags, requires } from "../src/cli/requires.ts"
import { type InitSummary, init } from "../src/init/init.ts"
import { readmeSteps, requiresSteps } from "../src/init/requires.ts"
import type { Machine } from "../src/init/steps.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { builtInWorkerPrompt, requiresNote, requiresRule } from "../src/project/prompt.ts"
import {
  readmeMarkersProblem,
  readmeStaleLine,
  readmeStateOf,
  requiresEnd,
  requiresMarkdown,
  requiresStart,
  withRequires,
} from "../src/project/requires.ts"
import { personAsked, type Requirement, Settings } from "../src/project/settings.ts"
import { checkRequires, missingDetail, says, summaryOf, whyMissing } from "../src/run/requires.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-requires-")))

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

/** The problems with `requires` as the settings read it, each `path: message`. */
const problems = (requires: unknown): ReadonlyArray<string> => {
  const decoded = decodeConfig(Settings, "settings.json", { requires })
  if (Exit.isSuccess(decoded)) return []
  return decoded.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail"
      ? reason.error.problems.map((problem) => `${problem.path}: ${problem.message}`)
      : [],
  )
}

/** A project at a temp folder with `requires` in its settings, and `readme` as its README.md. */
const project = (requires: ReadonlyArray<Requirement>, readme?: string) => {
  const repo = folder()
  mkdirSync(join(repo, ".tutti"))
  writeFileSync(join(repo, ".tutti", "settings.json"), JSON.stringify({ requires }))
  if (readme !== undefined) writeFileSync(join(repo, "README.md"), readme)
  return repo
}

describe("the settings' requires list", () => {
  test("takes entries with a check and an install or a manual step, none by default", () => {
    const decoded = decodeConfig(Settings, "settings.json", {
      requires: [
        { name: "jq", check: "command -v jq", install: "brew install jq", platforms: ["darwin"] },
        { name: "docker", check: "docker info", manual: "start Docker Desktop" },
      ],
    })
    expect(Exit.isSuccess(decoded) && decoded.value.requires.map((r) => r.name)).toEqual([
      "jq",
      "docker",
    ])
    const none = decodeConfig(Settings, "settings.json", {})
    expect(Exit.isSuccess(none) && none.value.requires).toEqual([])
  })

  test("refuses an entry a run couldn't check or install, saying why", () => {
    expect(
      problems([
        { name: "j q", check: "x", install: "y" },
        { name: "a", check: " ", install: "y" },
        { name: "b", check: "x" },
        { name: "c", check: "x", install: "y", manual: "z" },
        { name: "d", check: "x", install: "FOO=1 sudo apt-get install d" },
        { name: "e", check: "x", manual: "m", platforms: ["windows"] },
      ]),
    ).toEqual([
      `requires[0]: needs a name of letters, digits and . _ + -, such as "jq" (got "j q")`,
      `requires[1]: needs a check: a command that exits 0 when it is met, such as "command -v a"`,
      "requires[2]: needs an install (a command that meets it) or manual (what a person must do)",
      "requires[3]: has both an install and manual: give the one that meets it",
      "requires[4]: install runs sudo, which asks for a password: an install runs without a terminal. Give it as manual instead, or install without sudo (got 'FOO=1 sudo apt-get install d')",
      'requires[5].platforms[0]: Expected one of darwin, linux, got "windows"',
    ])
    expect(
      problems([
        { name: "a", check: "x", install: "y" },
        { name: "a", check: "x", manual: "y" },
      ]),
    ).toEqual(['requires: has two entries named "a"'])
  })

  test("finds the command that asks for a password wherever the install line runs it", () => {
    expect(personAsked("brew install jq")).toBeUndefined()
    expect(personAsked("apt-get update && sudo apt-get install jq")).toBe("sudo")
    expect(personAsked("env X=1 doas pkg_add jq")).toBe("doas")
    expect(personAsked("(cd x; exec su -c make)")).toBe("su")
    expect(personAsked("curl -fsSL x | pkexec sh")).toBe("pkexec")
    // A word that only contains one isn't one.
    expect(personAsked("echo sudo; pseudo-install")).toBeUndefined()
  })

  test("never finds one in a line without those words", () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        const found = personAsked(line)
        return found === undefined || line.includes(found)
      }),
    )
    fc.assert(
      fc.property(fc.string(), fc.constantFrom("sudo", "su", "doas", "pkexec"), (line, word) => {
        return personAsked(`${line}; ${word} x`) !== undefined
      }),
    )
  })
})

const jq: Requirement = { name: "jq", check: "command -v jq", install: "brew install jq" }
const docker: Requirement = { name: "docker", check: "exit 1", manual: "start Docker Desktop" }

describe("the README's section on what to install", () => {
  test("lists each requirement, how it is checked and how it is installed", () => {
    expect(
      requiresMarkdown([
        { ...jq, platforms: ["darwin"] },
        docker,
        { name: "tool", check: "test -x `which tool`", install: "make\nmake install" },
      ]),
    ).toBe(`<!-- tutti:requires -->
<!-- Generated from "requires" in .tutti/settings.json: change the list, then run tutti requires --readme. -->
## What to install

What this project needs of the machine, from \`"requires"\` in \`.tutti/settings.json\`. \`tutti requires\` checks each one and installs what it can.

- **jq** (only on macOS)
  - check: \`command -v jq\`
  - install: \`brew install jq\`
- **docker**
  - check: \`exit 1\`
  - by hand: start Docker Desktop
- **tool**
  - check: \`\` test -x \`which tool\` \`\`
  - install:

    \`\`\`sh
    make
    make install
    \`\`\`

<!-- /tutti:requires -->
`)
    expect(requiresMarkdown([])).toContain("Nothing yet: the project's requires list")
  })

  test("is added at a README's end, then replaced in place, keeping the rest", () => {
    const added = withRequires("# Project\n\nIntro.\n\n\n", [jq]) ?? ""
    expect(added).toBe(`# Project\n\nIntro.\n\n${requiresMarkdown([jq])}`)
    const around = `${added}\n## Later\n`
    const replaced = withRequires(around, [docker]) ?? ""
    expect(replaced).toBe(`# Project\n\nIntro.\n\n${requiresMarkdown([docker])}\n## Later\n`)
    expect(readmeStateOf(replaced, [docker])).toBe("inStep")
    expect(readmeStateOf(replaced, [jq])).toBe("stale")
    expect(readmeStateOf("# Project\n", [jq])).toBe("noSection")
    expect(withRequires("", [jq])).toBe(requiresMarkdown([jq]))
  })

  test("keeps a README's CRLF line endings", () => {
    const text = withRequires("# Project\r\n", [jq]) ?? ""
    expect(text).toBe(`# Project\r\n\r\n${requiresMarkdown([jq]).replaceAll("\n", "\r\n")}`)
    expect(readmeStateOf(text, [jq])).toBe("inStep")
  })

  test("leaves a README whose markers don't pair up as it is", () => {
    for (const text of [
      `${requiresStart}\n`,
      `${requiresEnd}\n`,
      `${requiresEnd}\n${requiresStart}\n`,
      `${requiresStart}\n${requiresStart}\n${requiresEnd}\n`,
    ]) {
      expect(withRequires(text, [jq])).toBeUndefined()
      expect(readmeStateOf(text, [jq])).toBe("unpaired")
    }
    // A marker inside a line isn't one.
    expect(readmeStateOf(`see ${requiresStart} here\n`, [jq])).toBe("noSection")
  })

  test("written into any README, is in step with the list, and writing again changes nothing", () => {
    const line = fc.string().filter((text) => !text.includes("<!--"))
    fc.assert(
      fc.property(fc.array(line), (lines) => {
        const text = lines.join("\n")
        const once = withRequires(text, [jq, docker])
        if (once === undefined) return false
        return (
          readmeStateOf(once, [jq, docker]) === "inStep" &&
          withRequires(once, [jq, docker]) === once &&
          once.startsWith(text.replace(/[\r\n]+$/u, ""))
        )
      }),
    )
  })

  test("a run's start says when the README differs from the list, or has no section", async () => {
    const stale = await run(readmeStaleLine(project([jq], "# P\n"), [jq]))
    expect(stale).toBe(
      "README.md has no section on what to install from the requires list in .tutti/settings.json: tutti requires --readme writes it, to commit",
    )
    const differs = project([jq], `# P\n\n${requiresMarkdown([docker])}`)
    expect(await run(readmeStaleLine(differs, [jq]))).toBe(
      "README.md's section on what to install differs from the requires list in .tutti/settings.json: tutti requires --readme writes it, to commit",
    )
    expect(await run(readmeStaleLine(project([], "# P\n"), []))).toBeNull()
    expect(await run(readmeStaleLine(project([jq]), [jq]))).toBeNull()
    const inStep = project([jq], `# P\n\n${requiresMarkdown([jq])}`)
    expect(await run(readmeStaleLine(inStep, [jq]))).toBeNull()
    const unpaired = project([jq], `# P\n${requiresStart}\n`)
    expect(await run(readmeStaleLine(unpaired, [jq]))).toBe(readmeMarkersProblem)
  })
})

describe("the check of the list", () => {
  test("checks each requirement, installs what it can, and skips another system's", async () => {
    const repo = folder()
    const made = join(repo, "made")
    const list: ReadonlyArray<Requirement> = [
      { name: "met", check: "true", install: "false" },
      { name: "made", check: `test -f ${made}`, install: `touch ${made}` },
      { name: "other", check: "false", install: "true", platforms: ["linux"] },
      docker,
      { name: "broken", check: "false", install: "echo no >&2; exit 4" },
      { name: "useless", check: "false", install: "true" },
    ]
    const working: Array<string> = []
    const report = await run(
      checkRequires(list, {
        repo,
        installLimit: "1 minute",
        platform: "darwin",
        working: (what) => Effect.sync(() => working.push(what)),
      }),
    )
    expect(report.map((res) => [res.requirement.name, res.state])).toEqual([
      ["met", "met"],
      ["made", "installed"],
      ["other", "otherOS"],
      ["docker", "missing"],
      ["broken", "missing"],
      ["useless", "missing"],
    ])
    expect(working).toEqual([
      "checking 5 requirements",
      `installing made: touch ${made}`,
      "installing broken: echo no >&2; exit 4",
      "installing useless: true",
    ])
    const log = (name: string) => join(repo, ".tutti", "run", `requires-${name}.log`)
    expect(readFileSync(log("broken"), "utf8")).toBe("no\n")
    expect(report.map(says)).toEqual([
      "met",
      `installed with 'touch ${made}'`,
      "not checked: only on linux",
      "missing: start Docker Desktop",
      `missing: 'echo no >&2; exit 4' failed: exit status 4; its output is in ${log("broken")}`,
      `missing: 'true' ran, but 'false' still fails; its output is in ${log("useless")}`,
    ])
    expect(summaryOf(report)).toBe(
      `met met; made (installed with 'touch ${made}') installed; other (only on linux) not checked`,
    )
    expect(missingDetail(report)).toBe(
      `docker (start Docker Desktop); broken ('echo no >&2; exit 4' failed: exit status 4; its output is in ${log("broken")}); useless ('true' ran, but 'false' still fails; its output is in ${log("useless")}); meet them (each entry of 'requires' in .tutti/settings.json says how), then run again`,
    )
  })

  test("with no install, a failed check is missing and says how to install it", async () => {
    const repo = folder()
    const report = await run(
      checkRequires([{ name: "x", check: "false", install: "make x" }], {
        repo,
        installLimit: "1 minute",
        noInstall: true,
      }),
    )
    expect(report.map(whyMissing)).toEqual(["'false' fails; install it with 'make x'"])
    expect(existsSync(join(repo, ".tutti", "run", "requires-x.log"))).toBe(false)
    expect(missingDetail([])).toBe("")
    // An empty install beside a manual step installs nothing.
    const manual = await run(
      checkRequires([{ name: "lic", check: "false", install: "", manual: "accept it" }], {
        repo,
        installLimit: "1 minute",
      }),
    )
    expect(manual.map((res) => [res.ran, says(res)])).toEqual([[false, "missing: accept it"]])
    expect(existsSync(join(repo, ".tutti", "run", "requires-lic.log"))).toBe(false)
  })

  test("an install past its time limit is stopped, and says so", async () => {
    const report = await run(
      checkRequires([{ name: "slow", check: "false", install: "sleep 30" }], {
        repo: folder(),
        installLimit: "200 millis",
      }),
    )
    expect(report[0]?.installError).toBe("timed out: stopped after 200ms")
  })
})

describe("init and the requires list", () => {
  test("writes the README's section where it has none and the list has entries", async () => {
    const repo = project([jq], "# P\n")
    const steps = await run(readmeSteps(repo, [jq]))
    expect(steps).toEqual([
      {
        kind: "done",
        label: "README",
        detail: `wrote README.md's section on what to install from the requires list, between ${requiresStart} and ${requiresEnd}`,
        commit: ["README.md"],
      },
    ])
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe(`# P\n\n${requiresMarkdown([jq])}`)
    expect((await run(readmeSteps(repo, [jq])))[0]?.kind).toBe("kept")
    expect((await run(readmeSteps(repo, [docker])))[0]?.detail).toStartWith("updated README.md's")
    // No README.md, or an empty list and no section: nothing to say.
    expect(await run(readmeSteps(project([jq]), [jq]))).toEqual([])
    expect(await run(readmeSteps(project([], "# P\n"), []))).toEqual([])
    const unpaired = await run(readmeSteps(project([jq], `${requiresEnd}\n`), [jq]))
    expect(unpaired[0]?.kind).toBe("caution")
  })

  test("checks each requirement, a step each", async () => {
    const repo = project([{ name: "met", check: "true", install: "false" }, docker])
    expect(await run(requiresSteps(repo))).toEqual([
      { kind: "done", label: "met", detail: "" },
      { kind: "missing", label: "docker", detail: "start Docker Desktop" },
    ])
  })

  test("a whole init writes the section and lists the requirements, what is missing first to fix", async () => {
    const repo = project([{ name: "met", check: "true", install: "false" }, docker], "# P\n")
    mkdirSync(join(repo, ".git"))
    mkdirSync(join(repo, ".beads"))
    const home = folder()
    const machine: Machine = {
      run: (command, args) =>
        Effect.succeed(
          command === "bd" && args[0] === "config"
            ? JSON.stringify({ schema_version: 1, data: { key: "issue_prefix", value: "tutti" } })
            : "",
        ),
      which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
      env: (name) => (name === "HOME" ? home : undefined),
      platform: "darwin",
      executable: () => false,
    }
    const summary: InitSummary = await Effect.runPromise(
      init({
        repo,
        commonDir: join(repo, ".git"),
        branch: "main",
        version: "0.1.0",
        flags: { force: false },
        form: null,
        scout: Effect.fail("there is no scout in these tests"),
        machine,
        configure: Effect.succeed(TestAppConfig.appConfig({}, repo)),
        account: TestAccount.layer(),
        claudeConfig: join(home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } }))),
        Effect.provide(BunServices.layer),
      ),
    )
    const labels = summary.steps.map((each) => each.label)
    expect(labels).toContain("README")
    expect(labels.indexOf("met")).toBeGreaterThan(labels.indexOf("README"))
    expect(summary.steps.find((each) => each.label === "docker")).toEqual({
      kind: "missing",
      label: "docker",
      detail: "start Docker Desktop",
    })
    expect(summary.ready).toBe(false)
    expect(summary.next[0]).toBe("Fix what's missing above (docker: start Docker Desktop).")
    expect(readFileSync(join(repo, "README.md"), "utf8")).toContain(requiresStart)
  })
})

describe("tutti requires", () => {
  const said = async (repo: string, flags: Partial<RequiresFlags> = {}) => {
    const out: Array<string> = []
    const error: Array<string> = []
    const code = await run(
      requires(
        repo,
        { noInstall: false, markdown: false, readme: false, ...flags },
        { out: (line) => out.push(line), error: (line) => error.push(line) },
      ),
    )
    return { code, out, error }
  }

  test("prints each requirement's state, exit 2 with what is still missing", async () => {
    const repo = project([{ name: "met", check: "true", install: "false" }, docker])
    expect(await said(repo)).toEqual({
      code: 2,
      out: ["met: met", "docker: missing: start Docker Desktop"],
      error: [
        "REQUIREMENTS_MISSING: docker (start Docker Desktop); meet it (each entry of 'requires' in .tutti/settings.json says how), then run again",
      ],
    })
    expect(await said(project([{ name: "met", check: "true", install: "false" }]))).toEqual({
      code: 0,
      out: ["met: met"],
      error: [],
    })
    expect(await said(project([]))).toEqual({
      code: 0,
      out: ["No requirements: .tutti/settings.json has no 'requires' list."],
      error: [],
    })
  })

  test("--markdown prints the README's section, --readme writes it", async () => {
    const repo = project([jq], "# P\n")
    expect((await said(repo, { markdown: true })).out).toEqual([
      requiresMarkdown([jq]).replace(/\n$/u, ""),
    ])
    expect((await said(repo, { readme: true })).out).toEqual([
      `Wrote the requires list into README.md, between ${requiresStart} and ${requiresEnd}: commit it with the list.`,
    ])
    expect((await said(repo, { readme: true })).out).toEqual([
      "README.md's section is the requires list's already.",
    ])
    expect(await said(repo, { readme: true, markdown: true })).toEqual({
      code: 2,
      out: [],
      error: ["tutti requires: give one of --no-install, --markdown and --readme"],
    })
  })

  test("a list the settings refuse is a setup problem", async () => {
    const repo = project([{ name: "a", check: "x" } as Requirement])
    const { code, error } = await said(repo)
    expect(code).toBe(2)
    expect(error).toEqual([
      "tutti requires: .tutti/settings.json: requires[0]: needs an install (a command that meets it) or manual (what a person must do)",
    ])
  })
})

describe("a worker's note on the list", () => {
  test("names the list's entries, and the rule for a prompt without it", () => {
    const own = requiresNote(["jq", "docker"], "You work on TICKET_ID.", false)
    expect(own).toContain(
      `is its requires list, "requires" in .tutti/settings.json, which has jq, docker now.`,
    )
    expect(own).toContain(requiresRule)
    expect(own).not.toContain("tutti requires --readme")
    expect(requiresNote([], builtInWorkerPrompt, true)).toBe(
      `\n\nThe project's requires list is "requires" in .tutti/settings.json, which has no entries yet. A ticket that changes the list runs tutti requires --readme, which writes README.md's section on what to install from it, and commits that with the list.\n`,
    )
  })
})
