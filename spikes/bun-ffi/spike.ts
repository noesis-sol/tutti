// Throwaway spike for tutti-nrg.1.6 (spec § 14, M0 (7); § 9.1, § 9.2, § 7.4): flock, O_CLOEXEC
// and openat/O_NOFOLLOW through bun:ffi, and SIGUSR1, SIGUSR2 and SIGTSTP under Bun.
//
//   bun spikes/bun-ffi/spike.ts <scenario> [--compiled]
//
// Scenarios:
//   constants  the libc constants in libc.ts against node:fs's and node:os's for this platform
//   flags      the descriptor flags of files Bun opens itself (node:fs, fs/promises, streams), and
//              of Bun's own descriptors; then whether a child spawned by Bun.spawn, node:child_process
//              and effect/process inherits a descriptor opened with and without O_CLOEXEC
//   lock       flock(LOCK_EX|LOCK_NB) across processes: a second holder refused, kill -9 releasing
//              it, and whether a `sleep` spawned by the holder keeps it after the holder's kill -9,
//              for each way of opening and spawning
//   openat     openBeneath (openat with O_NOFOLLOW per component) against symlinks anywhere on the
//              path, O_EXCL and mode 0600; the variadic mode with and without the darwin arm64
//              padding; O_NOFOLLOW_ANY (darwin) and openat2 RESOLVE_NO_SYMLINKS (linux)
//   cc         the same openat through a C helper compiled at run time by bun:ffi's cc
//   signals    SIGUSR1, SIGUSR2 and SIGTSTP with process.on handlers, and with none
//   all        every scenario above
//
// --compiled builds holder.ts and sig-child.ts with `bun build --compile` first and runs those
// binaries as the children, as tutti will ship.
//
// Each check prints `PASS`, `FAIL` or `INFO` and a line; the process exits 1 if any FAIL.
// docs/spikes/06-bun-ffi.md was written from this output on macOS and in Linux containers.
//
// Not product code: no Effect services, no tests.

