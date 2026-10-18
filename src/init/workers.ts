// tutti init's Workers step (§ 8.3): how many tickets run at once, the MCP servers workers get, and
// CHANGELOG.md merge=union, asked through init's form; then Beads, as orchestra init sets it up
// (bd installed where it is missing, with your consent; bd init where Beads isn't set up; the
// ticket prefix bd init gives, or every ticket renamed to it), and the login probe (§ 4.13), whose
// account, billing and permission mode the summary reports. It asks nothing about a terminal: tutti
// runs its workers itself.
//
// An untrusted main checkout, which the probe finds, is offered the fix Claude Code suggests: init
// sets `projects["<main checkout>"].hasTrustDialogAccepted` in the user's .claude.json, only once
// you say yes, re-reading the file just before and replacing it atomically, then probes again.
import { dirname, join } from "node:path"
import { Cause, Duration, Effect, Exit, FileSystem, Option } from "effect"
import {
  type AccountError,
  type AccountProbe,
  billingLine,
  permissionModeLine,
  UntrustedCheckout,
} from "../agent/Account.ts"
import { accountLine } from "../cli/login.ts"
import { unmergedLabel } from "../run/scope.ts"
import { memoryEstimate } from "../run/startup.ts"
import { Beads, beadsWhy } from "../services/Beads.ts"
import { TimeLimit } from "../services/exec.ts"
import { stateFile } from "../services/Store.ts"
import { branchOf } from "../services/Worktrees.ts"
import { joinAnd, type Machine, type Step, step } from "./steps.ts"

/** What the Workers step asks, each question null where a flag answered it or it isn't asked. */
export interface WorkersQuestions {
  /** Whether to install Beads, where bd is missing and init can: how it would. Offered as yes. */
  readonly installBeads: { readonly method: string; readonly command: string } | null
  /** How many tickets run at the same time by default: the project's number now. */
  readonly concurrent: { readonly initial: number; readonly max: number } | null
  /** The MCP servers workers get: those defined for the project here, and those chosen now. */
  readonly mcp: {
    readonly available: ReadonlyArray<string>
    readonly chosen: ReadonlyArray<string>
  } | null
  /** Whether to add CHANGELOG.md merge=union to .gitattributes. Offered as yes. */
  readonly changelogUnion: boolean
}

/** The Workers step's answers: one for each question asked. */
export interface WorkersAnswers {
  readonly installBeads?: boolean
  readonly concurrent?: number
  readonly mcp?: ReadonlyArray<string>
  readonly changelogUnion?: boolean
}

/** Whether the Workers step asks anything. */
export const asksAnything = (questions: WorkersQuestions): boolean =>
  questions.installBeads !== null ||
  questions.concurrent !== null ||
  questions.mcp !== null ||
  questions.changelogUnion

/**
 * What the concurrency question says under a number above 1: the memory that many workers take,
 * about 1 GiB each (§ 15.2). Null for 1.
 */
export const concurrencyNote = (concurrent: number): string | null =>
  concurrent > 1 ? memoryEstimate(concurrent) : null

/** The summary's step for the concurrency. */
export const concurrencyStep = (concurrent: number, asked: boolean): Step => {
  const note = concurrencyNote(concurrent)
  const tickets = concurrent === 1 ? "1 ticket at a time" : `${concurrent} tickets at the same time`
  return step(
    asked ? "done" : "kept",
    "concurrent",
    `${tickets}${note === null ? "" : `, ${note}`}`,
  )
}

/** The summary's step for the MCP servers workers get, and those not defined here. */
export const mcpSteps = (
  chosen: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): ReadonlyArray<Step> => {
  const undefinedNames = chosen.filter((name) => !available.includes(name))
  return [
    chosen.length === 0
      ? step(
          "kept",
          "MCP servers",
          available.length === 0
            ? "none: none is defined for this project here"
            : `none (defined here: ${available.join(", ")}; tutti init --mcp <name>,<name> gives them)`,
        )
      : step("done", "MCP servers", `workers get ${chosen.join(", ")}`),
    ...(undefinedNames.length === 0
      ? []
      : [
          step(
            "missing",
            "MCP servers",
            `${joinAnd(undefinedNames)} isn't defined for this project here: a run refuses to start until it is (claude mcp add)`,
          ),
        ]),
  ]
}

