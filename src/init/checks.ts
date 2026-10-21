// tutti init's Checks step (§ 8.3), as orchestra init's stage 2: the scout (§ 6.3) looks for the
// suites the project has, which the form runs under a spinner and Esc skips; then one of three
// choices, the one that fits what it found selected:
//
//   use them as they are   the suites found, in two checklists: check-fast's and check-full's
//   create from scratch    runners that check nothing yet, and a ticket to set the tests up with
//                          the create-check-suite skill
//   manual                 one command, the one check-fast.sh runs
//
// It also asks the setup command (offered for the lockfiles at the repository's top), the ticket
// prefix and the verifier, a Claude Code subagent that checks each ticket's change in a fresh
// context. Once the form is answered init writes the runners, and this part the rest: the skill
// where test work needs it, the verifier and the worker prompt's section that runs it, and the
// test-work tickets, labelled tutti-tests as orchestra labels its own orchestra-tests.
import { join } from "node:path"
import { Duration, Effect, FileSystem, Option } from "effect"
import type { OrganError, Organs } from "../organs/Organs.ts"
import { type Scouting, type Suite as ScoutSuite, scoutChecks } from "../organs/scout.ts"
import skillTemplate from "../project/templates/create-check-suite.md" with { type: "text" }
import verifierTemplate from "../project/templates/verifier.md" with { type: "text" }
import { soloLabel } from "../run/holds.ts"
import { Beads, beadsWhy } from "../services/Beads.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import {
  checkScript,
  fastRunner,
  fastScript,
  fullRunner,
  fullScript,
  runnerCommands,
  runsCheckScript,
  runsRunner,
  type Suite,
  withoutRunners,
} from "./runners.ts"
import { type Step, step } from "./steps.ts"
import type { Consent } from "./workers.ts"

// --- The questions ---

/** The Checks step's three choices. */
export type ChecksKind = "found" | "scratch" | "manual"

/** Each choice as the form offers it, in order. */
export const checksOptions: ReadonlyArray<{ readonly kind: ChecksKind; readonly label: string }> = [
  { kind: "found", label: "Use them as they are" },
  { kind: "scratch", label: "Create from scratch with the create-check-suite skill" },
  { kind: "manual", label: "Manual" },
]

/** Whether a copy of the create-check-suite skill is in the project, and how it compares. */
export type SkillState = "missing" | "same" | "differs"

/** The ticket prefix, as the Checks step asks it. */
export interface PrefixQuestion {
  /** The prefix Beads has, or bd init would give a new one: the folder's name. */
  readonly current: string
  /** Beads isn't set up yet: bd init takes the prefix. */
  readonly isNew: boolean
  /** How many tickets a new prefix renames. */
  readonly tickets: number
  /** A ticket's ID, to show renamed; null with none. */
  readonly example: string | null
  /** Why the tickets can't be renamed now; null when they can. */
  readonly refusal: string | null
}

/** What the Checks step asks, each question null (or false) where a flag answered it or it isn't asked. */
export interface ChecksQuestions {
  /** The choice of checks, after the scout; null where --check-fast or --check-full gives them. */
  readonly checks: {
    /** The scout's search, which the form runs, Esc interrupting it: what it found, or why not. */
    readonly scout: Effect.Effect<Scouting, string>
    /** The project has scripts/check.sh, whose suite the checklists start with. */
    readonly checkScript: boolean
    /** Manual's command as it is now, which the form prefills. */
    readonly command: string
    /** Manual's command left empty keeps the runner there, rather than writing one checking nothing. */
    readonly keepsRunner: boolean
    /** The runners there, their scripts; null where one is missing. */
    readonly runners: { readonly fast: string | null; readonly full: string | null }
    readonly skill: SkillState
  } | null
  /** The setup command, offered for the lockfiles found, where the settings have none. */
  readonly setup: { readonly offer: string; readonly lockfiles: ReadonlyArray<string> } | null
  readonly prefix: PrefixQuestion | null
  /** Whether to write the verifier. Offered as yes. */
  readonly verifier: boolean
}

