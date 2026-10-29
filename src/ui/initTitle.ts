// tutti init's title (§ 7.1, § 7.11): the pill, `init` organ bold, the repository faint, and init's
// words under it, as its form draws them (src/ui/InitForm.tsx) and its summary prints them
// (src/print/initSummary.ts); and the scout's clock. The faint parts are `formFaint`'s.
import { homedir } from "node:os"
import { type Segments, seg } from "./line.tsx"
import { sanitizeLine } from "./sanitize.ts"
import type { Theme } from "./theme.ts"

/** `path` with the home folder as `~`. */
export const tildify = (path: string, home: string = homedir()): string =>
  home !== "" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path

/** init's title: the pill, `command` (`init`, or `checks` for tutti checks), and the repository. */
export const initTitle = (theme: Theme, repo: string, command = "init"): Segments => {
  const { title, organ } = theme.styles
  return [
    seg(" Tutti ", title),
    seg(" "),
    seg(command, organ),
    seg("  "),
    seg(sanitizeLine(tildify(repo)), theme.form.faint),
  ]
}

/** What init says under its title. */
export const initAbout = " Sets this project up for tutti, in .tutti/."

/** What the title of init's form names, and what it says under it: init's, or tutti checks'. */
export interface FormHeading {
  readonly command: string
  readonly about: string
}

export const initHeading: FormHeading = { command: "init", about: initAbout }

export const checksHeading: FormHeading = {
  command: "checks",
  about: " Sets this project's checks: the runners in scripts/ and their settings.",
}

/** How long the scout has looked, as its spinner says it: m:ss. */
export const scoutClock = (millis: number): string => {
  const seconds = Math.max(0, Math.floor(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
