// --feature "<request>" (§ 5 item 13, § 4.10, § 7.1 Plan confirmation), as orchestra v0.7.7's
// feature run: the screen judges the request, the plan organ turns it into an epic and its tickets,
// the plan is shown and confirmed (File these N tickets and start the run? [y/N]; --yes files it
// without asking), and tutti files it with bd and runs the epic as --ticket would (scopedTo).
// Nothing is filed until the plan is confirmed, and the startup checks have passed by then, so a
// run that couldn't start files nothing either.
//
// Each step that stops the feature says why on stderr, and in the log as a FEATURE line, and gives
// the exit code: 2 for a request rejected, unclear, unscreened or unplanned, or no terminal to ask
// on without --yes; 4 when bd failed; 0 when the plan was declined; 130 when Ctrl+C or the end of
// input stopped it before filing. The organs' steps are organ lines on stdout, a spinner beside
// each while it runs (print/organLine.ts). With the dashboard, the confirmation is asked in the
// command's one renderer (inRenderer): the organ lines stay on the main screen before it opens,
// and what the run says once it is open is said there after it has gone.
import { Data, Effect, type FileSystem, Option, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import type { OrganError, Organs } from "../organs/Organs.ts"
import { gatherFeature, planFeature, readReadme } from "../organs/plan.ts"
import { screenRequest } from "../organs/screen.ts"
import type { Out, Printer } from "../print/organLine.ts"
import { formatDuration } from "../project/configFile.ts"
import { type FeaturePlan, filePlan, filingFailedLines, needsAnswers } from "../project/planFile.ts"
import { type Beads, beadsWhy } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import { paint } from "../ui/line.tsx"
import { FormCancelled, fileQuestion, type Plan, planLines } from "../ui/questions.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import type { Theme } from "../ui/theme.ts"
import { exitCodes } from "./holds.ts"
import { type Arg, type Line, Log, line, Tag } from "./log.ts"

/** What --feature asks for. */
export interface FeatureRequest {
  /** The request as typed or pasted. */
  readonly request: string
  /** The main checkout. */
  readonly repo: string
  /** File the plan without asking (--yes). */
  readonly yes: boolean
}

/** Where the feature run talks; `E`, how asking can fail besides being cancelled. */
export interface FeatureIO<E = never> {
  /** stdout: the organ lines, the plan and what was filed. */
  readonly printer: Printer
  /** The theme the plan is shown in. */
  readonly theme: Theme
  /** Says a line on stderr. */
  readonly error: (text: string) => Effect.Effect<void>
  /**
   * Shows the plan and asks `question` about it: true to file it. None when stdin and stdout
   * aren't a terminal to ask on.
   */
  readonly confirm: Option.Option<
    (plan: Plan, question: string) => Effect.Effect<boolean, FormCancelled | E>
  >
}

/** --feature's talk with the renderer inRenderer opens. */
export interface InRenderer<S, E> {
  /** stdout on the main screen until the renderer opens; held from then on. */
  readonly out: Out
  /** stderr on the main screen until the renderer opens; held from then on. */
  readonly error: (text: string) => Effect.Effect<void>
  /** Shows the plan and asks the question in the renderer, opening it if it isn't open. */
  readonly confirm: (plan: Plan, question: string) => Effect.Effect<boolean, FormCancelled | E>
  /** The renderer, opened the first time it is asked for. */
  readonly shell: Effect.Effect<S, E>
  /** Says what was held on the main screen, in the order it was said: once the renderer is gone. */
  readonly release: Effect.Effect<void>
}

/**
 * --feature's talk with the dashboard (§ 7.1): the organ lines and errors go to `out` and `error`
 * on the main screen until the confirmation opens the command's one renderer with `open`, and asks
 * there with `ask`. The renderer is opened once, and kept for the dashboard. What is said while it
 * is open can't go to the main screen, so it is held until `release`.
 */
export const inRenderer = <S, E>(options: {
  readonly out: Out
  readonly error: (text: string) => Effect.Effect<void>
  readonly open: Effect.Effect<S, E>
  readonly ask: (shell: S, plan: Plan, question: string) => Effect.Effect<boolean, FormCancelled>
}): InRenderer<S, E> => {
  let opened: Option.Option<S> = Option.none()
  const held: Array<{ readonly to: "out" | "error"; readonly text: string }> = []
  const shell = Effect.suspend(() =>
    Option.isSome(opened)
      ? Effect.succeed(opened.value)
      : Effect.tap(options.open, (made) =>
          Effect.sync(() => {
            opened = Option.some(made)
          }),
        ),
  )
  return {
    out: {
      ...options.out,
      write: (text) => {
        if (Option.isNone(opened)) options.out.write(text)
        else held.push({ to: "out", text })
      },
    },
    error: (text) =>
      Effect.suspend(() => {
        if (Option.isNone(opened)) return options.error(text)
        held.push({ to: "error", text })
        return Effect.void
      }),
    confirm: (plan, question) => Effect.flatMap(shell, (made) => options.ask(made, plan, question)),
    shell,
    release: Effect.suspend(() =>
      Effect.forEach(
        held.splice(0),
        (said) =>
          said.to === "out"
            ? Effect.sync(() => options.out.write(said.text))
            : options.error(said.text),
        { discard: true },
      ),
    ),
  }
}

/** How the feature run ended: its epic filed, or stopped with an exit code, having said why. */
export type FeatureOutcome = Data.TaggedEnum<{
  Filed: { readonly epic: string; readonly tickets: number }
  Stopped: { readonly exitCode: number }
}>

export const FeatureOutcome = Data.taggedEnum<FeatureOutcome>()

/** The request on one line, its white space collapsed, cut after 200 characters, for the log. */
export const featureLine = (request: string): string => {
  const words = [...request.split(/\s+/).filter(Boolean).join(" ")]
  return words.length > 200 ? `${words.slice(0, 200).join("")}…` : words.join("")
}

/** Why an organ gave no answer, on one line. */
export const organWhy = (error: OrganError): string => {
  switch (error._tag) {
    case "OrganFailed":
    case "OrganRefused":
      return sanitizeLine(error.reason.split("\n")[0] ?? error.reason)
    case "OrganTimedOut":
      return `the ${error.organ} ran past its time limit of ${formatDuration(error.timeLimit)}`
    case "OrganSkipped":
      return "the usage limit holds the run"
  }
}

/** The plan as the confirmation shows it. */
export const shownPlan = (plan: FeaturePlan): Plan => ({
  epic: plan.epic,
  tickets: plan.tickets.map((t) => ({
    key: t.key,
    type: t.type,
    priority: t.priority,
    title: t.solo ? `${t.title} (solo)` : t.title,
    files: t.files,
    after: t.blockedBy,
  })),
  notes: plan.notes,
})

const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

/** A FEATURE line of the log: `FEATURE rejected: <reason>`. */
const logLine = (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
  `${Tag.feature} ${line(strings, ...args)}` as Line

/** Stopped before filing: what is said, and the exit code. */
const nothingFiled = "tutti: stopped before filing; nothing was filed."

/**
 * Screens, plans, shows, confirms and files the feature `feature` asks for: Filed with the epic's
 * ID, which the run is then scoped to, or Stopped with the exit code, having said why. Fails as
 * the confirmation does when it fails other than by being cancelled, having filed nothing.
 */
export const planAndFile = <E = never>(
  feature: FeatureRequest,
  io: FeatureIO<E>,
): Effect.Effect<FeatureOutcome, E, Organs | Beads | Git | Log | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const log = yield* Log
    const stopped = (exitCode: number) => FeatureOutcome.Stopped({ exitCode })

    const planned = yield* Effect.gen(function* () {
      // The screen.
      const screening = yield* io.printer.organ("Screening the request with Claude…")
      const screened = yield* screenRequest({
        text: feature.request,
        repo: feature.repo.split("/").filter(Boolean).at(-1) ?? feature.repo,
        readme: yield* readReadme(feature.repo),
      }).pipe(Effect.result)
      if (Result.isFailure(screened)) {
        const why = organWhy(screened.failure)
        yield* screening.warn("Request not screened")
        yield* io.error(`tutti couldn't screen the request: ${why}`)
        yield* log.write(logLine`not screened: ${why}`)
        return stopped(exitCodes.setup)
      }
      yield* screening.done("Request screened")
      const { verdict } = screened.success
      const reason = sanitizeLine(screened.success.reason)
      if (verdict === "reject") {
        yield* io.error(`tutti won't plan this request: ${reason}`)
        yield* log.write(logLine`rejected: ${reason}`)
        return stopped(exitCodes.setup)
      }
      if (verdict === "unclear") {
        yield* io.error(`tutti can't plan this request yet: ${reason}`)
        yield* log.write(logLine`unclear: ${reason}`)
        return stopped(exitCodes.setup)
      }

      // The evidence, then the plan.
      const gathered = yield* gatherFeature(feature.repo, feature.request).pipe(Effect.result)
      if (Result.isFailure(gathered)) {
        const why = beadsWhy(gathered.failure)
        yield* io.error(`tutti couldn't plan the request: cannot read the tickets: ${why}`)
        yield* log.write(logLine`not planned: cannot read the tickets: ${why}`)
        return stopped(exitCodes.tool)
      }
      const planning = yield* io.printer.organ(
        "Planning the feature with Claude… (this can take a few minutes; Ctrl+C stops it)",
      )
      const answer = yield* planFeature(gathered.success).pipe(Effect.result)
      if (Result.isFailure(answer)) {
        const why = organWhy(answer.failure)
        yield* planning.warn("Feature not planned")
        yield* io.error(`tutti couldn't plan the request: ${why}`)
        yield* log.write(logLine`not planned: ${why}`)
        return stopped(exitCodes.setup)
      }
      const plan = answer.success
      if (needsAnswers(plan)) {
        yield* planning.warn("Planning needs answers")
        yield* io.error("tutti needs answers before it can plan this request:")
        for (const question of plan.questions) yield* io.error(`  - ${sanitizeLine(question)}`)
        yield* io.error(
          'Nothing was filed. Run it again with the answers in the request: tutti --feature "<the request, and the answers>"',
        )
        yield* log.write(logLine`needs answers: ${plural(plan.questions.length, "question")}`)
        return stopped(exitCodes.setup)
      }
      yield* planning.done("Feature planned")

      // The confirmation.
      const shown = shownPlan(plan)
      const printPlan = io.printer.print(
        ["", ...planLines(shown, io.theme).map(paint), ""].join("\n"),
      )
      if (feature.yes) {
        yield* printPlan
        return plan
      }
      if (Option.isNone(io.confirm)) {
        yield* printPlan
        yield* io.error(
          "tutti has no terminal to ask on: nothing was filed. Pass --yes to file the plan without asking.",
        )
        return stopped(exitCodes.setup)
      }
      const confirmed = yield* io.confirm.value(shown, fileQuestion(shown)).pipe(Effect.result)
      if (Result.isFailure(confirmed)) {
        if (!(confirmed.failure instanceof FormCancelled))
          return yield* Effect.fail(confirmed.failure)
        yield* io.error(nothingFiled)
        return stopped(exitCodes.interrupted)
      }
      if (!confirmed.success) {
        yield* io.printer.print("Nothing was filed.")
        yield* log.write(logLine`declined: nothing was filed`)
        return stopped(exitCodes.ok)
      }
      return plan
    }).pipe(Effect.onInterrupt(() => io.error(nothingFiled)))
    if ("_tag" in planned) return planned

    // Filing.
    yield* io.printer.print("Filing the plan with bd…")
    const filed = yield* filePlan(planned).pipe(Effect.result)
    if (Result.isFailure(filed)) {
      const failed = filed.failure
      for (const text of filingFailedLines(failed)) yield* io.error(sanitizeLine(text))
      yield* log.write(
        logLine`filing stopped at ${failed.what}, after ${failed.filed.map((issue) => issue.id).join(" ") || "nothing"}: ${failed.reason}`,
      )
      return stopped(exitCodes.tool)
    }
    const { epic } = filed.success
    const tickets = planned.tickets.length
    yield* io.printer.print(`Filed epic ${epic} with ${plural(tickets, "ticket")}`)
    yield* log.write(
      logLine`filed epic ${epic} with ${plural(tickets, "ticket")}: ${featureLine(feature.request)}`,
    )
    return FeatureOutcome.Filed({ epic, tickets })
  })

/** `effect` with AppConfig scoped to `epic`, as --ticket <epic> scopes a run. */
export const scopedTo =
  (epic: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | AppConfig> =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      return yield* Effect.provideService(effect, AppConfig, { ...config, ticket: epic })
    })
