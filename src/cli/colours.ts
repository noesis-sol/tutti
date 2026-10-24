// tutti colours [<name>] (§ 7.11, § 8.1): previews a colour scheme without a run, the one in use
// by default. It lists every role with where its colour comes from (the file, or the scheme it
// extends) and a sample in the light and the dark variant; then a mock card, ticket row,
// attention card and hint in the terminal's own variant, drawn by the dashboard's own lines and
// printed in the theme's ANSI styles; then anything that keeps the scheme from being used. Such a
// problem fails the command, so that a scheme can be checked in CI.
import { Console, Effect } from "effect"
import type { AttentionRequest } from "../agent/Attention.ts"
import { WorkerState } from "../agent/WorkerState.ts"
import { Finished, TicketPhase } from "../run/phase.ts"
import { type Card, type Key, type Row, rowStatus, shownRequest } from "../run/runView.ts"
import { Tty } from "../services/Tty.ts"
import { attentionLines } from "../ui/AttentionCard.tsx"
import { defaultFocus } from "../ui/attentionKeys.ts"
import { cardLines, contentOf } from "../ui/Card.tsx"
import { hintSegments } from "../ui/Hint.tsx"
import { paint, type Segments, seg } from "../ui/line.tsx"
import { sanitizeLine } from "../ui/sanitize.ts"
import { ticketsLines } from "../ui/TicketsTable.tsx"
import {
  type Appearance,
  appearanceOf,
  backgroundRoles,
  type Colour,
  type ColourDepth,
  type LoadedScheme,
  makeTheme,
  outputAppearance,
  type Role,
  roles,
  type Theme,
} from "../ui/theme.ts"
import { AppConfig } from "./AppConfig.ts"

/** What the preview is drawn from. */
export interface Preview {
  /** The scheme asked for: the name given, else the one in use by default. */
  readonly asked: string
  /** The scheme loaded for it: that one, or orchestra with the reason it isn't used. */
  readonly loaded: LoadedScheme
  /** The terminal's own variant, which the mock is drawn in. */
  readonly appearance: Appearance
  readonly depth: ColourDepth
  readonly noColor: boolean
  /** The columns the mock may take. */
  readonly width: number
  /** The time the mock's elapsed times count to, epoch milliseconds. */
  readonly now: number
}

/** The widest the mock is drawn. */
const mockWidth = 72

/** A colour as a scheme writes it. */
export const colourText = (colour: Colour): string => {
  switch (colour._tag) {
    case "Hex":
      return colour.hex
    case "Slot":
      return `ansi:${colour.slot}`
    case "Default":
      return "default"
  }
}

/** The role table's columns: the role, where it comes from, and each variant's sample. */
const roleWidth = Math.max(...roles.map((role) => role.length))

/** A role's sample: its colour drawn, as text or behind it, and its value as written. */
const sample = (role: Role, theme: Theme): string => {
  const colour = theme.scheme.colours[role][theme.appearance]
  const swatch = backgroundRoles.has(role)
    ? `${theme.ansi(role, "bg")}  `
    : `${theme.ansi(role, "fg")}██`
  const drawn = theme.noColor ? "██" : `${swatch}\x1b[0m`
  return `${drawn} ${colourText(colour).padEnd(9)}`
}

/** The role table: a header row, then every role with its source and both samples. */
const roleLines = (preview: Preview): ReadonlyArray<string> => {
  const { scheme } = preview.loaded
  const options = { depth: preview.depth, noColor: preview.noColor }
  const light = makeTheme(scheme, { ...options, appearance: "light" })
  const dark = makeTheme(scheme, { ...options, appearance: "dark" })
  const fromWidth = Math.max(4, ...roles.map((role) => scheme.from[role].length))
  const dim = light.styles.dim.paint
  const header = `  ${"Role".padEnd(roleWidth)}  ${"From".padEnd(fromWidth)}  ${"Light".padEnd(12)}  Dark`
  return [
    dim(header),
    ...roles.map((role) =>
      `  ${role.padEnd(roleWidth)}  ${scheme.from[role].padEnd(fromWidth)}  ${sample(role, light)}  ${sample(role, dark)}`.trimEnd(),
    ),
  ]
}

const began = (now: number, millis: number) => now - millis

/** The mock's worker card: a worker editing, its latest action under its title. */
const workingCard = (now: number): Card => ({
  ticket: "tut-12",
  label: "tut-12",
  title: "Retry a merge that lost the race",
  worker: 1,
  phase: TicketPhase.Working({ activity: "editing" }),
  state: WorkerState.Working({ doing: "editing" }),
  status: "editing",
  tone: "picked",
  motion: "spinner",
  since: began(now, 391_000),
  action: null,
  latest: { text: "Edit src/run/merge.ts", denied: false },
  steered: false,
  requests: [],
})

/** The mock's attention card's request: a command waiting for permission. */
const permission = (now: number): AttentionRequest => ({
  id: "r1",
  ticket: "tut-14",
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  displayName: "Bash",
  description: "Remove the build cache",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began(now, 42_000),
})