/** The choice of checks made. */
export type ChecksChoice =
  | {
      readonly kind: "found"
      /** check-fast.sh's suites, and check-full.sh's own, after check-fast.sh. */
      readonly fast: ReadonlyArray<Suite>
      readonly full: ReadonlyArray<Suite>
      /** Also file tickets for the untested areas. */
      readonly fileUntested: boolean
    }
  | { readonly kind: "scratch" }
  | { readonly kind: "manual"; readonly command: string }

/** The Checks step's answers: one for each question asked. */
export interface ChecksAnswers {
  readonly checks?: ChecksChoice
  /** What the scout found the project built with, which the verifier is told. */
  readonly stack?: ReadonlyArray<string>
  /** Replace a runner, or the skill's copy, there that differs from what the choice writes. */
  readonly replaceFast?: boolean
  readonly replaceFull?: boolean
  readonly replaceSkill?: boolean
  /** The setup command; "" for none. */
  readonly setup?: string
  /** The ticket prefix: a new one, its rename confirmed. */
  readonly prefix?: string
  readonly verifier?: boolean
}

/** Whether the Checks step asks anything. */
export const asksChecks = (questions: ChecksQuestions): boolean =>
  questions.checks !== null ||
  questions.setup !== null ||
  questions.prefix !== null ||
  questions.verifier

// --- The scout's outcome ---

/** Why the scout found nothing, as the choice's description says it. */
export const scoutWhy = (error: OrganError): string => {
  switch (error._tag) {
    case "OrganFailed":
      return `the scout failed: ${error.reason}`
    case "OrganRefused":
      return `the scout declined: ${error.reason}`
    case "OrganTimedOut":
      return `the scout ran past its ${Duration.format(error.timeLimit)}`
    case "OrganSkipped":
      return "the scout was skipped while the usage limit holds"
  }
}

/** The scout's search in the repository at `repo`: what it found, or why it found nothing. */
export const scoutSearch = (repo: string): Effect.Effect<Scouting, string, Organs> =>
  Effect.mapError(scoutChecks(repo), scoutWhy)

/** Why there are no suites when Esc skipped the scout. */
export const scoutSkipped = "the search was skipped with Esc"

/** The scout's search, as it ended: what it found, or why it found nothing. */
export type ScoutResult = { readonly found: Scouting } | { readonly failed: string }

/** What the scout found, as the form shows it. */
export interface Scouted {
  /** The choice the form starts on, and why. */
  readonly picked: ChecksKind
  readonly why: string
  /** The suites the checklists offer. */
  readonly suites: ReadonlyArray<ScoutSuite>
  /** The suites ticked at first: in check-fast's checklist, those the scout calls fast. */
  readonly fast: ReadonlyArray<number>
  /** check-full's checklist: the other suites, which are all it offers, all ticked. */
  readonly full: ReadonlyArray<number>
  /** What the project is built with. */
  readonly stack: ReadonlyArray<string>
}

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The scout's suites as the checklists offer them: without those that run a runner, which would
 * run itself, and, where the project has scripts/check.sh, with the suite running it first, as a
 * fast suite. A scout that left it out has it added, taking turns: nobody said it can run twice.
 */
export const offeredSuites = (
  suites: ReadonlyArray<ScoutSuite>,
  hasCheckScript: boolean,
): ReadonlyArray<ScoutSuite> => {
  const offered = suites.filter((suite) => !runsRunner(suite.command))
  if (!hasCheckScript) return offered
  const at = offered.findIndex((suite) => runsCheckScript(suite.command))
  const check: ScoutSuite =
    at < 0
      ? {
          name: "check",
          kind: "other",
          command: checkScript,
          targeted: "",
          found_in: `${checkScript}:1`,
          tier: "fast",
          parallel_safe: false,
          needs: [],
        }
      : { ...(offered[at] as ScoutSuite), tier: "fast" }
  return [check, ...offered.filter((_, index) => index !== at)]
}

