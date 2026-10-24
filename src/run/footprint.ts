// Footprints (§ 5 item 5, § 2): where a ticket works, as orchestra v0.9.0 reads it. The files and
// functions its title, description, design and acceptance criteria name, its area:<name> labels and
// the files its `files` metadata lists (folders and globs among them), resolved against git
// ls-files, and the globs it lists, which hold the files other tickets add where they match; with
// none of these, its `predicted_files`. Not its notes: they say what happened to it
// (the run's notes, its workers', a reopening's), naming files and functions it doesn't change. The
// files the project's check commands name are left out unless the metadata lists them, as is the
// spec the ticket's `spec` metadata cites: nearly every ticket asks for the check to pass, and cites
// its spec, without changing them. The files git merges by union (`merge=union` in .gitattributes,
// as tutti init offers for the changelog) are left out always: two tickets' lines in one can't
// conflict, git keeps both. A ticket with commits on its branch (reopened, carried over) is
// footprinted from what its branch changes, its files metadata and its area labels
// (`branchFootprint`). A running ticket's footprint also grows with the files its worktree has
// changed (§ 5). Two tickets whose footprints overlap don't run side by side; a file both name holds
// them apart only when one of them is to change it (`sharedFile`).
//
// The text is read with text.ts's heuristics, the names resolved with repoFiles.ts, the globs
// matched with glob.ts; whether two footprints overlap is overlap.ts's.
import { Effect } from "effect"
import type { Issue } from "../services/Beads.ts"
import { Git, type GitError } from "../services/Git.ts"
import { extensionOf, isDocument, type RepoFiles, repoPath, sorted } from "./repoFiles.ts"
import {
  asksChange,
  callsIn,
  codeSpansIn,
  eachPathToken,
  sentences,
  sourceExtensions,
  typeMethod,
} from "./text.ts"

export interface Footprint {
  /**
   * Paths in the repository, sorted. A folder the files metadata lists is kept as one, ending in /,
   * beside the tracked files under it: it holds the files under it, those another ticket adds there
   * included, and is all there is of a folder the ticket adds.
   */
  readonly files: ReadonlyArray<string>
  /**
   * The globs the files metadata lists, sorted, cleaned and in NFC: one that matches none of the
   * repository's files (any, the files unknown) as it is (web/src/*.ts, listed before there is any),
   * one that matches some anchored at each folder it matched in (run/*.ts as src/run/*.ts), beside
   * those files in `files`. Each holds the files and folders other footprints name that it would
   * match from the repository's root (`globHolds`): those another ticket adds there.
   */
  readonly globs: ReadonlyArray<string>
  /** Functions and types, as named: Loop.merge, refreshBranch. Sorted. */
  readonly funcs: ReadonlyArray<string>
  /** The ticket's area:<name> labels, sorted. */
  readonly areas: ReadonlyArray<string>
  /**
   * The files among `files` the ticket names only to read, sorted: those its text names when its
   * files metadata lists others (the files it changes), and, without files metadata, a document
   * (.md, .txt) its text names in no sentence asking to change it, as tickets cite the project's
   * guides and spikes for conventions and findings.
   */
  readonly cited: ReadonlyArray<string>
  /** The files metadata lists the files the ticket changes: a function it names changes no other. */
  readonly listed: boolean
  /** `files` are the predictor's guess, for a ticket naming nothing. */
  readonly predicted: boolean
  /** `files` are those the ticket's branch changes, with those its metadata lists (`branchFootprint`). */
  readonly branch: boolean
  /** The files the ticket's worktree has changed, sorted (`withChanges`). */
  readonly changed: ReadonlyArray<string>
}

/** What a footprint is read from: an Issue, or as much of one. */
export type FootprintTicket = Pick<
  Issue,
  | "title"
  | "description"
  | "design"
  | "acceptance"
  | "labels"
  | "metadata"
  | "files"
  | "predictedFiles"
>

/** Starts a label naming the part of the project a ticket works on: tickets sharing one overlap. */
export const AreaPrefix = "area:"

/** The metadata key naming the spec a ticket was broken down from (§ 11). */
export const SpecKey = "spec"

/** The footprint of a ticket naming nothing. */
export const emptyFootprint: Footprint = {
  files: [],
  globs: [],
  funcs: [],
  areas: [],
  cited: [],
  listed: false,
  predicted: false,
  branch: false,
  changed: [],
}

