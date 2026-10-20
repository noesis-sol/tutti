// tutti's commands (§ 8.1): `tutti` takes the run flags (§ 8.2), and its subcommands are in the
// table below. Each subcommand finds the project's main checkout from wherever it is started, a
// ticket's worktree included, since that is where an agent answering a request runs.
import { Console, Effect, Layer, Option, Result, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import pkg from "../../package.json" with { type: "json" }
import { Account } from "../agent/Account.ts"
import { answerWords } from "../agent/attentionFiles.ts"
import { buildTarget, resolveClaude } from "../agent/claudeBinary.ts"
import { claudeConfigFile } from "../agent/mcp.ts"
import { answer, list, show, showJson, takenLine } from "../answer/answer.ts"
import { scoutSearch } from "../init/checks.ts"
import { cancelledLine, type InitFlags, type InitForm, init, summaryLines } from "../init/init.ts"
import { lineForm } from "../init/lineForm.ts"
import { liveMachine } from "../init/steps.ts"
import { parseMcpNames } from "../init/workers.ts"
import { layer as languageModelLayer } from "../organs/AgentSdkLanguageModel.ts"
import { OrganCost } from "../organs/OrganCost.ts"
import { Organs } from "../organs/Organs.ts"
import { plan } from "../plan/plan.ts"
import { initCancelled, initHeader, initSummary } from "../print/initSummary.ts"
import { maxConcurrent } from "../project/settings.ts"
import { exitCodes } from "../run/holds.ts"
import { Log } from "../run/log.ts"
import { findRepository } from "../run/startup.ts"
import { Beads } from "../services/Beads.ts"
import { Git, GitWriter } from "../services/Git.ts"
import { RunLock } from "../services/RunLock.ts"
import * as Tty from "../services/Tty.ts"
import { initFormKind, openInitForm } from "../ui/InitForm.tsx"
import { streamInput } from "../ui/plain/forms.ts"
import { open as openRenderer } from "../ui/renderer.ts"
import {
  type Appearance,
  appearanceOf,
  makeTheme,
  orchestraLoaded,
  outputAppearance,
  type Theme,
} from "../ui/theme.ts"
import { releaseKeys } from "../update/keys.ts"
import { type Build, githubReleases, update } from "../update/update.ts"
import { AppConfig, layer as appConfigLayer, load, SetupProblem } from "./AppConfig.ts"
import { colours } from "./colours.ts"
import {
  cliFlags,
  count,
  noFlags,
  onOff,
  positiveTime,
  type Reader,
  type RunFlags,
  runFlags,
} from "./flags.ts"
import { login, runInTerminal } from "./login.ts"
import { releaseBuild, tuttiVersion } from "./version.ts"

/** The main checkout of the repository `dir` is in: the first of its worktrees. */
export const mainCheckout = (dir: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const worktrees = yield* git.worktrees(dir)
    const main = worktrees[0]
    if (main === undefined) return yield* Effect.fail(`${dir} has no main checkout`)
    return main.path
  }).pipe(
    Effect.mapError((error) =>
      typeof error === "string"
        ? error
        : error._tag === "GitFailed"
          ? `${dir} isn't in a git repository: ${error.stderr.trim()}`
          : `git took too long to list ${dir}'s worktrees`,
    ),
    Effect.provide(Git.layer()),
    Effect.provide(GitWriter.layer),
  )

/** A subcommand failed, and said why on stderr; tutti exits with status 1. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
}) {}

// A command's failure: its message on stderr, and CommandFailed.
const failedIn = (command: string) => (message: string) =>
  Effect.andThen(
    Console.error(`tutti ${command}: ${message}`),
    Effect.fail(new CommandFailed({ command })),
  )

const failed = failedIn("answer")

/** The main checkout `repo` finds, or the command's failure saying why it found none. */
const checkout = <E extends { readonly message: string } | string, R>(
  repo: Effect.Effect<string, E, R>,
  command: string,
) =>
  Effect.catch(repo, (error) =>
    failedIn(command)(typeof error === "string" ? error : error.message),
  )