/**
 * The scout's outcome settled: the choice that fits it (the suites found, from scratch where it
 * found none, manual where it failed or was skipped), with why, the checklists and the stack.
 */
export const settleScout = (result: ScoutResult, hasCheckScript: boolean): Scouted => {
  if ("failed" in result) {
    return {
      picked: "manual",
      why: `${capitalize(sanitizeLine(result.failed))}.`,
      suites: [],
      fast: [],
      full: [],
      stack: [],
    }
  }
  const { found } = result
  const suites = offeredSuites(found.suites, hasCheckScript)
  // The scout's words, from files the repository holds.
  const note = found.note === "" ? "" : ` ${sanitizeLine(found.note)}`
  const stack = found.stack.map(sanitizeLine)
  if (suites.length === 0) {
    return {
      picked: "scratch",
      why: `The scout found no suites.${note}`,
      suites,
      fast: [],
      full: [],
      stack,
    }
  }
  const indexes = suites.map((_, index) => index)
  return {
    picked: "found",
    why: `The scout found ${plural(suites.length, "suite", "suites")}.${note}`,
    suites,
    fast: indexes.filter((index) => suites[index]?.tier === "fast"),
    full: indexes.filter((index) => suites[index]?.tier !== "fast"),
    stack,
  }
}

/** A suite as a checklist shows it: its command, its name, where it was found and what it needs. */
export const suiteLabel = (suite: ScoutSuite): string => {
  const about = [
    ...[suite.name, suite.found_in].filter((part) => part !== ""),
    ...(suite.needs.length === 0 ? [] : [`needs ${suite.needs.join(", ")}`]),
    // In a runner, between lock and unlock.
    ...(suite.parallel_safe ? [] : ["takes turns"]),
  ]
  return sanitizeLine(`${suite.command}  · ${about.join(" · ")}`)
}

/** A suite the scout found as a runner's line. */
export const runnerSuite = (suite: ScoutSuite): Suite => ({
  name: suite.name,
  command: suite.command,
  targeted: suite.targeted,
  foundIn: suite.found_in,
  serial: !suite.parallel_safe,
})

/**
 * The choice "use them as they are" with the suites ticked in each checklist: a suite ticked in
 * both runs in check-fast.sh only, which check-full.sh runs first.
 */
export const chooseFound = (
  scouted: Scouted,
  fast: ReadonlyArray<number>,
  full: ReadonlyArray<number>,
  fileUntested: boolean,
): ChecksChoice => {
  const pick = (indexes: ReadonlyArray<number>) =>
    indexes.flatMap((index) => {
      const suite = scouted.suites[index]
      return suite === undefined ? [] : [runnerSuite(suite)]
    })
  return {
    kind: "found",
    fast: pick(fast),
    full: pick(full.filter((index) => !fast.includes(index))),
    fileUntested,
  }
}

/** The runners a choice writes, or null for manual, whose command init writes over the one there. */
export const choiceScripts = (
  choice: ChecksChoice,
): { readonly fast: string; readonly full: string } | null => {
  if (choice.kind === "manual") return null
  const fast = choice.kind === "found" ? choice.fast : []
  const full = choice.kind === "found" ? choice.full : []
  return {
    fast: fastScript(fast),
    full: fullScript(full, withoutRunners(fast).kept.length === 0),
  }
}

/**
 * Whether each runner there differs from what `choice` writes, for the form to ask whether to keep
 * it (the default) or replace it.
 */
export const runnersDiffer = (
  runners: { readonly fast: string | null; readonly full: string | null },
  choice: ChecksChoice,
): { readonly fast: boolean; readonly full: boolean } => {
  const scripts = choiceScripts(choice)
  if (scripts === null) return { fast: false, full: false }
  return {
    fast: runners.fast !== null && runners.fast !== scripts.fast,
    full: runners.full !== null && runners.full !== scripts.full,
  }
}

