// tutti's commands (§ 8.1): `tutti` takes the run flags (§ 8.2), and its subcommands are in the
// table below. Each subcommand finds the project's main checkout from wherever it is started, a
// ticket's worktree included, since that is where an agent answering a request runs.
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import pkg from "../../package.json" with { type: "json" }
import { answerWords } from "../agent/attentionFiles.ts"
import { answer, list, show, showJson, takenLine } from "../answer/answer.ts"
import { Git, GitWriter } from "../services/Git.ts"
import { cliFlags } from "./flags.ts"

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

// A command's failure: its message on stderr, and exit status 1.
const failed = (message: string) =>
  Effect.andThen(
    Console.error(`tutti answer: ${message}`),
    Effect.sync(() => {
      process.exitCode = 1
    }),
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
        const found = yield* Effect.result(repo)
        if (found._tag === "Failure") {
          const error = found.failure
          return yield* failed(typeof error === "string" ? error : error.message)
        }
        const top = found.success
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

/** tutti and its subcommands, the main checkout found with `repo`. */
export const tuttiWith = <E extends { readonly message: string } | string, R>(
  repo: Effect.Effect<string, E, R>,
) =>
  // Until the run is assembled, a bare `tutti` prints the version.
  Command.make("tutti", cliFlags, () => Console.log(pkg.version)).pipe(
    Command.withDescription("runs Claude Code workers on a Beads backlog, one worktree per ticket"),
    Command.withSubcommands([answerCommand(repo)]),
  )

/** tutti's commands, each finding the main checkout from the folder it was started in. */
export const tutti = tuttiWith(Effect.suspend(() => mainCheckout(process.cwd())))
