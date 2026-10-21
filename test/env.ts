// The tests' way to their environment and PATH (§ 13). scripts/test.ts runs the suites in one of
// their own, the same on every machine: a PATH without the tools tutti looks for (claude, bd, tmux,
// herdr, …; hiddenTools) and without the terminal's or a Claude Code session's variables. Biome's
// rules hold the tests outside test/contract/ to this file (biome.json, test/lint/), so none reads
// process.env or Bun.which where it could find a machine's tool and pass only there.

/** The tests' environment, which a process a test starts is given with its own variables. */
export const testEnv: Readonly<Record<string, string | undefined>> = process.env

/**
 * Where a command is on the tests' PATH, or on `path` when given, or null: on the tests' PATH, never
 * one of scripts/test.ts's hiddenTools that a test didn't put there.
 */
export const which = (command: string, path?: string): string | null =>
  path === undefined ? Bun.which(command) : Bun.which(command, { PATH: path })

/**
 * Where one of the machine's tools is, on the PATH scripts/test.ts was started with, or null: for a
 * slow or live test that runs the real tool on purpose, such as bd.
 */
export const machineWhich = (command: string): string | null =>
  which(command, testEnv.TUTTI_TEST_MACHINE_PATH ?? testEnv.PATH ?? "")

/**
 * Sets `name` in the tests' environment (unset for undefined) while `body` runs, and its promise if
 * it returns one, and then puts it back: for code under test that reads process.env itself.
 */
export const withVariable = <A>(name: string, value: string | undefined, body: () => A): A => {
  const before = process.env[name]
  const set = (to: string | undefined) => {
    if (to === undefined) delete process.env[name]
    else process.env[name] = to
  }
  set(value)
  let result: A
  try {
    result = body()
  } catch (error) {
    set(before)
    throw error
  }
  if (result instanceof Promise) return result.finally(() => set(before)) as A
  set(before)
  return result
}