/** `tutti answer`, finding the main checkout with `repo`. */
export const answerCommand = <E extends { readonly message: string } | string, R>(
  repo: Effect.Effect<string, E, R>,
) =>
  Command.make(
    "answer",
    {
      request: Argument.String("request-id").pipe(
        Argument.withDescription("the request to answer, as tutti answer lists it"),
        Argument.optional,
      ),
      answer: Argument.Literals("answer", answerWords).pipe(
        Argument.withDescription("allow, allow-run (allow for this run) or deny"),
        Argument.optional,
      ),
      json: Flag.Boolean("json").pipe(
        Flag.withDescription("list the open requests as JSON, for scripts and agents"),
        Flag.withDefault(false),
      ),
      reason: Flag.String("reason").pipe(
        Flag.withDescription("with deny, the reason the worker is told"),
        Flag.optional,
      ),
      choice: Flag.String("choice").pipe(
        Flag.withDescription("a question's chosen option, once per question in order"),
        Flag.atLeast(0),
      ),
      confirm: Flag.Boolean("confirm").pipe(
        Flag.withDescription("allow a request held by the safety check (defaultToNo)"),
        Flag.withDefault(false),
      ),
    },
    (given) =>
      Effect.gen(function* () {
        const top = yield* checkout(repo, "answer")
        if (Option.isNone(given.request)) {
          const requests = yield* list(top)
          return yield* Console.log(given.json ? showJson(requests) : show(requests))
        }
        if (Option.isNone(given.answer)) {
          return yield* failed(
            `say how to answer request ${given.request.value}: allow, allow-run or deny`,
          )
        }
        const answering = {
          request: given.request.value,
          answer: given.answer.value,
          ...(Option.isSome(given.reason) ? { reason: given.reason.value } : {}),
          choices: given.choice,
          confirm: given.confirm,
        }
        yield* answer(top, answering).pipe(
          Effect.andThen(Console.log(takenLine(answering))),
          Effect.catch((error) => failed(error.message)),
        )
      }),
  ).pipe(
    Command.withDescription(
      "list the run's open attention requests, or answer one: tutti answer <request-id> allow|allow-run|deny",
    ),
  )

/** bd, git and the run lock in the project at `repo`, for `tutti plan`. */
export const planServices = (repo: string) =>
  Layer.mergeAll(
    Beads.layer({ cwd: repo }),
    Git.layer().pipe(Layer.provide(GitWriter.layer)),
    RunLock.layer,
  )

/** `tutti plan`, finding the main checkout with `repo` and reading it with `services`. */
export const planCommand = <E extends { readonly message: string } | string, R, S>(
  repo: Effect.Effect<string, E, R>,
  services: (repo: string) => Layer.Layer<Beads | Git | RunLock, never, S>,
) =>
  Command.make(
    "plan",
    {
      apply: Flag.Boolean("apply").pipe(
        Flag.withDescription("add the proposed links with bd dep add"),
        Flag.withDefault(false),
      ),
    },
    (given) =>
      Effect.gen(function* () {
        const top = yield* checkout(repo, "plan")
        yield* plan(top, given.apply).pipe(
          Effect.provide(services(top)),
          Effect.catch(failedIn("plan")),
        )
      }),
  ).pipe(
    Command.withDescription(
      "propose blocks links between the open tickets that touch the same code, so they run one after the other, the higher-priority ticket first: tickets naming the same function, or working on the same file of at most 200 lines unless both name different functions it mentions. Without --apply it only prints the proposal",
    ),
  )

/**
 * `tutti login`, its probe run in the main checkout `repo` finds, or in the folder it was started
 * in outside a repository: the login is the user's, not the project's.
 */
export const loginCommand = <E, R>(repo: Effect.Effect<string, E, R>) =>
  Command.make(
    "login",
    {
      claude: runFlags.claude.flag.pipe(
        Flag.withDescription(
          `log in with this Claude Code instead of the embedded one [${runFlags.claude.variable}]`,
        ),
      ),
    },
    (given) =>
      Effect.gen(function* () {
        const top = yield* Effect.orElseSucceed(repo, () => process.cwd())
        yield* login(runInTerminal, Account.layer, (claude) =>
          resolveClaude(claude, process.cwd()),
        ).pipe(
          Effect.provide(appConfigLayer({ ...noFlags, claude: given.claude }, top)),
          Effect.catch((error) =>
            Effect.andThen(
              Effect.forEach(error.message.split("\n"), (problem) =>
                Console.error(`tutti login: ${problem}`),
              ),
              Effect.fail(new CommandFailed({ command: "login" })),
            ),
          ),
        )
      }),
  ).pipe(
    Command.withDescription(
      "log in to Claude with Claude Code's own login (claude auth login), then say which account and billing workers get",
    ),
  )

