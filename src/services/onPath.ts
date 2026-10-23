// Finding a command on the PATH tutti runs commands with.

/**
 * Where `command` is on process.env's PATH, the one a command is run with, or null. Bun.which alone
 * reads the PATH the process started with, and doesn't see process.env.PATH changed since
 * (tutti-xj3t).
 */
export const whichOnPath = (command: string): string | null =>
  Bun.which(command, { PATH: process.env.PATH ?? "" })

/** Whether `command` is on process.env's PATH (`whichOnPath`). */
export const installedOnPath = (command: string): boolean => whichOnPath(command) !== null