/** What a runner's script runs, for the question whether to keep it. */
export const runsDescription = (script: string): string => {
  const commands = runnerCommands(script)
  return commands.length === 0 ? "It runs nothing." : `It runs:\n  ${commands.join("\n  ")}`
}

/** Whether a choice files test work, which needs the create-check-suite skill. */
export const filesTestWork = (choice: ChecksChoice | undefined): boolean =>
  choice?.kind === "scratch" || (choice?.kind === "found" && choice.fileUntested)

/** What the verifier question says, naming the stack the scout found. */
export const verifierDescription = (stack: ReadonlyArray<string>): string =>
  `A subagent that checks each ticket's change against the ticket in a fresh context, before the worker closes it${stack.length === 0 ? "" : `, knowing the project is built with ${stack.join(", ")}`}. Each ticket then costs a subagent's run too.`

// --- The setup command ---

/**
 * The lockfiles init offers a setup command for, each with the command installing what it pins,
 * orchestra's: a repository with two of one ecosystem's gets the first's command.
 */
export const setupLockfiles: ReadonlyArray<{
  readonly ecosystem: string
  readonly lockfile: string
  readonly command: string
}> = [
  { ecosystem: "js", lockfile: "package-lock.json", command: "npm ci" },
  { ecosystem: "js", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { ecosystem: "js", lockfile: "yarn.lock", command: "yarn install --frozen-lockfile" },
  { ecosystem: "js", lockfile: "bun.lock", command: "bun install --frozen-lockfile" },
  { ecosystem: "python", lockfile: "uv.lock", command: "uv sync" },
  { ecosystem: "python", lockfile: "poetry.lock", command: "poetry install" },
  { ecosystem: "ruby", lockfile: "Gemfile.lock", command: "bundle install" },
]

/**
 * The setup command init offers for the lockfiles at the repository's top, one per ecosystem
 * joined with &&, and the lockfiles it is for: "" and none without a lockfile.
 */
export const findSetup = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const commands: Array<string> = []
    const lockfiles: Array<string> = []
    const done = new Set<string>()
    for (const each of setupLockfiles) {
      if (done.has(each.ecosystem)) continue
      if (!(yield* fs.exists(join(repo, each.lockfile)).pipe(Effect.orElseSucceed(() => false)))) {
        continue
      }
      done.add(each.ecosystem)
      commands.push(each.command)
      lockfiles.push(each.lockfile)
    }
    return { offer: commands.join(" && "), lockfiles }
  })

/**
 * The summary's step for the setup command: what the settings hold now (`command`), held before
 * (`was`), and what init found to offer; none with nothing to say.
 */
export const setupSteps = (setup: {
  readonly command: string | null
  readonly was: string | null
  readonly offer: string
  readonly lockfiles: ReadonlyArray<string>
  readonly unasked: boolean
}): ReadonlyArray<Step> => {
  const label = "setup"
  const when = "runs before check-fast on a ticket whose rebase changes a dependency file"
  const found = `found ${setup.lockfiles.join(", ")}`
  if (setup.command !== null && setup.command === setup.was) {
    return [step("kept", label, `'${setup.command}' ${when} (--setup replaces it)`)]
  }
  if (setup.command !== null) return [step("done", label, `'${setup.command}' ${when}`)]
  if (setup.was !== null) {
    return [step("done", label, `removed '${setup.was}': no setup command runs`)]
  }
  if (setup.offer === "") return []
  if (setup.unasked) {
    return [
      step(
        "caution",
        label,
        `not asked (no terminal): ${found}, and a ticket rebased over a dependency change is checked against the dependencies installed before it; --setup '${setup.offer}' sets the command that installs them`,
      ),
    ]
  }
  return [
    step(
      "kept",
      label,
      `${found}; no setup command: a ticket rebased over a dependency change is checked against the dependencies installed before it (--setup sets one)`,
    ),
  ]
}

// --- The create-check-suite skill ---

