// git's local environment variables: those that name a repository, its work tree, index or object
// store, or add config, for the git that reads them. tutti started from a git hook, a
// `rebase --exec`, or a shell that exports GIT_DIR (a dotfiles setup) has them, and every git command,
// check and worker it starts would then act on that repository whatever folder it runs in: a rebase
// in a worktree would rebase main (tutti-m6hh). exec and workerEnv leave them out, as git itself does
// for a command it runs in a submodule.

/**
 * What `git rev-parse --local-env-vars` prints (git 2.39 to 2.51). GIT_CONFIG_COUNT stands for the
 * GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> it counts, which git reads only through it.
 */
export const gitLocalVariables: ReadonlySet<string> = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
])

/** Whether `name` is one of git's local environment variables (gitLocalVariables). */
export const gitLocalVariable = (name: string): boolean => gitLocalVariables.has(name)

/**
 * `env`'s set variables but git's local ones, with `more` laid over them: the environment of a
 * command tutti runs, from tutti's own.
 */
export const withoutGitLocal = (
  env: Readonly<Record<string, string | undefined>>,
  more: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !gitLocalVariable(name)) result[name] = value
  }
  return Object.assign(result, more)
}