/**
 * `tutti colours`, reading the settings of the main checkout `repo` finds, or only the user's
 * outside a repository: it previews the scheme named, else the one in use by default.
 */
export const coloursCommand = <E, R>(repo: Effect.Effect<string, E, R>) =>
  Command.make(
    "colours",
    {
      name: Argument.String("name").pipe(
        Argument.withDescription("the scheme to preview (default: the one in use)"),
        Argument.optional,
      ),
    },
    (given) =>
      Effect.gen(function* () {
        const top = yield* Effect.orElseSucceed(repo, () => process.cwd())
        yield* colours.pipe(
          Effect.provide(appConfigLayer({ ...noFlags, colourScheme: given.name }, top)),
          Effect.provide(Tty.layer),
          Effect.catch((error) =>
            Effect.andThen(
              Effect.forEach(
                (typeof error === "string" ? error : error.message).split("\n"),
                (problem) => Console.error(`tutti colours: ${problem}`),
              ),
              Effect.fail(new CommandFailed({ command: "colours" })),
            ),
          ),
        )
      }),
  ).pipe(
    Command.withDescription(
      "preview a colour scheme, the one in use by default: every role's colour and where it comes from, a mock of the dashboard, and anything that keeps the scheme from being used, which exits 1",
    ),
  )

/** The running tutti, for tutti update: the compiled binary, or Bun running it from source. */
export const thisBuild = Effect.map(tuttiVersion, (shown): Build => {
  const target = buildTarget()
  return {
    version: pkg.version,
    shown,
    kind: releaseBuild ? "release" : target !== null ? "clone" : "source",
    target,
    exe: process.execPath,
  }
})

/** `tutti update`: the running build from the latest GitHub Release, verified with the release keys. */
export const updateCommand = Command.make(
  "update",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "only say whether a newer release is out, exiting 1 when one is; change nothing",
      ),
      Flag.withDefault(false),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription(
        "replace a build from a clone, or one newer than the latest release, too",
      ),
      Flag.withDefault(false),
    ),
  },
  (given) =>
    Effect.gen(function* () {
      const code = yield* update(given, yield* thisBuild, {
        releases: githubReleases,
        keys: releaseKeys,
        say: {
          out: (line) => process.stdout.write(`${line}\n`),
          error: (line) => process.stderr.write(`${line}\n`),
        },
      })
      process.exitCode = code
    }),
).pipe(
  Command.withDescription(
    "replace this tutti with the latest GitHub Release's binary for its platform, once the signature of the release's checksums.txt verifies with a release key built into tutti and the archive's SHA-256 matches it. A build from a clone is replaced only with --force. Exit codes: 0 updated or nothing to do (--check: none newer), 1 --check: a newer release is out, 2 refused (a build from a clone, tutti run from source, a folder it can't write in), 4 the update failed",
  ),
)

/** An init flag's text: absent unless given. */
const initFlag = (
  name: string,
  description: string,
  options: { readonly alias?: string; readonly metavar?: string; readonly onOff?: true } = {},
) => {
  let flag = Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withMetavar(options.metavar ?? (options.onOff ? "on|off" : "value")),
  )
  if (options.onOff) flag = Flag.withOptionalValue(flag, "true")
  if (options.alias !== undefined) flag = Flag.withAlias(flag, options.alias)
  return Flag.optional(flag)
}

