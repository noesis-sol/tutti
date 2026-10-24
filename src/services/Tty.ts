// The Tty service (§ 3.3, § 7.6, § 7.7): what tutti knows of the terminal it runs in. Whether
// stdin and stdout are TTYs, `TERM=dumb`, `NO_COLOR`, the terminal's size, and its colour depth,
// read from `$COLORTERM` and `$TERM` alone: over ssh nothing else is trusted, so
// `COLORTERM=truecolor` is what the documentation tells people to set. Also the notification
// sequence the terminal shows (§ 7.9), whether tutti runs inside tmux, and whether over ssh. The
// terminals tutti knows are one table, `terminals`: adding one is a row.
//
// It also decides the output mode. Plain log lines (§ 7.6) when stdin or stdout isn't a TTY, with
// `TERM=dumb`, with `--plain`, or on a terminal reporting fewer than 256 colours: OpenTUI has no
// 16-colour fallback (#852). The dashboard otherwise. A plain mode carries its reason, for the
// line saying why. Named so as not to clash with Effect's `Terminal`.
import { Context, Effect, Layer } from "effect"

/** How many colours the terminal draws: exact RGB, the 256 of xterm, or fewer. */
export type ColourDepth = "truecolor" | "256" | "fewer"

/** The terminal's size in cells. */
export interface Size {
  readonly columns: number
  readonly rows: number
}

/** The size assumed when the terminal doesn't say one: stdout isn't a TTY, say. */
export const defaultSize: Size = { columns: 80, rows: 24 }

/** What the environment says of the terminal. */
export interface TtyValue {
  readonly stdinIsTty: boolean
  readonly stdoutIsTty: boolean
  /** `TERM=dumb`. */
  readonly dumb: boolean
  /** `NO_COLOR` is set and not empty: every colour role is the default colour (§ 7.11). */
  readonly noColor: boolean
  /** `$TERM`, or undefined when it is unset or empty. */
  readonly term: string | undefined
  readonly colourDepth: ColourDepth
  /** The notification sequence the terminal shows, or undefined for one not known to show one. */
  readonly osc: Osc | undefined
  /** Inside tmux (`$TMUX`): a sequence for the terminal outside it is wrapped to pass through. */
  readonly tmux: boolean
  /** Over ssh: the desktop's commands would act on the remote machine, not the person's. */
  readonly overSsh: boolean
  /** The terminal's size now; it changes as the window does. */
  readonly size: Effect.Effect<Size>
}

export class Tty extends Context.Service<Tty, TtyValue>()("tutti/services/Tty") {}

/** The variables a colour depth is read from. */
export interface ColourVariables {
  readonly COLORTERM?: string | undefined
  readonly TERM?: string | undefined
}

/** The terminal's notification sequence: iTerm2's OSC 9, or rxvt's OSC 777 with a title. */
export type Osc = "9" | "777"

/**
 * A terminal tutti knows, and how it is recognised. TERM and LC_TERMINAL reach an ssh session
 * (iTerm2 sets LC_TERMINAL, which ssh sends with the other LC_ variables); TERM_PROGRAM and the
 * terminals' own variables tell a local one, and inside tmux, whose TERM_PROGRAM and TERM are its
 * own, they are what is left.
 */
export interface KnownTerminal {
  readonly name: string
  /** The `$TERM`s naming it, in lower case; one ending in `*` names every TERM starting so. */
  readonly term?: ReadonlyArray<string>
  /** The `$TERM_PROGRAM`s it sets, in lower case. */
  readonly program?: ReadonlyArray<string>
  /** Variables it sets: `NAME` set and not empty, or `NAME=value` exactly. */
  readonly envVar?: ReadonlyArray<string>
  /** The notification sequence it shows, if it shows one. */
  readonly osc?: Osc
  /**
   * Whether it draws RGB though it may not set COLORTERM, as over ssh: a TERM naming it is
   * truecolor. Only its TERM counts, as only COLORTERM and TERM are trusted for colour depth.
   */
  readonly truecolor: boolean
}

/** The terminals tutti knows: where the environment tells two, the earlier row's sequence is used. */
export const terminals: ReadonlyArray<KnownTerminal> = [
  {
    name: "iTerm2",
    program: ["iterm.app"],
    envVar: ["LC_TERMINAL=iTerm2", "ITERM_SESSION_ID"],
    osc: "9",
    truecolor: true,
  },
  { name: "kitty", term: ["xterm-kitty"], envVar: ["KITTY_WINDOW_ID"], osc: "9", truecolor: true },
  {
    name: "Ghostty",
    term: ["xterm-ghostty"],
    program: ["ghostty"],
    envVar: ["GHOSTTY_RESOURCES_DIR"],
    osc: "777",
    truecolor: true,
  },
  {
    name: "WezTerm",
    term: ["wezterm"],
    program: ["wezterm"],
    envVar: ["WEZTERM_PANE"],
    osc: "777",
    truecolor: true,
  },
  { name: "foot", term: ["foot", "foot-*"], osc: "777", truecolor: true },
  { name: "Alacritty", term: ["alacritty"], truecolor: true },
  { name: "Contour", term: ["contour"], truecolor: true },
]

/** What the environment says: a variable's value, or undefined where it is unset. */
export type Env = (name: string) => string | undefined

const set = (env: Env, name: string): boolean => {
  const value = env(name)
  return value !== undefined && value !== ""
}

/** `$TERM` as the table holds it: trimmed, in lower case, empty where it is unset. */
const normalTerm = (term: string | undefined): string => (term ?? "").trim().toLowerCase()

/** Whether `term`, normalised, names `terminal`. */
const namedBy = (terminal: KnownTerminal, term: string): boolean =>
  term !== "" &&
  (terminal.term ?? []).some((each) =>
    each.endsWith("*") ? term.startsWith(each.slice(0, -1)) : term === each,
  )