/** Reads `--mcp a,b`: the names, trimmed, each once; "" for none. */
export const parseMcpNames = (text: string): ReadonlyArray<string> => [
  ...new Set(
    text
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  ),
]

// --- Beads ---

/** How long installing bd may take: Homebrew can spend minutes updating itself. */
export const installLimit = Duration.minutes(15)

const beadsScript = "https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh"
const beadsDocs = "https://beads.gascity.com/getting-started/installation"

/** How init installs bd on this machine; `method` and `command` null where it can't. */
export interface BeadsInstall {
  /** Names the way, for the form and the summary: "Homebrew". */
  readonly method: string | null
  /** What it runs, as one would type it. */
  readonly command: string | null
  /** How to install bd by hand, where init can't. */
  readonly manual: string
}

/**
 * How init installs bd: with Homebrew where brew is on the PATH (macOS or Linux), the way Beads
 * recommends, else with the Beads install script (macOS, Linux, FreeBSD), which checks what it
 * downloads and falls back to go install. On Windows and other systems it installs nothing.
 */
export const findBeadsInstall = (machine: Machine): BeadsInstall => {
  const { platform } = machine
  if (machine.which("brew") !== null && (platform === "darwin" || platform === "linux")) {
    return { method: "Homebrew", command: "brew install beads", manual: "" }
  }
  if (platform === "darwin" || platform === "linux" || platform === "freebsd") {
    return {
      method: "the Beads install script",
      command: `curl -fsSL ${beadsScript} | bash`,
      manual: "",
    }
  }
  return platform === "win32"
    ? {
        method: null,
        command: null,
        manual:
          "in PowerShell: irm https://raw.githubusercontent.com/gastownhall/beads/main/install.ps1 | iex",
      }
    : { method: null, command: null, manual: `as ${beadsDocs} says` }
}

/** Where bd is: on the PATH, or where the install script and go install put it, off it. */
export interface BdLocation {
  readonly path: string | null
  readonly onPath: boolean
}

/**
 * Finds bd on the PATH or, failing that, where the Beads install script and go install put it:
 * ~/.local/bin, GOBIN or GOPATH's first bin, ~/go/bin, and /usr/local/bin.
 */
export const locateBd = (machine: Machine): BdLocation => {
  const onPath = machine.which("bd")
  if (onPath !== null) return { path: onPath, onPath: true }
  const home = machine.env("HOME") ?? ""
  const gobin = machine.env("GOBIN") ?? ""
  const gopath = (machine.env("GOPATH") ?? "").split(":")[0] ?? ""
  const dirs = [
    ...(home === "" ? [] : [join(home, ".local", "bin")]),
    ...(gobin === "" ? [] : [gobin]),
    ...(gopath !== "" ? [join(gopath, "bin")] : home === "" ? [] : [join(home, "go", "bin")]),
    "/usr/local/bin",
  ]
  const found = dirs.map((dir) => join(dir, "bd")).find((path) => machine.executable(path))
  return { path: found ?? null, onPath: false }
}

/** How to put bd, found off the PATH at `path`, on it. */
export const offPath = (path: string): string =>
  `it is in ${dirname(path)}, which isn't on your PATH: add it in your shell's profile (export PATH="$PATH":${dirname(path)}) and open a new terminal`

/** bd init without a question: a maintainer, not contributing to someone else's repo. */
export const bdInitArgs: ReadonlyArray<string> = [
  "init",
  "--non-interactive",
  "--role",
  "maintainer",
  "--init-if-missing",
]

/** Whether init installs bd: yes, no, or not asked (no terminal, no flag). */
export type Consent = boolean | "unasked"

/** Paths shortened to what the repository's top holds, sorted: .beads/ for .beads/config.yaml. */
const topLevel = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(paths.map((path) => (path.includes("/") ? `${path.split("/")[0]}/` : path)))].sort()