/** tutti init's flags, orchestra init's, each read by readInitFlags. */
export const initFlags = {
  checkFast: initFlag(
    "check-fast",
    `the command scripts/check-fast.sh runs, the merge check (lint, build, the fast tests); "" for a check that passes at once`,
    { alias: "check", metavar: "command" },
  ),
  checkFull: initFlag(
    "check-full",
    `the slower suites' command, which scripts/check-full.sh runs after check-fast.sh, once at the end of a run; "" for none`,
    { metavar: "command" },
  ),
  checkFastTimeout: initFlag(
    "check-fast-timeout",
    "how long check-fast may run on a rebased ticket, e.g. 5m (default 30m)",
    { alias: "check-timeout", metavar: "time" },
  ),
  checkFullTimeout: initFlag(
    "check-full-timeout",
    "how long check-full may run at the end of a run, e.g. 90m (default 60m)",
    { metavar: "time" },
  ),
  setup: initFlag(
    "setup",
    `the command that installs the dependencies in a worktree, run before check-fast when a rebase changes a lockfile, e.g. "npm ci"; "" for none (offered for a lockfile when omitted; an existing setting is kept)`,
    { metavar: "command" },
  ),
  concurrent: initFlag(
    "concurrent",
    `tickets to run at the same time by default, 1 to ${maxConcurrent} (asked when omitted)`,
    { alias: "c", metavar: "N" },
  ),
  mcp: initFlag(
    "mcp",
    `the MCP servers workers get, by name, comma-separated, e.g. postgres,firecrawl; "" for none (asked when omitted)`,
    { metavar: "names" },
  ),
  changelogUnion: initFlag(
    "changelog-union",
    "add 'CHANGELOG.md merge=union' to .gitattributes, so two tickets' changelog entries don't conflict (asked when omitted; =false declines)",
    { onOff: true },
  ),
  installBeads: initFlag(
    "install-beads",
    "install Beads (bd) where it is missing, with Homebrew or the Beads install script (asked when omitted; =false declines)",
    { onOff: true },
  ),
  verifier: initFlag(
    "verifier",
    "write .claude/agents/verifier.md, a subagent that checks each ticket's change against the ticket in a fresh context, and have the worker prompt run it before a worker closes its ticket (asked when omitted; =false declines)",
    { onOff: true },
  ),
  prefix: initFlag(
    "prefix",
    "the Beads ticket prefix, IDs reading <prefix>-<hash>: lowercase letters, digits and hyphens, starting with a letter; a new Beads takes it, and an existing one's tickets are all renamed to it with bd rename-prefix (kept when not given)",
    { metavar: "name" },
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("replace an existing .tutti/worker-prompt.md with the built-in template"),
    Flag.withDefault(false),
  ),
}

/** The texts of init's flags, as effect/cli parsed them. */
export type InitFlagTexts = {
  readonly [K in Exclude<keyof typeof initFlags, "force">]: Option.Option<string>
} & { readonly force: boolean }

/** Reads init's flags: their values, or every problem with them, each after `--name`. */
export const readInitFlags = (
  given: InitFlagTexts,
): Result.Result<InitFlags, ReadonlyArray<string>> => {
  const problems: Array<string> = []
  const read = <A>(name: string, text: Option.Option<string>, reader: Reader<A>) => {
    if (Option.isNone(text)) return {}
    const value = reader(text.value)
    if (Result.isFailure(value)) {
      problems.push(`--${name} ${value.failure}`)
      return {}
    }
    return { value: value.success }
  }
  const asIs: Reader<string> = (text) => Result.succeed(text)
  const pick = <K extends keyof InitFlags, A extends InitFlags[K]>(
    key: K,
    read: { readonly value?: A },
  ) => (read.value === undefined ? {} : { [key]: read.value })
  const flags: InitFlags = {
    ...pick("concurrent", read("concurrent", given.concurrent, count(1, maxConcurrent))),
    ...pick(
      "mcp",
      read("mcp", given.mcp, (text) => Result.succeed(parseMcpNames(text))),
    ),
    ...pick("changelogUnion", read("changelog-union", given.changelogUnion, onOff)),
    ...pick("installBeads", read("install-beads", given.installBeads, onOff)),
    ...pick("verifier", read("verifier", given.verifier, onOff)),
    ...pick("prefix", read("prefix", given.prefix, asIs)),
    ...pick("checkFast", read("check-fast", given.checkFast, asIs)),
    ...pick("checkFull", read("check-full", given.checkFull, asIs)),
    ...pick("checkFastTimeout", read("check-fast-timeout", given.checkFastTimeout, positiveTime)),
    ...pick("checkFullTimeout", read("check-full-timeout", given.checkFullTimeout, positiveTime)),
    ...pick("setup", read("setup", given.setup, asIs)),
    force: given.force,
  }
  return problems.length > 0 ? Result.fail(problems) : Result.succeed(flags)
}