/** The skill's folder, from the project's top: Claude Code's project skills. */
export const skillDir = join(".claude", "skills", "create-check-suite")

/** The skill's one file. */
export const skillPath = join(skillDir, "SKILL.md")

/** The skill as tutti carries it. */
export const skillText: string = skillTemplate

/** Whether the project has a copy of the skill, and whether it differs from tutti's. */
export const skillState = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const there = yield* fs.readFileString(join(repo, skillPath)).pipe(Effect.option)
    if (Option.isSome(there)) return there.value === skillText ? "same" : "differs"
    return (yield* fs.exists(join(repo, skillDir)).pipe(Effect.orElseSucceed(() => false)))
      ? "differs"
      : "missing"
  }) satisfies Effect.Effect<SkillState, never, FileSystem.FileSystem>

/**
 * Writes the skill where `choice` files test work: a copy that is the same is kept, and one that
 * differs too, unless `replace`. Its step; none where no test work is filed.
 */
export const applySkill = (repo: string, choice: ChecksChoice | undefined, replace: boolean) =>
  Effect.gen(function* () {
    if (!filesTestWork(choice)) return []
    const fs = yield* FileSystem.FileSystem
    const label = "skill"
    const state = yield* skillState(repo)
    if (state === "same") return [step("kept", label, `${skillDir}/ is there; left as it is`)]
    if (state === "differs" && !replace) {
      return [
        step(
          "caution",
          label,
          `${skillDir}/ differs from tutti's; kept (remove it and run tutti init again for tutti's)`,
        ),
      ]
    }
    yield* fs.makeDirectory(join(repo, skillDir), { recursive: true })
    yield* fs.writeFileString(join(repo, skillPath), skillText)
    return [
      step(
        "done",
        label,
        `${state === "missing" ? "wrote" : "replaced"} ${skillDir}/, for the tickets that set up the project's tests`,
        [`${skillDir}/`],
      ),
    ]
  })

// --- The verifier ---

/** The verifier subagent, from the project's top: committed, as a worktree has only that. */
export const verifierPath = join(".claude", "agents", "verifier.md")

/** The worker prompt's section that has workers run the verifier: TICKET_ID filled in per ticket. */
export const verifierSection = `
## Verify
- Before you close the ticket, once your checks pass after your last commit, have the verifier
  subagent (${verifierPath}) check your change: give it the ticket's ID, TICKET_ID, the
  commit at which your checks passed (\`git rev-parse HEAD\`), the commands you ran there, and the
  file their output is in where you kept one, so that it needn't run them again; nothing of your
  reasoning. Run it in the foreground and wait for its answer.
- Fix each gap it reports that affects correctness or the ticket's requirements, commit, run your
  checks again, and ask it again with the new commit and commands. The rest is optional: note on
  the ticket any you leave.
- From the second round on, give it the earlier rounds' findings too: each round's verdict and the
  gaps it raised, as it gave them, still nothing of your reasoning, so that it weighs them rather
  than start blind. When it disagrees with an earlier round (a line that starts DISAGREES WITH
  ROUND), don't go round again to settle it: note both rounds' findings on the ticket and ask the
  maintainer which holds, as a question, as under Close.
- After three rounds that still end in FAIL, note its findings on the ticket. Close the ticket only
  when you judge them outside the ticket's requirements; otherwise defer it, as under Close.
`

/** The worker prompt's line before its bullets on running each suite on part of the project. */
export const suitesIntro = "  The suites, and how to run each on part of the project:\n"

/** `text` as Markdown code on one line: in double backticks where it has a backtick. */
const codeSpan = (text: string): string => {
  const line = sanitizeLine(text).trim().split(/\s+/).join(" ")
  return line.includes("`") ? `\`\` ${line} \`\`` : `\`${line}\``
}