/** Whether the footprint names nothing (its worktree's changes aside). */
export const isEmpty = (fp: Footprint): boolean =>
  fp.files.length + fp.globs.length + fp.funcs.length + fp.areas.length === 0

/**
 * The footprint for the log: functions, files, globs, then areas (`<id> footprint: …`). A glob
 * written as a file or folder among the files (a route the ticket adds, pages/[slug].tsx) is
 * named once.
 */
export const showFootprint = (fp: Footprint): string =>
  isEmpty(fp)
    ? "nothing named"
    : [
        ...fp.funcs,
        ...fp.files,
        ...fp.globs.filter((g) => !fp.files.includes(g) && !fp.files.includes(`${g}/`)),
        ...fp.areas,
      ].join(", ") +
      (fp.predicted ? " (predicted)" : "") +
      (fp.branch ? " (from its branch)" : "")

/** The spec the ticket's metadata cites, as the repository's files: left out unless listed. */
const specFiles = (ticket: FootprintTicket, repo: RepoFiles): ReadonlySet<string> => {
  const spec = Object.hasOwn(ticket.metadata, SpecKey) ? ticket.metadata[SpecKey] : undefined
  return new Set(typeof spec === "string" ? repo.resolve(spec, false) : [])
}

/**
 * The repository files the words of text that may be paths name, but those named in passing, each
 * with whether text asks to change it: any file but a document, and a document a sentence asks to
 * change (asksChange); and the Type.method words among them that name no file.
 */
const pathsIn = (
  text: string,
  repo: RepoFiles,
  inPassing: (file: string) => boolean,
): { readonly files: Map<string, boolean>; readonly funcs: Set<string> } => {
  const files = new Map<string, boolean>()
  const funcs = new Set<string>()
  for (const sentence of sentences(text)) {
    // A path token holds no space, so each is in one word, and starts it as it would the text.
    const words = sentence.split(/\s+/).filter(Boolean)
    words.forEach((word, i) => {
      eachPathToken(
        word,
        (token) => {
          const found = repo.resolve(token, false)
          if (found.length > 0) {
            for (const f of found) {
              if (inPassing(f)) continue // "scripts/check.sh passes" says nothing of where a ticket works
              files.set(f, files.get(f) === true || !isDocument(f) || asksChange(words, i))
            }
            return true
          }
          if (typeMethod.test(token) && !sourceExtensions.has(extensionOf(token))) {
            funcs.add(token)
            return true
          }
          return false
        },
        repo.bare,
      )
    })
  }
  return { files, funcs }
}

/** The ticket's area:<name> labels, sorted. */
const areasOf = (ticket: Pick<FootprintTicket, "labels">): ReadonlyArray<string> =>
  sorted(ticket.labels.filter((l) => l.startsWith(AreaPrefix) && l.length > AreaPrefix.length))

/**
 * Where the ticket works: the files and functions named in its title and text, its area labels and
 * the files its metadata lists; with none of these, the files predicted for it (`predicted_files`).
 *
 * - **Text** is the title, description, design and acceptance criteria, not the notes. It names a
 *   file by its path (`src/run/ledger.ts:120`), its base name (`ledger.ts`, every file of that
 *   name) or a partial path (`run/ledger.ts`), and a new file by its path in a folder that exists.
 *   A file without an extension it names by its path (`scripts/release`), or by its base name in
 *   backticks or capitalised (`` `tutti` ``, `Makefile`), only when the repository's files are known.
 *   A path keeps its brackets and a + starting a name (`src/routes/[slug]/+page.svelte`).
 *   Functions are `Type.method`, a call (`refreshBranch()`, not `len(x)`, `os.Exit()` or
 *   `t.Run()`), or a camel-case name in backticks (`waitSettled`, not `GitHub`). Text names no
 *   folder or glob.
 * - **The files metadata** also takes a folder (`src/run/`, or `run/`), meaning the files under it
 *   and, kept as `src/run/`, those another ticket adds there, and a glob (`*.ts`, `src/**\/*.ts`)
 *   meaning the files it matches and, kept in `globs`, those another ticket adds where it matches
 *   or, matching none, would match from the root (`repo.listed`). A name with a [ (pages/[id].tsx)
 *   is also that file or folder. A name that means none of these is a file or folder the ticket adds.
 * - **Cited**: with files metadata, the files its text names are those it reads; without, so is a
 *   document its text names in no sentence asking to change it (`per CLAUDE.md`, not
 *   `Update docs/guide.md`). A file cited holds no other ticket apart from it (`sharedFile`).
 * - **Left out**: names outside the repository (`../x.ts`, `/etc/passwd`), the files git merges by
 *   union, and the files the check commands name and the spec the `spec` metadata cites, unless
 *   the files metadata lists them.
 */