/** init stopped, having said why: it exits with status 2 and the project as it was. */
const initStopped = (lines: ReadonlyArray<string>) =>
  Effect.andThen(
    Effect.forEach(lines, (line) => Console.error(line)),
    Effect.sync(() => {
      process.exitCode = exitCodes.setup
    }),
  )

/**
 * tutti init in the folder `cwd`: from the main checkout, asking in its own renderer where stdin and
 * stdout are a terminal that draws one, in lines with TERM=dumb, else asking nothing; then its
 * summary on the main screen.
 */
const runInit = (cwd: string, flags: InitFlags) =>
  Effect.gen(function* () {
    const found = yield* findRepository(cwd)
    if (Result.isFailure(found)) return yield* initStopped([`tutti init: ${found.failure}`])
    const { repo, linked } = found.success
    if (linked !== null) {
      return yield* initStopped([
        `tutti init: ${linked} is a linked worktree. Run this from the main checkout.`,
      ])
    }
    const git = yield* Git
    const commonDir = yield* Effect.result(git.commonDir(repo))
    if (Result.isFailure(commonDir)) {
      return yield* initStopped([`tutti init: tutti cannot find the git folder of ${repo}`])
    }
    const branch = Option.getOrElse(
      yield* git.currentBranch(repo).pipe(Effect.orElseSucceed(() => Option.none<string>())),
      () => "HEAD",
    )
    const machine = yield* liveMachine
    const claudeConfig = yield* claudeConfigFile
    const configure = Effect.gen(function* () {
      const config = yield* load(noFlags, repo)
      const claude = yield* resolveClaude(config.claude, cwd)
      if (claude.problems.length > 0) return yield* new SetupProblem({ problems: claude.problems })
      return { ...config, claude: claude.path }
    })
    // The scout, under the project's configuration as it is, over the Agent SDK with the login the
    // probe finds. init keeps no log, so its organ cost lines go nowhere.
    const quietLog = Layer.succeed(
      Log,
      Log.of({ write: () => Effect.void, lines: Effect.succeed([]) }),
    )
    const scout = Effect.gen(function* () {
      const config = yield* configure.pipe(Effect.mapError((problem) => problem.message))
      const withConfig = Layer.succeed(AppConfig, config)
      const probed = yield* Effect.flatMap(Account, (account) => account.probe).pipe(
        Effect.provide(Layer.provide(Account.layer, withConfig)),
        Effect.mapError((error) => error.message),
      )
      return yield* scoutSearch(repo).pipe(
        Effect.provide(
          Organs.layer.pipe(
            Layer.provideMerge(languageModelLayer({ account: probed })),
            Layer.provideMerge(OrganCost.layer),
            Layer.provideMerge(Layer.mergeAll(withConfig, quietLog)),
          ),
        ),
      )
    })
    const tty = yield* Effect.provide(
      Effect.gen(function* () {
        return yield* Tty.Tty
      }),
      Tty.layer,
    )
    const kind = initFormKind(tty)
    const config = kind === null ? Option.none() : yield* Effect.option(load(noFlags, repo))
    const chosen = Option.match(config, {
      onNone: () => "auto" as const,
      onSome: (value) => value.appearance,
    })
    const themeOf = (appearance: Appearance) =>
      makeTheme(
        Option.match(config, {
          onNone: () => orchestraLoaded,
          onSome: (value) => value.scheme,
        }).scheme,
        {
          appearance,
          depth: tty.colourDepth === "truecolor" ? "truecolor" : "256",
          noColor: Option.match(config, {
            onNone: () => false,
            onSome: (value) => value.noColor,
          }),
        },
      )
    // The theme the summary is printed in, once the form is done: the variant the renderer
    // detected, or the one the line form asked in; none without a form.
    const printed: { theme: Theme | null } = { theme: null }
    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        let form: InitForm | null = null
        if (kind === "renderer") {
          // The form's own renderer, destroyed when this scope closes, before the summary.
          const shell = yield* Effect.option(openRenderer({ chosen, mouse: false }))
          if (Option.isSome(shell)) {
            const opened = shell.value
            form = yield* openInitForm(opened, themeOf, repo)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                printed.theme = themeOf(opened.appearance.get())
              }),
            )
          }
        }
        if (form === null && kind !== null) {
          // TERM=dumb, or a renderer that couldn't be opened: the line forms.
          const theme = themeOf(
            tty.dumb ? appearanceOf(chosen, null) : yield* outputAppearance(chosen, null),
          )
          printed.theme = theme
          process.stdout.write(`${initHeader(theme, repo)}\n`)
          const input = yield* streamInput(process.stdin)
          form = lineForm({ input, write: (text) => process.stdout.write(text), theme })
        }
        return yield* Effect.result(
          init({
            repo,
            commonDir: commonDir.success,
            branch,
            version: pkg.version,
            flags,
            form,
            scout,
            machine,
            configure,
            account: Account.layer,
            claudeConfig,
          }).pipe(Effect.provide(RunLock.layer), Effect.provide(Beads.layer({ cwd: repo }))),
        )
      }),
    )
    const { theme } = printed
    if (Result.isFailure(ran)) {
      const error = ran.failure
      if (error._tag === "FormCancelled" && theme !== null) {
        yield* Console.error(initCancelled(theme))
        process.exitCode = exitCodes.setup
        return
      }
      return yield* initStopped([
        error._tag === "FormCancelled" ? cancelledLine : `tutti init: ${error.message}`,
      ])
    }
    if (theme === null) {
      yield* Console.log(summaryLines(ran.success).join("\n"))
      return
    }
    // After the renderer's form, on the main screen: the title the alternate screen took with it.
    if (kind === "renderer") yield* Console.log(initHeader(theme, repo))
    const width = Math.min(process.stdout.columns ?? 80, 100)
    yield* Console.log(`${initSummary(ran.success, theme, width)}\n`)
  }).pipe(Effect.provide(Git.layer()), Effect.provide(GitWriter.layer))