/**
 * The worker prompt's lines on how to run each suite on part of the project, a bullet a suite, for
 * the suites check-fast.sh runs (`fast`) and those check-full.sh runs after it (`full`): the command
 * the scout gave for part of the project, or else the whole suite, the slower ones where the change
 * touches what they cover. A suite that takes turns is left to the merge check, which takes turns on
 * it with the other worktrees' checks. "" with no suites: the template's lines then say where the
 * suites are.
 */
export const suiteLines = (fast: ReadonlyArray<Suite>, full: ReadonlyArray<Suite>): string => {
  const quick = withoutRunners(fast).kept
  const slow = withoutRunners(full).kept
  const bullets = [...quick, ...slow].map((suite, index) => {
    const slower = index >= quick.length
    const label = sanitizeLine(suite.name).trim().split(/\s+/).join(" ")
    const command = codeSpan(suite.command)
    const name = `${label === "" ? command : label}${slower ? " (slower)" : ""}`
    const whole = label === "" ? "whole" : `${command}, whole`
    const targeted = suite.targeted?.trim() ?? ""
    if (suite.serial) {
      return `  - ${name}: leave it to the merge check; two copies at once, in two worktrees, collide\n`
    }
    if (targeted !== "") return `  - ${name}: ${codeSpan(targeted)}\n`
    return slower
      ? `  - ${name}: ${whole}, where the change touches what it covers\n`
      : `  - ${name}: ${whole}, as it doesn't run on part of the project\n`
  })
  return bullets.length === 0 ? "" : suitesIntro + bullets.join("")
}

/** Whether a worker prompt has workers run the verifier. */
export const usesVerifier = (prompt: string): boolean => prompt.includes(verifierPath)

/**
 * The verifier for a project built with `stack`, whose runners run `fast` and, after check-fast.sh,
 * `full`.
 */
export const verifierText = (
  stack: ReadonlyArray<string>,
  fast: ReadonlyArray<string>,
  full: ReadonlyArray<string>,
): string => {
  const list = (items: ReadonlyArray<string>, indent: string, none: string) =>
    items.length === 0 ? `${indent}- ${none}` : items.map((item) => `${indent}- ${item}`).join("\n")
  const code = (items: ReadonlyArray<string>) => items.map((item) => `\`${item}\``)
  return verifierTemplate
    .replace(
      "{{stack}}",
      list(
        stack,
        "",
        "tutti init's scout didn't describe the stack: read the manifests (go.mod, package.json,\n  pyproject.toml and the like) to learn it.",
      ),
    )
    .replace("{{fast}}", list(code(fast), "  ", "nothing yet."))
    .replace("{{full}}", list(code(full), "  ", "nothing more."))
    .replaceAll("{{fastRunner}}", fastRunner)
    .replaceAll("{{fullRunner}}", fullRunner)
}

/** The commands of the runner at `path` in `repo`, for the verifier: check-full's own, after check-fast. */
const runnerSuites = (repo: string, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const script = yield* fs.readFileString(join(repo, path)).pipe(Effect.option)
    if (Option.isNone(script)) return []
    return runnerCommands(script.value).filter(
      (command) => command !== "exit 0" && !runsRunner(command),
    )
  })

/**
 * The verifier init writes now for the project at `repo` built with `stack`: its runners' commands
 * as they are.
 */
export const verifierFor = (repo: string, stack: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fast = yield* runnerSuites(repo, fastRunner)
    const full = yield* runnerSuites(repo, fullRunner)
    return verifierText(stack, fast, full)
  })

/**
 * Writes the verifier where `consent` adds it, keeping one there, and appends the section that runs
 * it to the worker prompt at `promptPath` where it lacks one. It runs once the prompt and the
 * runners are written. Its step; none where the verifier is neither chosen nor asked about.
 */
