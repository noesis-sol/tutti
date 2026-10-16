// biome-ignore-all lint/suspicious/noControlCharactersInRegex: the patterns are terminal escape sequences
// A pseudo-terminal for the spike's programs, with Bun.Terminal: it plays the terminal emulator,
// answering OpenTUI's colour queries (OSC 10 and 11) with a chosen theme, and keeps what the
// program wrote for the checks to inspect.

export type Theme = { readonly fg: string; readonly bg: string }

export const DARK: Theme = { fg: "rgb:c0c0/caca/f5f5", bg: "rgb:1a1a/1b1b/2626" }
export const LIGHT: Theme = { fg: "rgb:3434/3b3b/5858", bg: "rgb:f5f5/f5f5/f5f5" }

export type PtyOptions = {
  readonly cols: number
  readonly rows: number
  /** The theme to answer OSC 10/11 queries with; null leaves them unanswered. */
  readonly theme: Theme | null
  /** Keep the whole output (the checks); otherwise only bytes are counted (the soak). */
  readonly keepOutput: boolean
  readonly env?: Record<string, string>
}

export type Pty = {
  readonly proc: Bun.Subprocess
  readonly terminal: Bun.Terminal
  /** Everything written so far, when keepOutput. */
  output(): string
  bytes(): number
  /** Output since the last mark. */
  mark(): void
  sinceMark(): string
  setTheme(theme: Theme | null): void
  write(data: string): void
  /** Resolves once the output since the last mark matches, or rejects after timeoutMs. */
  waitFor(pattern: RegExp | string, timeoutMs?: number): Promise<void>
}

const OSC_QUERY = /\x1b\](10|11);\?(?:\x07|\x1b\\)/g

export const spawnInPty = (argv: string[], options: PtyOptions): Pty => {
  let theme = options.theme
  let text = ""
  let bytes = 0
  let markAt = 0
  let tail = ""
  const decoder = new TextDecoder()
  const waiters = new Set<() => void>()
  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
    data(term, data) {
      bytes += data.byteLength
      const chunk = decoder.decode(data, { stream: true })
      if (options.keepOutput) text += chunk
      // A query can straddle two chunks, so the unmatched end of the last one is scanned again.
      const scan = tail + chunk
      let end = 0
      for (const m of scan.matchAll(OSC_QUERY)) {
        end = m.index + m[0].length
        if (theme !== null) term.write(`\x1b]${m[1]};${m[1] === "10" ? theme.fg : theme.bg}\x1b\\`)
      }
      tail = scan.slice(Math.max(end, scan.length - 16))
      for (const wake of waiters) wake()
    },
  })
  const proc = Bun.spawn(argv, {
    terminal,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...options.env },
  })
  return {
    proc,
    terminal,
    output: () => text,
    bytes: () => bytes,
    mark: () => {
      markAt = text.length
    },
    sinceMark: () => text.slice(markAt),
    setTheme: (next) => {
      theme = next
    },
    write: (data) => {
      terminal.write(data)
    },
    waitFor: (pattern, timeoutMs = 5_000) =>
      new Promise<void>((resolve, reject) => {
        const test = () =>
          typeof pattern === "string"
            ? text.slice(markAt).includes(pattern)
            : pattern.test(text.slice(markAt))
        if (test()) return resolve()
        const wake = () => {
          if (!test()) return
          waiters.delete(wake)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          waiters.delete(wake)
          reject(new Error(`timed out after ${timeoutMs} ms waiting for ${String(pattern)}`))
        }, timeoutMs)
        waiters.add(wake)
      }),
  }
}