const lines = (text: string): ReadonlyArray<string> =>
  text.split("\n").filter((line) => line.trim() !== "")

/** The repository's HEAD ("" before its first commit) and the status of each changed path. */
const readWorktree = (machine: Machine, repo: string) =>
  Effect.gen(function* () {
    const head = yield* machine
      .run("git", ["rev-parse", "--verify", "-q", "HEAD"], repo, TimeLimit.read)
      .pipe(Effect.orElseSucceed(() => ""))
    const status = yield* machine
      .run("git", ["status", "--porcelain", "--untracked-files=all"], repo, TimeLimit.read)
      .pipe(Effect.orElseSucceed(() => ""))
    return {
      head: head.trim(),
      status: new Map(lines(status).map((line) => [line.slice(3), line.slice(0, 2)])),
    }
  })

/** Installs bd as `consent` says, and gives the step and whether bd is on the PATH now. */
const installBd = (machine: Machine, repo: string, install: BeadsInstall, consent: Consent) =>
  Effect.gen(function* () {
    const missing = (detail: string) => ({ step: step("missing", "bd", detail), onPath: false })
    if (install.command === null || install.method === null) {
      return missing(`not installed, and tutti can't install it here; install it ${install.manual}`)
    }
    if (consent === "unasked") {
      return missing(
        `not installed; not asked (no terminal): --install-beads installs it with ${install.method} (${install.command})`,
      )
    }
    if (!consent) return missing(`not installed (declined); install it with ${install.command}`)
    const [command, args] =
      install.method === "Homebrew"
        ? (["brew", ["install", "beads"]] as const)
        : (["bash", ["-c", `set -o pipefail; ${install.command}`]] as const)
    const failed = yield* machine.run(command, args, repo, installLimit).pipe(
      Effect.as(null),
      Effect.catch((why) => Effect.succeed(why)),
    )
    const now = locateBd(machine)
    if (now.onPath) {
      return {
        step: step("done", "bd", `installed with ${install.method} (${install.command})`),
        onPath: true,
      }
    }
    if (now.path !== null) {
      return missing(`installed with ${install.method}, but ${offPath(now.path)}`)
    }
    return missing(
      failed === null
        ? `${install.command} ran, but bd isn't on the PATH; install it by hand: see ${beadsDocs}`
        : `${failed}; install it by hand: see ${beadsDocs}`,
    )
  })

/** Runs bd init with `args` in `repo`: the step, listing what bd committed and what it added. */
const runBdInit = (machine: Machine, repo: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const before = yield* readWorktree(machine, repo)
    const ran = yield* Effect.result(machine.run("bd", args, repo, TimeLimit.write))
    if (ran._tag === "Failure") return step("missing", "Beads", ran.failure)
    const after = yield* readWorktree(machine, repo)
    const committed =
      after.head === before.head || after.head === ""
        ? []
        : lines(
            yield* machine
              .run(
                "git",
                before.head === ""
                  ? ["ls-tree", "-r", "--name-only", after.head]
                  : ["diff", "--name-only", before.head, after.head],
                repo,
                TimeLimit.read,
              )
              .pipe(Effect.orElseSucceed(() => "")),
          )
    const added = [...after.status]
      .filter(([path, status]) => before.status.get(path) !== status)
      .map(([path]) => path)
    const shownCommitted = topLevel(committed)
    const shownAdded = topLevel(added)
    return step(
      "done",
      "Beads",
      [
        "ran bd init (maintainer, not contributing to someone else's repo; auto-export off)",
        ...(shownCommitted.length === 0 ? [] : [`bd committed ${joinAnd(shownCommitted)}`]),
        ...(shownAdded.length === 0
          ? []
          : [`it added ${joinAnd(shownAdded)}, to commit with .tutti/`]),
      ].join("; "),
      shownAdded,
    )
  })

/**
 * Sets Beads up in `repo`: installs bd where it is missing and `consent` allows, then runs bd init
 * where `.beads/` isn't there, giving it `prefix` when that is new. bd init commits what is staged
 * with its own files, so it doesn't run while anything is. A failure is a step saying why: init
 * goes on, and its prerequisites say what's missing.
 */