export const applyVerifier = (
  repo: string,
  promptPath: string,
  consent: Consent,
  stack: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const label = "verifier"
    if (consent === "unasked") {
      return [
        step(
          "kept",
          label,
          `not asked (no terminal): --verifier writes ${verifierPath}, a subagent that checks each ticket's change in a fresh context`,
        ),
      ]
    }
    if (!consent) return []
    const did: Array<string> = []
    const commit: Array<string> = []
    const file = join(repo, verifierPath)
    if (yield* fs.exists(file)) {
      did.push(`${verifierPath} is there; left as it is`)
    } else {
      const text = yield* verifierFor(repo, stack)
      yield* fs.makeDirectory(join(file, ".."), { recursive: true })
      yield* fs.writeFileString(file, text)
      did.push(`wrote ${verifierPath}`)
      commit.push(verifierPath)
    }
    const prompt = join(repo, promptPath)
    const text = yield* fs.readFileString(prompt)
    const runs = usesVerifier(text)
    if (runs) {
      did.push("the worker prompt runs it already")
    } else {
      yield* fs.writeFileString(
        prompt,
        `${text === "" || text.endsWith("\n") ? text : `${text}\n`}${verifierSection}`,
      )
      did.push("the worker prompt has workers run it before they close a ticket")
      commit.push(promptPath)
    }
    return [step(commit.length === 0 ? "kept" : "done", label, did.join("; "), commit)]
  })

// --- The test work ---

/** Labels the tickets init files for the project's tests: init run again finds those still open. */
export const testWorkLabel = "tutti-tests"

/** A ticket init files for the project's tests. */
export interface TestTicket {
  readonly title: string
  readonly description: string
  readonly acceptance: string
  readonly type: "epic" | "task"
  readonly priority: number
  readonly labels: ReadonlyArray<string>
  /** The index in the plan of its epic, which comes before it; null for none. */
  readonly parent: number | null
  /** The indexes of the tickets it waits for, which come before it. */
  readonly blockedBy: ReadonlyArray<number>
}

export const testsEpicTitle = "The project's tests"
export const setUpTestsTitle = "Set up the test harness and a first suite"
export const mapUntestedTitle = "Map the untested areas"

/** The title of the ticket that gets the runners passing on `base`. */
export const passRunnersTitle = (base: string): string =>
  `Make ${fastRunner} and ${fullRunner} pass on ${base}`

/**
 * The work a choice files for the project's tests on `base`, an epic before its tickets: from
 * scratch, an epic and the solo P1 ticket that sets the tests up; with the suites found, the solo
 * P1 ticket that gets the runners passing, under an epic with the ticket mapping the untested areas
 * after it where those are filed. Manual files nothing. Every ticket is labelled tutti-tests.
 */
export const testWork = (
  choice: ChecksChoice | undefined,
  base: string,
): ReadonlyArray<TestTicket> => {
  const skill = `the create-check-suite skill (${skillPath})`
  const runners = `${fastRunner} and ${fullRunner}`
  const epic: TestTicket = {
    title: testsEpicTitle,
    type: "epic",
    priority: 2,
    labels: [testWorkLabel],
    parent: null,
    blockedBy: [],
    description: `The tests tutti's checks run: ${fastRunner} on every merge, ${fullRunner} once at the end of a run. tutti init filed it with the tickets that set them up; each untested area gets a P3 ticket here.`,
    acceptance: "",
  }
  if (choice?.kind === "scratch") {
    return [
      epic,
      {
        title: setUpTestsTitle,
        type: "task",
        priority: 1,
        labels: [testWorkLabel, soloLabel],
        parent: 0,
        blockedBy: [],
        description: `tutti init wrote ${runners} checking nothing (exit 0): until this ticket is done, nothing merged is checked. It runs first and alone (P1, solo), so nothing merges meanwhile.\n\nUse ${skill}, every section:\n- set up a harness and smoke tests in the project's own frameworks, added to the runners;\n- get both runners passing on ${base};\n- map the features in FEATURES.md;\n- file one P3 ticket per untested area, under this ticket's epic.`,
        acceptance: `${runners} run the new suites and exit 0 on ${base}; FEATURES.md maps the features; each untested area has a P3 ticket under the epic.`,
      },
    ]
  }
  if (choice?.kind !== "found") return []
  const pass: TestTicket = {
    title: passRunnersTitle(base),
    type: "task",
    priority: 1,
    labels: [testWorkLabel, soloLabel],
    parent: null,
    blockedBy: [],
    description: `tutti init wrote ${runners} from the suites the project has. Every merge runs ${fastRunner}, so it runs first and alone (P1, solo).\n\nRun them, check-fast first, and fix what fails. A failing test whose fix isn't trivial and plainly right is skipped with its framework's own skip, naming in the skip's reason a bug ticket filed for it. Run each runner twice more, to catch a test that passes only sometimes, and record how long each takes in this ticket's notes.`,
    acceptance: `${runners} exit 0 on ${base}, three times running; how long each takes is in the notes.`,
  }
  if (!choice.fileUntested) return [pass]
  return [
    epic,
    { ...pass, parent: 0 },
    {
      title: mapUntestedTitle,
      type: "task",
      priority: 2,
      labels: [testWorkLabel],
      parent: 0,
      blockedBy: [1],
      description: `Use ${skill} to map the project's features and what has no test: read the repository (section 1), write FEATURES.md (section 5) and file one P3 ticket per untested area under this ticket's epic (section 6). It waits for "${pass.title}", so the map starts from runners that pass.`,
      acceptance:
        "FEATURES.md maps the features, with the suites and how long each runner takes; each untested area has a P3 ticket under the epic.",
    },
  ]
}