/** The mock's attention card: a worker waiting for you to allow a command. */
const attentionCard = (now: number): Card => ({
  ticket: "tut-14",
  label: "tut-14",
  title: "Clear the build cache between checks",
  worker: 2,
  phase: TicketPhase.Working({ activity: "allow" }),
  state: WorkerState.NeedsYou({ requests: 1 }),
  status: "permission — waiting for you",
  tone: "stop",
  motion: "spinner",
  since: began(now, 42_000),
  action: null,
  latest: null,
  steered: false,
  requests: [shownRequest(permission(now))],
})

/** The mock's ticket rows, one in each of a few states. */
const rows: ReadonlyArray<Row> = [
  {
    ticket: "tut-9",
    label: "tut-9",
    ...rowStatus(TicketPhase.Done({ outcome: Finished.Merged({ commit: "" }) })),
    title: "",
    note: "merged in 4m12s",
    verdict: null,
  },
  {
    ticket: "tut-12",
    label: "tut-12",
    ...rowStatus(TicketPhase.Working({ activity: "editing" })),
    title: "",
    note: "Retry a merge that lost the race",
    verdict: null,
  },
  {
    ticket: "tut-13",
    label: "tut-13",
    ...rowStatus(TicketPhase.ToMerge({ place: 1 })),
    title: "",
    note: "Tidy the log",
    verdict: null,
  },
  {
    ticket: "tut-14",
    label: "tut-14",
    ...rowStatus(TicketPhase.Working({ activity: "allow" })),
    title: "",
    note: "Clear the build cache between checks",
    verdict: null,
  },
]

const hintKeys: ReadonlyArray<Key> = [
  { keys: "Tab", does: "select" },
  { keys: "Enter", does: "open" },
  { keys: "a", does: "allow" },
  { keys: "d", does: "deny" },
  { keys: "q", does: "stop" },
]

/** The mock, in `theme`: the Current section's cards, the tickets table, the hint. */
const mockLines = (theme: Theme, width: number, now: number): ReadonlyArray<string> => {
  const { styles } = theme
  const spin = "⣾"
  const working = workingCard(now)
  const waiting = attentionCard(now)
  const lines: ReadonlyArray<Segments> = [
    [seg("  "), seg("Current", styles.picked)],
    ...cardLines(working, theme, { now, spin, width, inside: 3, highlighted: false }),
    ...attentionLines(waiting, theme, contentOf(waiting, theme, now, spin).slice(0, 2), {
      width,
      highlighted: false,
      focus: defaultFocus(permission(now)),
    }),
    [],
    ...ticketsLines(rows, theme, width, { fill: false }),
    [],
    hintSegments(hintKeys, theme, width),
  ]
  return lines.map(paint)
}

/** The preview's lines: the scheme, its roles, the mock, then what keeps it from being used. */
export const previewLines = (preview: Preview): ReadonlyArray<string> => {
  const { loaded, asked } = preview
  const { scheme } = loaded
  const theme = makeTheme(scheme, {
    appearance: preview.appearance,
    depth: preview.depth,
    noColor: preview.noColor,
  })
  const { styles } = theme
  const name = sanitizeLine(scheme.name)
  const heading =
    loaded.fallback === null
      ? `Colour scheme ${styles.tickets.paint(name)}`
      : `Colour scheme ${styles.tickets.paint(name)}, used instead of '${sanitizeLine(asked)}'`
  const width = Math.max(Math.min(preview.width, mockWidth), 20)
  return [
    heading,
    ...(scheme.description === null ? [] : [styles.dim.paint(sanitizeLine(scheme.description))]),
    ...(preview.noColor
      ? [styles.dim.paint("NO_COLOR is set: every role is drawn in the terminal's default colour.")]
      : []),
    "",
    ...roleLines(preview),
    "",
    `In the terminal's ${preview.appearance} variant:`,
    "",
    ...mockLines(theme, width, preview.now),
    "",
    ...loaded.warnings.map((warning) => styles.deferred.paint(` ! ${sanitizeLine(warning)}`)),
    ...(loaded.fallback === null ? [`${styles.closed.paint("✓")} ${name} can be used.`] : []),
  ]
}

/**
 * `tutti colours`: previews the scheme AppConfig loaded, in the terminal's variant, and fails
 * with the reason the scheme asked for can't be used, if it can't.
 */
export const colours: Effect.Effect<void, string, AppConfig | Tty> = Effect.gen(function* () {
  const config = yield* AppConfig
  const tty = yield* Tty
  // A dumb terminal isn't asked for its background.
  const appearance = tty.dumb
    ? appearanceOf(config.appearance, null)
    : yield* outputAppearance(config.appearance, null)
  const size = yield* tty.size
  const lines = previewLines({
    asked: config.colourScheme,
    loaded: config.scheme,
    appearance,
    depth: tty.colourDepth === "truecolor" ? "truecolor" : "256",
    noColor: config.noColor,
    width: size.columns,
    now: Date.now(),
  })
  yield* Console.log(lines.join("\n"))
  if (config.scheme.fallback !== null) return yield* Effect.fail(config.scheme.fallback)
})