export const setUpBeads = (
  machine: Machine,
  repo: string,
  options: {
    readonly install: BeadsInstall
    readonly consent: Consent
    readonly prefix: PrefixPlan | null
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const steps: Array<Step> = []
    const located = locateBd(machine)
    // Installed off the PATH: the prerequisites say how to add it.
    if (located.path !== null && !located.onPath) return steps
    let onPath = located.onPath
    if (!onPath) {
      const installed = yield* installBd(machine, repo, options.install, options.consent)
      steps.push(installed.step)
      onPath = installed.onPath
    }
    if (
      !onPath ||
      (yield* fs.exists(join(repo, ".beads")).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return steps
    }
    const staged = yield* Effect.result(
      machine.run("git", ["diff", "--cached", "--name-only"], repo, TimeLimit.read),
    )
    if (staged._tag === "Failure") {
      steps.push(
        step(
          "missing",
          "Beads",
          `bd init didn't run: ${staged.failure}, so tutti can't tell what bd init would commit`,
        ),
      )
      return steps
    }
    if (lines(staged.success).length > 0) {
      steps.push(
        step(
          "missing",
          "Beads",
          `bd init didn't run: it would commit what you have staged (${joinAnd(topLevel(lines(staged.success)))}) with its own files; commit it, or unstage it with git reset, then run tutti init again`,
        ),
      )
      return steps
    }
    const prefix = options.prefix?.was === null ? options.prefix.prefix : null
    const initialised = yield* runBdInit(machine, repo, [
      ...bdInitArgs,
      ...(prefix === null ? [] : ["--prefix", prefix]),
    ])
    steps.push(initialised)
    if (initialised.kind === "done" && prefix !== null) {
      steps.push(step("done", prefixLabel, `${prefix}, for the new Beads`))
    }
    return steps
  })

// --- The ticket prefix ---

/** The label of the ticket prefix's step. */
export const prefixLabel = "ticket prefix"

/** The prefix as typed, without the trailing hyphen bd rename-prefix wants. */
export const normalPrefix = (prefix: string): string => prefix.trim().replace(/-$/, "")

/**
 * Why `prefix` (a normalPrefix) can't be a ticket prefix, as bd requires one, or null: lowercase
 * letters, digits and hyphens, starting with a letter, not ending in a hyphen.
 */
export const prefixProblem = (prefix: string): string | null => {
  if (prefix === "") return "is empty"
  if (!/^[a-z]/.test(prefix)) return `must start with a lowercase letter (got '${prefix}')`
  if (prefix.endsWith("-")) return `must not end in a hyphen (got '${prefix}')`
  if (!/^[a-z0-9-]+$/.test(prefix)) {
    return `must hold only lowercase letters, digits and hyphens (got '${prefix}')`
  }
  return null
}

/** Ticket `id` with its prefix `from` replaced by `to`, as bd rename-prefix renames it. */
export const renamedId = (id: string, from: string, to: string): string =>
  id.startsWith(`${from}-`) ? `${to}-${id.slice(from.length + 1)}` : id

/** The prefix --prefix gives, and what it changes. */
export interface PrefixPlan {
  readonly prefix: string
  /** The prefix Beads has; null where Beads isn't set up yet, and bd init takes `prefix`. */
  readonly was: string | null
  /** How many tickets the rename renames. */
  readonly tickets: number
}

/** The payload of bd's JSON output, out of its envelope ({schema_version, data}) when it has one. */
const bdPayload = (text: string): unknown => {
  const json: unknown = JSON.parse(text)
  return typeof json === "object" && json !== null && "schema_version" in json && "data" in json
    ? json.data
    : json
}

/** The ticket prefix of the Beads set up in `repo`. */
const beadsPrefix = (machine: Machine, repo: string) =>
  Effect.flatMap(
    machine.run("bd", ["config", "get", "issue_prefix", "--json"], repo, TimeLimit.read),
    (out) =>
      Effect.try({
        try: () => {
          const data = bdPayload(out)
          const value =
            typeof data === "object" && data !== null && "value" in data ? data.value : undefined
          return typeof value === "string" ? value.trim() : ""
        },
        catch: () => `bd config get issue_prefix said what tutti can't read: ${out.trim()}`,
      }),
  )

/**
 * Why the tickets can't be renamed from `was` now, or null: bd renames nothing outside Beads, so a
 * ticket not closed with a branch (tutti/<id>, or orchestra's wt/<id>), workers the last run left
 * in .tutti/run/state.json, and tickets labelled unmerged would name IDs that no longer exist.
 */
export const prefixRefusal = (machine: Machine, repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const beads = yield* Beads
    const reasons: Array<string> = []
    const refs = yield* machine
      .run(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/tutti/", "refs/heads/wt/"],
        repo,
        TimeLimit.read,
      )
      .pipe(Effect.orElseSucceed(() => ""))
    const branched = new Set(lines(refs).map((ref) => ref.replace(/^(tutti|wt)\//, "")))
    if (branched.size > 0) {
      const open = yield* Effect.result(beads.list())
      if (open._tag === "Failure") return `bd can't list the tickets: ${beadsWhy(open.failure)}`
      const withBranch = open.success.filter((issue) => branched.has(issue.id))
      if (withBranch.length > 0) {
        reasons.push(
          `${joinAnd(withBranch.map((issue) => branchOf(issue.id)))} ${withBranch.length === 1 ? "has" : "have"} a branch`,
        )
      }
    }
    const state = yield* fs
      .readFileString(join(repo, stateFile))
      .pipe(Effect.orElseSucceed(() => ""))
    const carried = (() => {
      try {
        const json: unknown = JSON.parse(state)
        const tickets =
          typeof json === "object" && json !== null && "tickets" in json ? json.tickets : null
        return typeof tickets === "object" && tickets !== null && Object.keys(tickets).length > 0
      } catch {
        return false
      }
    })()
    if (carried) {
      reasons.push(`the last run left workers in ${stateFile}, which the next run carries on with`)
    }
    const unmerged = yield* Effect.result(beads.list({ status: "closed", labels: [unmergedLabel] }))
    if (unmerged._tag === "Failure")
      return `bd can't list the tickets: ${beadsWhy(unmerged.failure)}`
    if (unmerged.success.length > 0) {
      reasons.push(
        `${joinAnd(unmerged.success.map((issue) => issue.id))} ${unmerged.success.length === 1 ? "is" : "are"} labelled ${unmergedLabel}`,
      )
    }
    return reasons.length === 0 ? null : joinAnd(reasons)
  })

/**
 * What --prefix `given` changes in `repo`: the prefix bd init takes for a new Beads, or the rename
 * of an existing one's tickets. Fails saying why it can't: not a prefix bd takes, a prefix Beads
 * has that can't be read, or tickets that can't be renamed now.
 */
export const planPrefix = (machine: Machine, repo: string, given: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const prefix = normalPrefix(given)
    const problem = prefixProblem(prefix)
    if (problem !== null) return yield* Effect.fail(`--prefix ${problem}`)
    const setUp = yield* fs.exists(join(repo, ".beads")).pipe(Effect.orElseSucceed(() => false))
    if (!setUp) return { prefix, was: null, tickets: 0 } satisfies PrefixPlan
    const was = yield* beadsPrefix(machine, repo).pipe(
      Effect.mapError((why) => `--prefix: can't read the ticket prefix Beads has: ${why}`),
    )
    if (was === prefix) return { prefix, was, tickets: 0 } satisfies PrefixPlan
    const refusal = yield* prefixRefusal(machine, repo)
    if (refusal !== null) {
      return yield* Effect.fail(
        `--prefix: the tickets can't be renamed from ${was} to ${prefix} while ${refusal}. Nothing was changed.`,
      )
    }
    const beads = yield* Beads
    const all = yield* beads
      .list({ all: true })
      .pipe(Effect.mapError((error) => `--prefix: bd can't list the tickets: ${beadsWhy(error)}`))
    return { prefix, was, tickets: all.length } satisfies PrefixPlan
  })

/**
 * Renames every ticket of the Beads in `repo` to the plan's prefix with bd rename-prefix, checking
 * again that they can be renamed: the step. None for a new Beads, whose prefix bd init gave.
 */
export const applyPrefix = (machine: Machine, repo: string, plan: PrefixPlan) =>
  Effect.gen(function* () {
    const { prefix, was } = plan
    if (was === null) return []
    if (was === prefix) return [step("kept", prefixLabel, `${prefix}, kept`)]
    const refusal = yield* prefixRefusal(machine, repo)
    if (refusal !== null) {
      return [
        step(
          "missing",
          prefixLabel,
          `${was}, kept: the tickets can't be renamed to ${prefix} while ${refusal}`,
        ),
      ]
    }
    const renamed = yield* Effect.result(
      machine.run("bd", ["rename-prefix", `${prefix}-`], repo, TimeLimit.write),
    )
    if (renamed._tag === "Failure") {
      return [step("missing", prefixLabel, `${was}, kept: ${renamed.failure}`)]
    }
    const count = plan.tickets === 1 ? "1 ticket renamed" : `${plan.tickets} tickets renamed`
    return [step("done", prefixLabel, `${prefix} (was ${was}), ${count}`)]
  })

// --- CHANGELOG.md merge=union ---

export const changelogFile = "CHANGELOG.md"
export const attributesFile = ".gitattributes"
export const unionLine = `${changelogFile} merge=union`

/** Whether git merges the repository's CHANGELOG.md by union, however .gitattributes says so. */
const mergesByUnion = (machine: Machine, repo: string) =>
  machine.run("git", ["check-attr", "merge", "--", changelogFile], repo, TimeLimit.read).pipe(
    Effect.map((out) => out.trim().endsWith(": merge: union")),
    Effect.orElseSucceed(() => false),
  )

/**
 * Whether init offers CHANGELOG.md merge=union: the project keeps a CHANGELOG.md, and
 * .gitattributes doesn't merge it by union yet.
 */
export const offersUnion = (machine: Machine, repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const kept = yield* fs.exists(join(repo, changelogFile)).pipe(Effect.orElseSucceed(() => false))
    return kept && !(yield* mergesByUnion(machine, repo))
  })

/** Adds CHANGELOG.md merge=union to .gitattributes as `union` says: the steps, none without one. */
export const applyUnion = (machine: Machine, repo: string, union: Consent) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(join(repo, changelogFile)).pipe(Effect.orElseSucceed(() => false)))) {
      return []
    }
    const label = "changelog"
    const why = "two tickets adding entries at the same spot"
    if (yield* mergesByUnion(machine, repo)) {
      return [step("kept", label, `${changelogFile} merges by union: ${why} keep both`)]
    }
    if (union === "unasked") {
      return [
        step(
          "caution",
          label,
          `not asked (no terminal): with ${why}, the second one's rebase conflicts; --changelog-union adds ${unionLine} to ${attributesFile} so git keeps both sides' lines`,
        ),
      ]
    }
    if (!union)
      return [step("kept", label, `${attributesFile} left as it is: ${why} will conflict`)]
    const path = join(repo, attributesFile)
    const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
    yield* fs.writeFileString(
      path,
      `${text === "" || text.endsWith("\n") ? text : `${text}\n`}${unionLine}\n`,
    )
    return [
      step(
        "done",
        label,
        `added ${unionLine} to ${attributesFile}: with ${why}, git keeps both sides' lines instead of stopping on a conflict`,
        [attributesFile],
      ),
    ]
  })