/** Whether the environment tells `terminal`: by its TERM, its TERM_PROGRAM or its own variable. */
const matches = (terminal: KnownTerminal, env: Env): boolean => {
  if (namedBy(terminal, normalTerm(env("TERM")))) return true
  const program = (env("TERM_PROGRAM") ?? "").toLowerCase()
  if (program !== "" && (terminal.program ?? []).includes(program)) return true
  return (terminal.envVar ?? []).some((each) => {
    const at = each.indexOf("=")
    return at === -1 ? set(env, each) : env(each.slice(0, at)) === each.slice(at + 1)
  })
}

/** The notification sequence the terminal shows: undefined for one not known to show either. */
export const oscOf = (env: Env): Osc | undefined =>
  terminals.find((terminal) => terminal.osc !== undefined && matches(terminal, env))?.osc

/** Whether the session is over ssh: sshd sets these for the session's processes. */
export const overSshOf = (env: Env): boolean =>
  set(env, "SSH_CONNECTION") || set(env, "SSH_CLIENT") || set(env, "SSH_TTY")

/**
 * The colour depth `$COLORTERM` and `$TERM` report. `COLORTERM=truecolor` or `24bit` is
 * truecolor whatever TERM says, as tmux and screen pass it through under a TERM of their own.
 * Otherwise TERM decides: a `-direct` or `-truecolor` terminfo entry, or a terminal `terminals`
 * says draws RGB, is truecolor; one naming 256 colours (`xterm-256color`, `tmux-256color`,
 * `screen-256color`) is 256; anything else (`xterm`, `screen`, `tmux`, `linux`, `dumb`, no TERM)
 * is fewer.
 */
export const colourDepthOf = (variables: ColourVariables): ColourDepth => {
  const colorterm = (variables.COLORTERM ?? "").trim().toLowerCase()
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor"
  const term = normalTerm(variables.TERM)
  if (term === "dumb") return "fewer"
  if (terminals.some((terminal) => terminal.truecolor && namedBy(terminal, term))) {
    return "truecolor"
  }
  if (/-(direct|truecolor|24bit)$/.test(term)) return "truecolor"
  if (/(^|-)256colou?r(-|$)/.test(term)) return "256"
  return "fewer"
}

/** Why the output is plain, in the order they are tested. */
export type PlainReason = "flag" | "stdinNotTty" | "stdoutNotTty" | "dumb" | "fewerColours"

/** The output mode: the dashboard, or plain log lines and why (§ 7.6). */
export type OutputMode =
  | { readonly _tag: "Dashboard" }
  | { readonly _tag: "Plain"; readonly reason: PlainReason }

/**
 * The output mode for the terminal `tty`, `plain` being `--plain` (or `TUTTI_PLAIN`). Plain when
 * asked for, when stdin or stdout isn't a TTY, with `TERM=dumb`, or with fewer than 256 colours;
 * the dashboard otherwise.
 */
export const outputMode = (
  tty: Pick<TtyValue, "stdinIsTty" | "stdoutIsTty" | "dumb" | "colourDepth">,
  plain: boolean,
): OutputMode => {
  const reason: PlainReason | undefined = plain
    ? "flag"
    : !tty.stdinIsTty
      ? "stdinNotTty"
      : !tty.stdoutIsTty
        ? "stdoutNotTty"
        : tty.dumb
          ? "dumb"
          : tty.colourDepth === "fewer"
            ? "fewerColours"
            : undefined
  return reason === undefined ? { _tag: "Dashboard" } : { _tag: "Plain", reason }
}

/**
 * The line saying why the output is plain, for a reason the person didn't choose; undefined for
 * `--plain`. `term` names the TERM a too-few-colours terminal reports.
 */
export const plainReasonLine = (reason: PlainReason, term?: string): string | undefined => {
  switch (reason) {
    case "flag":
      return undefined
    case "stdinNotTty":
      return "Plain output: stdin isn't a terminal."
    case "stdoutNotTty":
      return "Plain output: stdout isn't a terminal."
    case "dumb":
      return "Plain output: TERM is dumb."
    case "fewerColours":
      return `Plain output: the terminal reports fewer than 256 colours (TERM=${
        term ?? "unset"
      }); the dashboard needs 256 or more. Set COLORTERM=truecolor, or a 256-colour TERM such as xterm-256color, if it has them.`
  }
}

/** The Tty a process with these streams and this environment has. */
export const fromEnvironment = (input: {
  readonly stdinIsTty: boolean
  readonly stdoutIsTty: boolean
  readonly env: Env
  readonly size: Effect.Effect<Size>
}): TtyValue => {
  const variable = (name: string) => {
    const value = input.env(name)
    return value === undefined || value === "" ? undefined : value
  }
  const term = variable("TERM")
  return {
    stdinIsTty: input.stdinIsTty,
    stdoutIsTty: input.stdoutIsTty,
    dumb: term === "dumb",
    noColor: variable("NO_COLOR") !== undefined,
    term,
    colourDepth: colourDepthOf({ COLORTERM: variable("COLORTERM"), TERM: term }),
    osc: oscOf(input.env),
    tmux: variable("TMUX") !== undefined,
    overSsh: overSshOf(input.env),
    size: input.size,
  }
}

/** The live layer: this process's stdin, stdout and environment, read once at startup. */
export const layer = Layer.sync(Tty, () =>
  fromEnvironment({
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    env: (name) => process.env[name],
    size: Effect.sync(() => {
      const { columns, rows } = process.stdout
      return columns > 0 && rows > 0 ? { columns, rows } : defaultSize
    }),
  }),
)