export const ticketFootprint = (ticket: FootprintTicket, repo: RepoFiles): Footprint => {
  const text = [ticket.title, ticket.description, ticket.design, ticket.acceptance].join("\n")
  const spec = specFiles(ticket, repo)
  const inPassing = (f: string) => repo.checks(f) || spec.has(f)
  const { files, funcs } = pathsIn(text, repo, inPassing)
  for (const f of callsIn(text)) funcs.add(f)
  for (const f of codeSpansIn(text)) funcs.add(f)
  const listed = ticket.files.length > 0
  // The files it changes are listed: those its text names it reads.
  if (listed) for (const f of files.keys()) files.set(f, false)
  const globs = new Set<string>()
  for (const name of ticket.files) {
    const entry = repo.listed(name)
    for (const f of entry.files) files.set(f, true)
    for (const g of entry.globs) globs.add(g)
  }
  for (const f of [...files.keys()]) if (repo.unioned(f)) files.delete(f)
  const fp: Footprint = {
    ...emptyFootprint,
    files: sorted(files.keys()),
    globs: sorted(globs),
    funcs: sorted(funcs),
    areas: areasOf(ticket),
    cited: sorted([...files].filter(([, change]) => !change).map(([f]) => f)),
    listed,
  }
  if (!isEmpty(fp)) return fp
  const predicted = new Set<string>()
  for (const name of ticket.predictedFiles) {
    for (const f of repo.resolve(name, false)) {
      if (!inPassing(f) && !repo.unioned(f)) predicted.add(f)
    }
  }
  return { ...emptyFootprint, files: sorted(predicted), predicted: predicted.size > 0 }
}

/**
 * The footprint of a ticket whose branch changes `changed` on top of the base (reopened, or
 * carried over): it has done its work there, and its text names what it read and was told as
 * well. Those files and the ones its files metadata lists, all to be changed, and its area labels;
 * not what its text names. The files git merges by union are left out; those the check commands
 * name and its spec are kept: the branch changes them.
 */
export const branchFootprint = (
  ticket: Pick<FootprintTicket, "files" | "labels">,
  changed: ReadonlyArray<string>,
  repo: RepoFiles,
): Footprint => {
  const files = new Set(changed.filter(repoPath).map((f) => repo.file(f)))
  const globs = new Set<string>()
  for (const name of ticket.files) {
    const entry = repo.listed(name)
    for (const f of entry.files) files.add(f)
    for (const g of entry.globs) globs.add(g)
  }
  return {
    ...emptyFootprint,
    files: sorted([...files].filter((f) => !repo.unioned(f))),
    globs: sorted(globs),
    areas: areasOf(ticket),
    listed: true,
    branch: true,
  }
}

/**
 * The footprint grown by the files its ticket's worktree has changed (`worktreeChanges`), in the
 * form the repository's files are in, so they compare with those other tickets name; but those git
 * merges by union.
 */
export const withChanges = (
  fp: Footprint,
  changed: ReadonlyArray<string>,
  repo: RepoFiles,
): Footprint => ({
  ...fp,
  changed: sorted([
    ...fp.changed,
    ...changed
      .filter(repoPath)
      .map((f) => repo.file(f))
      .filter((f) => !repo.unioned(f)),
  ]),
})

/**
 * The files the worktree has changed since it left base: those its commits changed (`git diff
 * --name-only <base>...HEAD`) and those changed or added and not committed (`git status`).
 */
export const worktreeChanges = (
  worktree: string,
  base: string,
): Effect.Effect<ReadonlyArray<string>, GitError, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const committed = yield* git.changedFiles(worktree, base)
    const status = yield* git.status(worktree)
    return sorted([
      ...committed,
      ...status.flatMap((entry) =>
        entry.from === undefined ? [entry.path] : [entry.path, entry.from],
      ),
    ])
  })