// --- The login probe ---

/** The failures of a probe that failed: each error in its cause. */
const probeFailures = (cause: Cause.Cause<AccountError>): ReadonlyArray<AccountError> =>
  cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))

/** The untrusted checkout a failed probe found, if it found one. */
export const untrustedIn = (
  probed: Exit.Exit<AccountProbe, AccountError>,
): Option.Option<UntrustedCheckout> =>
  Exit.isSuccess(probed)
    ? Option.none()
    : Option.fromNullishOr(
        probeFailures(probed.cause).find(
          (error): error is UntrustedCheckout => error instanceof UntrustedCheckout,
        ),
      )

/** A line `label: detail` as a step. */
const lineStep = (kind: Step["kind"], line: string): Step => {
  const at = line.indexOf(": ")
  return at < 0 ? step(kind, line, "") : step(kind, line.slice(0, at), line.slice(at + 2))
}

/**
 * The probe's steps: the account, its billing and the permission mode in effect, or each problem
 * it found, the untrusted checkout left out when `untrusted` is false (init offered its fix).
 */
export const probeSteps = (
  probed: Exit.Exit<AccountProbe, AccountError>,
  untrusted = true,
): ReadonlyArray<Step> => {
  if (Exit.isSuccess(probed)) {
    const probe = probed.value
    return [
      lineStep("done", accountLine(probe.account)),
      lineStep("done", billingLine(probe.billing)),
      lineStep(
        probe.permissionMode.inEffect === probe.permissionMode.requested ? "done" : "caution",
        permissionModeLine(probe.permissionMode),
      ),
    ]
  }
  const failures = probeFailures(probed.cause)
  if (failures.length === 0) {
    return [step("missing", "login", `the probe failed: ${Cause.pretty(probed.cause)}`)]
  }
  return failures
    .filter((error) => untrusted || !(error instanceof UntrustedCheckout))
    .flatMap((error) =>
      error.message
        .split("\n")
        .map((message) =>
          step(
            "missing",
            error._tag === "UntrustedCheckout"
              ? "trust"
              : error._tag === "SettingsUnreadable"
                ? "settings"
                : "login",
            message,
          ),
        ),
    )
}