/**
 * Files the test work `choice` calls for on `base` with bd: a step for each ticket, filed or found
 * open from an earlier init (labelled tutti-tests, with the same title) and not filed again. A
 * ticket that can't be filed is a step saying why, naming those after it: the files init wrote
 * stand, and init run again files what is missing.
 */
export const fileTestWork = (choice: ChecksChoice | undefined, base: string) =>
  Effect.gen(function* () {
    const plan = testWork(choice, base)
    if (plan.length === 0) return []
    const beads = yield* Beads
    const label = "ticket"
    const notFiled = (from: number, why: string) =>
      step(
        "caution",
        label,
        `not filed: ${plan
          .slice(from)
          .map((ticket) => `"${ticket.title}"`)
          .join(", ")} (${why}); run tutti init again to file them`,
      )
    const filed = yield* Effect.result(beads.list({ labels: [testWorkLabel] }))
    if (filed._tag === "Failure") return [notFiled(0, beadsWhy(filed.failure))]
    const open = new Map<string, string>()
    for (const issue of filed.success) if (!open.has(issue.title)) open.set(issue.title, issue.id)
    const steps: Array<Step> = []
    const ids: Array<string> = []
    for (const [at, ticket] of plan.entries()) {
      const there = open.get(ticket.title)
      if (there !== undefined) {
        ids.push(there)
        steps.push(step("kept", label, `${there} is open: ${ticket.title}; not filed again`))
        continue
      }
      const parent = ticket.parent === null ? undefined : ids[ticket.parent]
      const created = yield* Effect.result(
        beads.create({
          title: ticket.title,
          description: ticket.description,
          ...(ticket.acceptance === "" ? {} : { acceptance: ticket.acceptance }),
          type: ticket.type,
          priority: ticket.priority,
          labels: ticket.labels,
          ...(parent === undefined ? {} : { parent }),
          ...(ticket.blockedBy.length === 0
            ? {}
            : { blockedBy: ticket.blockedBy.flatMap((index) => ids[index] ?? []) }),
        }),
      )
      if (created._tag === "Failure") return [...steps, notFiled(at, beadsWhy(created.failure))]
      const id = created.success.id
      ids.push(id)
      const kind = `${ticket.type === "epic" ? "epic" : `P${ticket.priority}`}${ticket.labels.includes(soloLabel) ? ", solo" : ""}`
      steps.push(step("done", label, `filed ${id} (${kind}): ${ticket.title}`))
    }
    return steps
  })