import { cc, dlopen, FFIType } from "bun:ffi"
import { spawn as nodeSpawn } from "node:child_process"
import {
  createWriteStream,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { open as openPromise } from "node:fs/promises"
import { constants as osConstants, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/process"
import {
  C,
  cloexecOf,
  close,
  constantsByPlatform,
  Errno,
  errno,
  errnoName,
  fdFlags,
  libcPath,
  open,
  openat,
  openatUnpadded,
  openBeneath,
  platform,
  Refused,
  statusFlags,
} from "./libc.ts"

const here = dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const scenario = argv[0] ?? "all"
const compiled = argv.includes("--compiled")
const work = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spike-bun-ffi-")))

let failures = 0
const pass = (line: string) => console.log(`PASS ${line}`)
const fail = (line: string) => {
  failures++
  console.log(`FAIL ${line}`)
}
const info = (line: string) => console.log(`INFO ${line}`)
const expect = (ok: boolean, line: string) => (ok ? pass(line) : fail(line))
const hex = (n: number) => `0x${n.toString(16)}`

// Children: `bun <script>`, or the compiled binary with --compiled.
const binaries = new Map<string, string>()
const childCommand = (script: string, args: Array<string>): Array<string> => {
  const binary = binaries.get(script)
  return binary !== undefined ? [binary, ...args] : [process.execPath, join(here, script), ...args]
}

const compile = async () => {
  for (const script of ["holder.ts", "sig-child.ts"]) {
    const out = join(work, script.replace(/\.ts$/, ""))
    const build = Bun.spawnSync(
      [process.execPath, "build", "--compile", join(here, script), "--outfile", out],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    if (build.exitCode !== 0) throw new Error(`bun build --compile ${script}: ${build.stderr}`)
    binaries.set(script, out)
  }
  info(`compiled holder and sig-child into ${work}`)
}

// A child whose stdout lines can be awaited.
interface Child {
  readonly pid: number
  readonly proc: Bun.Subprocess<"ignore", "pipe", "inherit">
  readonly lines: Array<string>
  readonly waitFor: (re: RegExp, ms?: number) => Promise<string | undefined>
}

const start = (cmd: Array<string>): Child => {
  const proc = Bun.spawn(cmd, { stdio: ["ignore", "pipe", "inherit"] })
  const lines: Array<string> = []
  const waiters: Array<() => void> = []
  void (async () => {
    let buffered = ""
    for await (const chunk of proc.stdout) {
      buffered += new TextDecoder().decode(chunk)
      const parts = buffered.split("\n")
      buffered = parts.pop() ?? ""
      lines.push(...parts)
      for (const w of waiters.splice(0)) w()
    }
    for (const w of waiters.splice(0)) w()
  })()
  const waitFor = async (re: RegExp, ms = 5000) => {
    const deadline = Date.now() + ms
    let seen = 0
    for (;;) {
      for (; seen < lines.length; seen++) if (re.test(lines[seen] as string)) return lines[seen]
      if (Date.now() > deadline) return undefined
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }
  return { pid: proc.pid, proc, lines, waitFor }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killIfAlive = (pid: number, signal: NodeJS.Signals = "SIGKILL") => {
  if (alive(pid)) process.kill(pid, signal)
}

// The process's state letter (S sleeping, T stopped), from /proc on linux, where containers may
// have no ps.
const psState = (pid: number) => {
  if (process.platform === "linux") {
    try {
      return (
        readFileSync(`/proc/${pid}/stat`, "utf8")
          .replace(/^.*\) /, "")
          .split(" ")[0] ?? "?"
      )
    } catch {
      return "gone"
    }
  }
  return Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim()
}

// ---------------------------------------------------------------------------------------------

const constantsScenario = () => {
  info(`platform ${platform}, Bun ${Bun.version}, libc ${libcPath}`)
  const fromNode: Record<string, number | undefined> = {
    O_RDONLY: fsConstants.O_RDONLY,
    O_WRONLY: fsConstants.O_WRONLY,
    O_RDWR: fsConstants.O_RDWR,
    O_CREAT: fsConstants.O_CREAT,
    O_EXCL: fsConstants.O_EXCL,
    O_TRUNC: fsConstants.O_TRUNC,
    O_APPEND: fsConstants.O_APPEND,
    O_NOFOLLOW: fsConstants.O_NOFOLLOW,
    O_DIRECTORY: fsConstants.O_DIRECTORY,
    ENOENT: osConstants.errno.ENOENT,
    EEXIST: osConstants.errno.EEXIST,
    ENOTDIR: osConstants.errno.ENOTDIR,
    EWOULDBLOCK: osConstants.errno.EWOULDBLOCK,
    ELOOP: osConstants.errno.ELOOP,
  }
  for (const [name, node] of Object.entries(fromNode)) {
    const ours = (C as unknown as Record<string, number>)[name]
    expect(ours === node, `constant ${name}: libc.ts ${ours}, node:fs/os ${node}`)
  }
  const extra = fsConstants as unknown as Record<string, number | undefined>
  info(
    `not in node:fs constants: O_CLOEXEC=${extra.O_CLOEXEC}, AT_FDCWD=${extra.AT_FDCWD}; ` +
      `ours ${hex(C.O_CLOEXEC)}, ${C.AT_FDCWD}`,
  )
  const differing = Object.keys(C).filter((k) => {
    const values = new Set(
      Object.values(constantsByPlatform).map((c) => (c as unknown as Record<string, unknown>)[k]),
    )
    return values.size > 1
  })
  info(`constants differing across platforms: ${differing.join(", ")}`)
}

// ---------------------------------------------------------------------------------------------

const describeFd = (fd: number) => `fdflags=${cloexecOf(fd)} status=${hex(statusFlags(fd))}`

const flagsScenario = async () => {
  const file = join(work, "flags.txt")
  writeFileSync(file, "x")
  const opened: Array<[string, number]> = [
    ['fs.openSync(p, "r")', openSync(file, "r")],
    ['fs.openSync(p, "w")', openSync(file, "w")],
    ['fs.openSync(p, "a+")', openSync(file, "a+")],
    ["fs.openSync(p, O_RDWR|O_CREAT)", openSync(file, fsConstants.O_RDWR | fsConstants.O_CREAT)],
    ["libc open(O_RDWR) (no O_CLOEXEC)", open(file, C.O_RDWR)],
    ["libc open(O_RDWR|O_CLOEXEC)", open(file, C.O_RDWR | C.O_CLOEXEC)],
  ]
  const handle = await openPromise(file, "a+")
  opened.push(['fs/promises open(p, "a+")', handle.fd])
  const stream = createWriteStream(join(work, "stream.txt"))
  const streamFd = await new Promise<number>((resolve) => stream.on("open", resolve))
  opened.push(["fs.createWriteStream", streamFd])
  for (const [how, fd] of opened) {
    const cloexec = cloexecOf(fd) === "cloexec"
    const line = `${how}: fd ${fd} ${describeFd(fd)}`
    if (how.includes("no O_CLOEXEC")) info(line)
    else expect(cloexec, line)
  }
  // Bun's own descriptors, other than those opened above and stdio.
  const ours = new Set(opened.map(([, fd]) => fd))
  const own: Array<string> = []
  for (let fd = 0; fd < 1024; fd++) {
    if (ours.has(fd)) continue
    const state = cloexecOf(fd)
    if (state !== "closed") own.push(`${fd}:${state}`)
  }
  info(`Bun's own descriptors (fd:flag): ${own.join(" ")}`)

  // Inheritance: a child lists the descriptors it has that are this file.
  const plain = open(file, C.O_RDWR)
  const cloexec = open(file, C.O_RDWR | C.O_CLOEXEC)
  info(`for the children: fd ${plain} without O_CLOEXEC, fd ${cloexec} with it`)
  const probe = [process.execPath, join(here, "fds.ts"), file]
  const viaBun = async () => {
    const p = Bun.spawn(probe, { stdio: ["ignore", "pipe", "inherit"] })
    return new Response(p.stdout).text()
  }
  const viaNode = () =>
    new Promise<string>((resolve) => {
      const p = nodeSpawn(probe[0] as string, probe.slice(1), {
        stdio: ["ignore", "pipe", "inherit"],
      })
      let out = ""
      p.stdout.on("data", (d) => {
        out += d
      })
      p.on("close", () => resolve(out))
    })
  const viaEffectText = (detached: boolean) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* ChildProcess.make(probe[0] as string, probe.slice(1), {
            detached,
            stdin: "ignore",
            stderr: "inherit",
          })
          const text = yield* h.stdout.pipe((s) =>
            Effect.map(collect(s), (parts) => new TextDecoder().decode(concat(parts))),
          )
          yield* h.exitCode
          return text
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    )
  const spawners: Array<[string, () => Promise<string>]> = [
    ["Bun.spawn", viaBun],
    ["node:child_process spawn", viaNode],
    ["effect/process ChildProcess", () => viaEffectText(false)],
    ["effect/process ChildProcess detached", () => viaEffectText(true)],
  ]
  for (const [name, run] of spawners) {
    const out = (await run()).trim()
    const inherited = [...out.matchAll(/inherited fd=(\d+)/g)].map((m) => Number(m[1]))
    const openFds = /open-fds (.*)/.exec(out)?.[1] ?? "?"
    info(`${name}: child has this file at fd [${inherited.join(",")}]; its fds >= 3: ${openFds}`)
    expect(!inherited.includes(cloexec), `${name}: the O_CLOEXEC descriptor is not inherited`)
    info(
      `${name}: the descriptor without O_CLOEXEC is ${inherited.includes(plain) ? "inherited" : "not inherited"}`,
    )
  }
  for (const [, fd] of opened) if (fd !== handle.fd && fd !== streamFd) close(fd)
  await handle.close()
  stream.destroy()
  close(plain)
  close(cloexec)
}

const collect = (s: Stream.Stream<Uint8Array, unknown>) =>
  Stream.runCollect(s).pipe(Effect.map((c) => Array.from(c)))
const concat = (parts: Array<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------------------------------------------------------------------------------------------

const lockScenario = async () => {
  const lock = join(work, "tutti.lock")
  const holder = (how: string, spawner = "none", tryOnly = false) =>
    start(childCommand("holder.ts", [lock, how, spawner, ...(tryOnly ? ["--try"] : [])]))
  const tryLock = async () => {
    const t = holder("ffi-cloexec", "none", true)
    const line = (await t.waitFor(/^(held|refused)/)) ?? "no answer"
    await t.proc.exited
    return line.startsWith("held") ? "held" : line.startsWith("refused") ? "refused" : line
  }

  const first = holder("ffi-cloexec")
  const held = await first.waitFor(/^held/)
  expect(held?.includes("fdflags=cloexec") === true, `first holder: ${held}`)
  expect((await tryLock()) === "refused", "a second process is refused while the first holds it")
  process.kill(first.pid, "SIGKILL")
  await first.proc.exited
  expect((await tryLock()) === "held", "kill -9 of the holder releases the lock")

  for (const how of ["ffi-cloexec", "ffi-plain", "fs"]) {
    for (const spawner of ["bun-spawn", "node-spawn", "effect", "libc-system"]) {
      const h = holder(how, spawner)
      const heldLine = await h.waitFor(/^held/)
      const childLine = await h.waitFor(/^child \d+/)
      const childPid = Number(childLine?.split(" ")[1])
      if (heldLine === undefined || !childPid) {
        fail(`${how} + ${spawner}: holder said ${h.lines.join(" | ")}`)
        killIfAlive(h.pid)
        continue
      }
      process.kill(h.pid, "SIGKILL")
      await h.proc.exited
      const childAlive = alive(childPid)
      const after = await tryLock()
      const line = `${how} + ${spawner} (${heldLine.split(" ")[2]}): after kill -9 of the holder, its child ${childAlive ? "alive" : "gone"}, the lock is ${after === "held" ? "free" : "still held"}`
      if (how === "ffi-plain" && spawner === "libc-system") expect(after === "refused", line)
      else if (how === "ffi-plain") info(line)
      else expect(after === "held" && childAlive, line)
      killIfAlive(childPid)
    }
  }
}

// ---------------------------------------------------------------------------------------------

const errnoOf = (f: () => unknown): string => {
  try {
    const fd = f()
    if (typeof fd === "number") close(fd)
    return "opened"
  } catch (e) {
    if (e instanceof Errno) return errnoName(e.code)
    if (e instanceof Refused) return "refused before any call"
    throw e
  }
}

const openatScenario = () => {
  // root/                    the worktree
  //   .tutti/run/            real directories
  //   .tutti/run/out-file -> outside/secret     a symlink as the last component
  //   .tutti/run/out-dir -> outside             a symlink as a middle component
  //   .tutti/linked-run -> run                  a symlink inside the tree, still refused
  //   linked-tutti -> .tutti                    a symlink at the first component
  // outside/secret
  const root = join(work, "root")
  const outside = join(work, "outside")
  mkdirSync(join(root, ".tutti/run/attention"), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, "secret"), "secret")
  symlinkSync(join(outside, "secret"), join(root, ".tutti/run/out-file"))
  symlinkSync(outside, join(root, ".tutti/run/out-dir"))
  symlinkSync("run", join(root, ".tutti/linked-run"))
  symlinkSync(".tutti", join(root, "linked-tutti"))

  const rootFd = open(root, C.O_RDONLY | C.O_DIRECTORY | C.O_CLOEXEC)
  const create = C.O_WRONLY | C.O_CREAT | C.O_TRUNC

  const fd = openBeneath(rootFd, ".tutti/run/check.log", create, 0o644)
  writeSync(fd, "ok\n")
  const mode = fstatSync(fd).mode & 0o777
  expect(cloexecOf(fd) === "cloexec", `openBeneath opens with O_CLOEXEC: ${describeFd(fd)}`)
  close(fd)
  expect(
    readFileSync(join(root, ".tutti/run/check.log"), "utf8") === "ok\n",
    `openBeneath(".tutti/run/check.log") writes the file (mode ${mode.toString(8)})`,
  )

  const cases: Array<[string, string]> = [
    [".tutti/run/out-file", "a symlink as the last component"],
    [".tutti/run/out-dir/secret", "a symlink to a folder outside, mid-path"],
    [".tutti/linked-run/check.log", "a symlink inside the tree, mid-path"],
    ["linked-tutti/run/check.log", "a symlink as the first component"],
    [".tutti/run/../run/check.log", "a .. component"],
    ["/etc/passwd", "an absolute path"],
  ]
  for (const [path, what] of cases) {
    const result = errnoOf(() => openBeneath(rootFd, path, C.O_RDONLY))
    expect(result !== "opened", `${what} (${path}): ${result}`)
  }
  expect(
    readFileSync(join(outside, "secret"), "utf8") === "secret",
    "the file outside is untouched",
  )

  const attention = ".tutti/run/attention/req-1.json"
  const excl = C.O_WRONLY | C.O_CREAT | C.O_EXCL
  const a = openBeneath(rootFd, attention, excl, 0o600)
  const aMode = fstatSync(a).mode & 0o777
  close(a)
  expect(
    aMode === 0o600,
    `O_EXCL create with mode 0600 through the padded openat: ${aMode.toString(8)}`,
  )
  expect(
    errnoOf(() => openBeneath(rootFd, attention, excl, 0o600)) === "EEXIST",
    "a second O_EXCL create of the same file: EEXIST",
  )

  // The variadic mode without padding.
  const runFd = openBeneath(rootFd, ".tutti/run", C.O_RDONLY | C.O_DIRECTORY)
  const modes: Array<string> = []
  for (let i = 0; i < 5; i++) {
    try {
      const u = openatUnpadded(runFd, `unpadded-${i}`, excl | C.O_CLOEXEC, 0o600)
      modes.push((fstatSync(u).mode & 0o7777).toString(8))
      close(u)
    } catch (e) {
      modes.push(String(e))
    }
  }
  const allRight = modes.every((m) => m === "600")
  const line = `openat declared without padding, mode 0600 asked five times: got ${modes.join(", ")}`
  if (platform === "darwin-arm64") info(line)
  else expect(allRight, line)
  close(runFd)

  // Kernel-side alternatives to the per-component walk.
  const nofollowAny = C.O_NOFOLLOW_ANY
  if (nofollowAny !== undefined) {
    const any = (p: string) => errnoOf(() => open(join(root, p), C.O_RDONLY | nofollowAny))
    expect(any(".tutti/run/check.log") === "opened", "O_NOFOLLOW_ANY opens a plain path")
    expect(
      any(".tutti/linked-run/check.log") !== "opened",
      `O_NOFOLLOW_ANY refuses a link mid-path: ${any(".tutti/linked-run/check.log")}`,
    )
  }
  const beneath = C.O_RESOLVE_BENEATH
  if (beneath !== undefined) {
    const b = (p: string) => errnoOf(() => openat(rootFd, p, C.O_RDONLY | C.O_CLOEXEC | beneath))
    info(`openat O_RESOLVE_BENEATH, a plain path: ${b(".tutti/run/check.log")}`)
    info(`openat O_RESOLVE_BENEATH, a link inside the tree: ${b(".tutti/linked-run/check.log")}`)
    info(`openat O_RESOLVE_BENEATH, a link out of the tree: ${b(".tutti/run/out-dir/secret")}`)
    info(`openat O_RESOLVE_BENEATH, a .. path out of the tree: ${b("../outside/secret")}`)
  }
  if (process.platform === "linux") openat2Check(rootFd)
  close(rootFd)
}

// linux's openat2(RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH), through syscall(2) since glibc has no
// wrapper. SYS_openat2 is 437 on x86_64 and arm64 alike.
const openat2Check = (rootFd: number) => {
  const lib = dlopen(libcPath, {
    syscall: {
      args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.i64],
      returns: FFIType.i64,
    },
  })
  const how = new BigUint64Array([BigInt(C.O_RDONLY | C.O_CLOEXEC), 0n, 0x04n | 0x08n])
  const call = (p: string) => {
    const r = Number(lib.symbols.syscall(437, rootFd, Buffer.from(`${p}\0`), how, 24))
    if (r >= 0) {
      close(r)
      return "opened"
    }
    return errnoName(errno())
  }
  info(`openat2 RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH, a plain path: ${call(".tutti/run/check.log")}`)
  info(`openat2, a link out of the tree: ${call(".tutti/run/out-dir/secret")}`)
  info(`openat2, a link mid-path: ${call(".tutti/linked-run/check.log")}`)
  info(`openat2, a .. path: ${call("../outside/secret")}`)
  lib.close()
}

// ---------------------------------------------------------------------------------------------

const ccScenario = () => {
  let helper: { symbols: { helper_openat: (...a: Array<unknown>) => number } }
  try {
    helper = cc({
      source: join(here, "helper.c"),
      symbols: {
        helper_openat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
      },
    }) as never
  } catch (e) {
    info(`cc could not compile helper.c: ${(e as Error).message.replaceAll("\n", " | ")}`)
    return
  }
  const dir = mkdtempSync(join(work, "cc-"))
  const dirFd = open(dir, C.O_RDONLY | C.O_DIRECTORY | C.O_CLOEXEC)
  const modes: Array<string> = []
  for (let i = 0; i < 3; i++) {
    const fd = helper.symbols.helper_openat(
      dirFd,
      Buffer.from(`f-${i}\0`),
      C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_CLOEXEC,
      0o600,
    )
    modes.push(fd < 0 ? `fd ${fd}` : (fstatSync(fd).mode & 0o7777).toString(8))
    if (fd >= 0) close(fd)
  }
  expect(
    modes.every((m) => m === "600"),
    `cc helper: openat mode 0600 asked three times: ${modes.join(", ")}`,
  )
  close(dirFd)
}

// ---------------------------------------------------------------------------------------------

const startSigChild = async (mode: string) => {
  const child = start(childCommand("sig-child.ts", [mode]))
  await child.waitFor(/^ready \d+/)
  return child
}

const signalsScenario = async () => {
  const child = await startSigChild("handlers")
  const pid = child.pid
  expect(pid > 0, `child with handlers ready, pid ${pid}, ps state ${psState(pid)}`)
  for (const signal of ["SIGUSR1", "SIGUSR2", "SIGTSTP", "SIGUSR1"] as const) {
    const count = () => child.lines.filter((l) => l === `got ${signal}`).length
    const before = count()
    process.kill(pid, signal)
    const deadline = Date.now() + 3000
    while (count() === before && Date.now() < deadline) await sleep(20)
    await sleep(100)
    const got = count() > before
    const state = psState(pid)
    expect(
      got && alive(pid) && !state.startsWith("T"),
      `${signal} with a process.on handler: handler ran ${got}, process alive, ps state ${state}`,
    )
  }
  killIfAlive(pid)
  await child.proc.exited

  // Default actions, with no handlers.
  for (const signal of ["SIGUSR1", "SIGUSR2"] as const) {
    const c = await startSigChild("none")
    process.kill(c.pid, signal)
    const ended = await Promise.race([c.proc.exited.then(() => "exited"), sleep(3000)])
    info(
      `${signal} with no handler: ${ended === "exited" ? `ended by ${c.proc.signalCode}` : "still running"}`,
    )
    killIfAlive(c.pid)
    await c.proc.exited
  }
  const stopped = await startSigChild("none")
  process.kill(stopped.pid, "SIGTSTP")
  await sleep(300)
  info(`SIGTSTP with no handler: ps state ${psState(stopped.pid)} (T is stopped)`)
  killIfAlive(stopped.pid)
  await stopped.proc.exited
}

// ---------------------------------------------------------------------------------------------

const scenarios: Record<string, () => unknown> = {
  constants: constantsScenario,
  flags: flagsScenario,
  lock: lockScenario,
  openat: openatScenario,
  cc: ccScenario,
  signals: signalsScenario,
}

if (compiled) await compile()
const names = scenario === "all" ? Object.keys(scenarios) : [scenario]
for (const name of names) {
  const run = scenarios[name]
  if (run === undefined) throw new Error(`unknown scenario ${name}`)
  console.log(`== ${name}${compiled ? " (compiled children)" : ""}`)
  await run()
}
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