/** The key init sets in the user's .claude.json to mark `checkout` trusted, as the offer names it. */
export const trustKey = (checkout: string): string =>
  `projects[${JSON.stringify(checkout)}].hasTrustDialogAccepted: true`

/** What init says when it offers to mark the main checkout trusted. */
export const trustExplanation = (checkout: string): string =>
  `Claude Code ignores this project's permission allow rules in ${checkout}: it hasn't been trusted there. Workers would ask, or leave to auto mode, what the project allows.`

/** The other fix, when marking it trusted is declined. */
export const trustDeclined = (checkout: string): string =>
  `not trusted: run claude once in ${checkout} and accept the trust dialog`

/**
 * Sets `projects[checkout].hasTrustDialogAccepted` to true in Claude Code's user config `file`,
 * re-reading it just before, changing that one key and leaving everything else, and replacing it
 * atomically: a temporary file in the same folder, with the same mode, renamed over it.
 */
export const markTrusted = (file: string, checkout: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(`${file} can't be read: ${error.message}`),
      ),
    )
    const json: unknown = Option.isNone(text)
      ? {}
      : yield* Effect.try({
          try: (): unknown => JSON.parse(text.value),
          catch: () => `${file} isn't valid JSON; it was left as it is`,
        })
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return yield* Effect.fail(`${file} isn't a JSON object; it was left as it is`)
    }
    const config = json as Record<string, unknown>
    const projects =
      typeof config.projects === "object" &&
      config.projects !== null &&
      !Array.isArray(config.projects)
        ? (config.projects as Record<string, unknown>)
        : {}
    const entry = projects[checkout]
    const project =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {}
    const changed = {
      ...config,
      projects: { ...projects, [checkout]: { ...project, hasTrustDialogAccepted: true } },
    }
    const mode = yield* fs.stat(file).pipe(
      Effect.map((info) => info.mode & 0o777),
      Effect.orElseSucceed(() => 0o600),
    )
    const temporary = join(dirname(file), `.claude.json.tutti-${process.pid}.tmp`)
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporary, `${JSON.stringify(changed, null, 2)}\n`, { mode })
      yield* fs.chmod(temporary, mode)
      yield* fs.rename(temporary, file)
    }).pipe(
      Effect.mapError((error) => `${file} couldn't be written: ${error.message}`),
      Effect.tapError(() => Effect.ignore(fs.remove(temporary))),
    )
  })
