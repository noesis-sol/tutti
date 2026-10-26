// What the start question's Spec file field reads of this machine (§ 5 item 3, § 7.1): a folder's
// entries, for Tab's completions and the file browser, and whether a path names a spec it can run,
// a file of text with something in it. Read as a key is pressed, as orchestra's field reads them:
// a folder or a spec is small, and the field waits on nothing else.
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Option, Result } from "effect"
import { isText } from "../run/spec.ts"
import { sanitizeLine } from "./sanitize.ts"
import type { Entry } from "./specPath.ts"

/** Why reading failed, in the words of the system's error, without the path it names. */
export const causeOf = (error: unknown): string => {
  if (!(error instanceof Error)) return "it failed"
  const code = "code" in error && typeof error.code === "string" ? error.code : null
  // Bun and Node say `EACCES: permission denied, open '/x'`; the field names the path itself.
  const words = /^[A-Z]+: (.*?)(?:, \w+(?: '.*')?)?$/s.exec(error.message)?.[1]
  return sanitizeLine(words ?? (error.message || code || "it failed"))
}

/** Whether there is a file or a folder at `path`. */
export const exists = (path: string): boolean => {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Whether `path` is a folder, or a link to one. */
export const isFolderPath = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Whether `entry`, in `folder`, is a folder or a link to one. */
const isFolder = (folder: string, entry: Dirent): boolean => {
  if (!entry.isSymbolicLink()) return entry.isDirectory()
  try {
    return statSync(join(folder, entry.name)).isDirectory()
  } catch {
    return false
  }
}

/** The entries of `folder`, or why it can't be read. */
export const readFolder = (folder: string): Result.Result<ReadonlyArray<Entry>, string> => {
  try {
    const entries = readdirSync(folder, { withFileTypes: true })
    return Result.succeed(
      entries.map((entry) => ({ name: entry.name, folder: isFolder(folder, entry) })),
    )
  } catch (error) {
    return Result.fail(causeOf(error))
  }
}

/**
 * What is wrong with the file at `path`, absolute, as a spec, named `shown` (as typed): null where
 * it is a file of text with something in it.
 */
export const fileProblem = (path: string, shown: string): string | null => {
  const named = sanitizeLine(shown)
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(path)
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null
    return code === "ENOENT" || code === "ENOTDIR"
      ? `no such file: ${named}`
      : `cannot read ${named}: ${causeOf(error)}`
  }
  if (info.isDirectory()) return `${named} is a folder`
  // A device or a pipe, whose reading might never end.
  if (!info.isFile()) return `${named} isn't a file`
  let bytes: Uint8Array
  try {
    bytes = readFileSync(path)
  } catch (error) {
    return `cannot read ${named}: ${causeOf(error)}`
  }
  const text = isText(bytes)
  if (Option.isNone(text)) return `${named} doesn't look like text`
  if (text.value.trim() === "") return `${named} is empty`
  return null
}