/** `tutti init`, in the folder tutti was started in. */
export const initCommand = Command.make("init", initFlags, (given) =>
  Effect.gen(function* () {
    const flags = readInitFlags(given)
    if (Result.isFailure(flags)) {
      return yield* initStopped(flags.failure.map((problem) => `tutti init: ${problem}`))
    }
    yield* runInit(process.cwd(), flags.success)
  }),
).pipe(
  Command.withDescription(
    "set up Beads and .tutti/ in this repository: bd installed where it is missing, bd init where Beads isn't set up; the worker prompt, the settings (how many tickets run at the same time, the MCP servers workers get, the checks and their time limits), a .gitignore, and the checks' runners (scripts/check-fast.sh and scripts/check-full.sh; one that is there is kept unless its flag is given); CHANGELOG.md merge=union offered; then the login probe's account, billing and permission mode. In a terminal it asks what the flags don't give. Run it from the main checkout, between runs",
  ),
)

/**
 * tutti and its subcommands, the main checkout found with `repo`; `tutti plan` reads it with
 * `services`. A bare `tutti` is `run` with its flags (src/main.ts gives it the run); without one, it
 * prints the version.
 */
export const tuttiWith = <E extends { readonly message: string } | string, R, S, R2 = never>(
  repo: Effect.Effect<string, E, R>,
  services: (repo: string) => Layer.Layer<Beads | Git | RunLock, never, S>,
  run: (flags: RunFlags) => Effect.Effect<void, never, R2> = () => Console.log(pkg.version),
) =>
  Command.make("tutti", cliFlags, run).pipe(
    Command.withDescription("runs Claude Code workers on a Beads backlog, one worktree per ticket"),
    Command.withSubcommands([
      initCommand,
      answerCommand(repo),
      planCommand(repo, services),
      loginCommand(repo),
      coloursCommand(repo),
      updateCommand,
    ]),
  )
