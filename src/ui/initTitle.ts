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

/** init's title: the pill, `init`, and the repository it sets up. */
export const initTitle = (theme: Theme, repo: string): Segments => {
  const { title, organ } = theme.styles
  return [
    seg(" Tutti ", title),
    seg(" "),
    seg("init", organ),
    seg("  "),
    seg(sanitizeLine(tildify(repo)), theme.form.faint),
  ]
}

/** What init says under its title. */
export const initAbout = " Sets this project up for tutti, in .tutti/."

/** How long the scout has looked, as its spinner says it: m:ss. */
export const scoutClock = (millis: number): string => {
  const seconds = Math.max(0, Math.floor(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
