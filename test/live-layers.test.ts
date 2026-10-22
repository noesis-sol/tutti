// The live layers that read or drive the machine, run against fake commands in a folder of their
// own that is the whole of the test's PATH, never the machine's: the load from ps, and sysctl and
// vm_stat or /proc (liveLoad), the notifier (Notifier's layer), the clipboard (liveClipboard) and
// the URL opener (liveUrlOpener). Their logic is tested through fakes in load.test.ts,
// notifier.test.ts, clipboard.test.ts and open-url.test.tsx; this is the wiring to the machine.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import type { CliRenderer } from "@opentui/core"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { liveLoad, parseDarwin, parseLinux, parseProcesses, psArgs } from "../src/run/load.ts"
import {
  layer as liveNotifier,
  Notifier,
  notifySendArgs,
  osascriptArgs,
} from "../src/services/Notifier.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as ttyLayer } from "../src/testing/Tty.ts"
import { liveClipboard } from "../src/ui/clipboard.ts"
import { liveUrlOpener } from "../src/ui/openUrl.ts"
import { withVariable } from "./env.ts"

/** A folder for a test's fake commands, and what they leave. */
const fakes = (): string => mkdtempSync(join(tmpdir(), "tutti-live-layers-"))

/**
 * A fake `name` in `dir`: it writes its arguments, a line each, to `<name>.args`, and its stdin to
 * `<name>.stdin` when `readsStdin`; prints `stdout`, and exits with `exit`.
 */
const fake = (
  dir: string,
  name: string,
  options: { readonly stdout?: string; readonly exit?: number; readonly readsStdin?: boolean } = {},
): void => {
  const out = join(dir, `${name}.stdout`)
  writeFileSync(out, options.stdout ?? "")
  const script = [
    "#!/bin/sh",
    `: > '${join(dir, `${name}.args`)}'`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> '${join(dir, `${name}.args`)}'; done`,
    options.readsStdin === true ? `/bin/cat > '${join(dir, `${name}.stdin`)}'` : "",
    `/bin/cat '${out}'`,
    `exit ${options.exit ?? 0}`,
    "",
  ].join("\n")
  writeFileSync(join(dir, name), script)
  chmodSync(join(dir, name), 0o755)
}

/** The arguments the fake `name` in `dir` was run with, or null when it wasn't run. */
const argsOf = (dir: string, name: string): ReadonlyArray<string> | null => {
  const file = join(dir, `${name}.args`)
  if (!existsSync(file)) return null
  const text = readFileSync(file, "utf8")
  return text === "" ? [] : text.replace(/\n$/, "").split("\n")
}

/** `body` with `dir` the whole PATH, and no display unless `display`, as in a local session. */
const onPath = <A>(dir: string, body: () => Promise<A>, display?: string): Promise<A> =>
  withVariable("PATH", dir, () =>
    withVariable("WAYLAND_DISPLAY", undefined, () => withVariable("DISPLAY", display, body)),
  )

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const sysctl = "1\n{ 9.80 8.12 7.40 }\n10\n"
const vmstat = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                                5000.",
  "Swapins:                                  8873329.",
  "Swapouts:                                 9000001.",
  "",
].join("\n")

describe("the live load", () => {
  const listing = "    1     0     1   1000\n  100     1   100  50000\n"

  test("lists the processes from ps, with psArgs", async () => {
    const dir = fakes()
    fake(dir, "ps", { stdout: listing })
    const processes = await onPath(dir, () => run(liveLoad("darwin").processes))
    expect(processes).toEqual(parseProcesses(listing))
    expect(argsOf(dir, "ps")).toEqual([...psArgs])
  })

  test("has no processes when ps fails, or isn't there", async () => {
    const dir = fakes()
    expect(await onPath(dir, () => run(liveLoad("darwin").processes))).toBeUndefined()
    fake(dir, "ps", { stdout: listing, exit: 1 })
    expect(await onPath(dir, () => run(liveLoad("darwin").processes))).toBeUndefined()
  })

  test("on macOS reads the kernel's figures from sysctl and vm_stat", async () => {
    const dir = fakes()
    fake(dir, "sysctl", { stdout: sysctl })
    fake(dir, "vm_stat", { stdout: vmstat })
    const kernel = await onPath(dir, () => run(liveLoad("darwin").kernel))
    expect(kernel).toEqual(parseDarwin(sysctl, vmstat))
    expect(kernel).toEqual({
      pressure: "normal",
      swaps: 8873329 + 9000001,
      load1: 9.8,
      cores: 10,
      available: -1,
    })
    expect(argsOf(dir, "sysctl")).toEqual([
      "-n",
      "kern.memorystatus_vm_pressure_level",
      "vm.loadavg",
      "hw.ncpu",
    ])
    expect(argsOf(dir, "vm_stat")).toEqual([])
  })

  test("on macOS has no swaps when vm_stat fails", async () => {
    const dir = fakes()
    fake(dir, "sysctl", { stdout: sysctl })
    fake(dir, "vm_stat", { stdout: vmstat, exit: 1 })
    const kernel = await onPath(dir, () => run(liveLoad("darwin").kernel))
    expect(kernel).toEqual(parseDarwin(sysctl, ""))
    expect(kernel?.swaps).toBe(-1)
  })

  test("on macOS has no kernel figures when sysctl fails, or isn't there", async () => {
    const dir = fakes()
    fake(dir, "vm_stat", { stdout: vmstat })
    expect(await onPath(dir, () => run(liveLoad("darwin").kernel))).toBeUndefined()
    fake(dir, "sysctl", { stdout: sysctl, exit: 1 })
    expect(await onPath(dir, () => run(liveLoad("darwin").kernel))).toBeUndefined()
  })

  const proc: Readonly<Record<string, string>> = {
    "/proc/loadavg": "2.50 1.20 0.80 3/400 12345\n",
    "/proc/pressure/memory":
      "some avg10=12.00 avg60=3.00 avg300=1.00 total=100\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=10\n",
    "/proc/meminfo": "MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\n",
    "/proc/vmstat": "pswpin 12\npswpout 30\n",
  }

  /** A FileSystem whose files are `files`: any other can't be read, as the kernel lacks it. */
  const procFiles = (files: Readonly<Record<string, string>>) =>
    FileSystem.layerNoop({
      readFileString: (path) => {
        const text = files[path]
        return text === undefined
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: path,
              }),
            )
          : Effect.succeed(text)
      },
    })

  const linuxKernel = (files: Readonly<Record<string, string>>) =>
    run(liveLoad("linux", () => 8).kernel.pipe(Effect.provide(procFiles(files))))

  test("on Linux reads the kernel's figures from /proc, with the CPU count given", async () => {
    const kernel = await linuxKernel(proc)
    expect(kernel).toEqual(
      parseLinux({
        loadavg: proc["/proc/loadavg"] ?? "",
        pressure: proc["/proc/pressure/memory"] ?? "",
        meminfo: proc["/proc/meminfo"] ?? "",
        vmstat: proc["/proc/vmstat"] ?? "",
        cores: 8,
      }),
    )
    expect(kernel).toEqual({
      pressure: "warn",
      swaps: 42,
      load1: 2.5,
      cores: 8,
      available: 8192000 * 1024,
    })
  })

  test("on Linux takes a file the kernel lacks for one that says nothing", async () => {
    const { "/proc/pressure/memory": _, ...withoutPressure } = proc
    const kernel = await linuxKernel(withoutPressure)
    // No pressure stall information: the share of memory available tells the pressure instead.
    expect(kernel?.pressure).toBe("normal")
    expect(kernel?.load1).toBe(2.5)
    expect(await linuxKernel({})).toBeUndefined()
  })

  test("elsewhere has no kernel figures", async () => {
    const dir = fakes()
    fake(dir, "sysctl", { stdout: sysctl })
    expect(await onPath(dir, () => run(liveLoad("win32").kernel))).toBeUndefined()
    expect(argsOf(dir, "sysctl")).toBeNull()
  })
})

/** The desktop's commands on this machine's platform, which the live layers read; null elsewhere. */
const desktop =
  process.platform === "darwin"
    ? { notifier: "osascript", copy: "pbcopy", copyArgs: [], open: "open", display: undefined }
    : process.platform === "linux"
      ? {
          notifier: "notify-send",
          copy: "xclip",
          copyArgs: ["-selection", "clipboard"],
          open: "xdg-open",
          display: ":0",
        }
      : null

const onDesktop = desktop === null ? describe.skip : describe

describe("the live layers on this platform's desktop", () => {
  onDesktop("the notifier", () => {
    test("runs the platform's notifier on PATH with the notice, titled with the repository", async () => {
      if (desktop === null) return
      const dir = fakes()
      fake(dir, desktop.notifier)
      const repo = join(dir, "my-project")
      const notify = Effect.gen(function* () {
        const notifier = yield* Notifier
        yield* notifier.notify("t-1 merged")
      }).pipe(
        // The layer's scope closes once the notice shown in the background is done.
        Effect.provide(liveNotifier),
        Effect.provide(
          Layer.mergeAll(appConfigLayer(appConfig({ notify: true }, repo)), logLayer(), ttyLayer()),
        ),
      )
      await onPath(dir, () => run(notify), desktop.display)
      const args =
        desktop.notifier === "osascript"
          ? osascriptArgs(basename(repo), "t-1 merged")
          : notifySendArgs(basename(repo), "t-1 merged")
      expect(argsOf(dir, desktop.notifier)).toEqual([...args])
    })
  })

  /** A renderer whose OSC 52 says whether it was asked to copy: the live clipboard runs a command. */
  const renderer = (asked: Array<string>) =>
    ({
      copyToClipboardOSC52: (text: string) => {
        asked.push(text)
        return false
      },
    }) as unknown as CliRenderer

  onDesktop("the clipboard", () => {
    test("runs the platform's copy command on PATH with the text on its stdin", async () => {
      if (desktop === null) return
      const dir = fakes()
      fake(dir, desktop.copy, { readsStdin: true })
      const asked: Array<string> = []
      const copied = await onPath(
        dir,
        () =>
          run(liveClipboard(renderer(asked))).then((clipboard) => clipboard.copy("line one\nzwei")),
        desktop.display,
      )
      expect(copied).toBe(true)
      expect(argsOf(dir, desktop.copy)).toEqual(desktop.copyArgs)
      expect(readFileSync(join(dir, `${desktop.copy}.stdin`), "utf8")).toBe("line one\nzwei")
      expect(asked).toEqual([])
    })

    test("says it couldn't copy when the command fails", async () => {
      if (desktop === null) return
      const dir = fakes()
      fake(dir, desktop.copy, { readsStdin: true, exit: 1 })
      const copied = await onPath(
        dir,
        () => run(liveClipboard(renderer([]))).then((clipboard) => clipboard.copy("text")),
        desktop.display,
      )
      expect(copied).toBe(false)
    })
  })

  onDesktop("the URL opener", () => {
    test("runs the platform's open command on PATH with the URL", async () => {
      if (desktop === null) return
      const dir = fakes()
      fake(dir, desktop.open)
      fake(dir, desktop.copy, { readsStdin: true })
      const url = "https://example.com/authorize?code=1"
      const opened = await onPath(
        dir,
        () =>
          run(
            Effect.flatMap(liveClipboard(renderer([])), (clipboard) => liveUrlOpener(clipboard)),
          ).then((opener) => opener.open(url)),
        desktop.display,
      )
      expect(opened).toBe("opened")
      expect(argsOf(dir, desktop.open)).toEqual([url])
      expect(argsOf(dir, desktop.copy)).toBeNull()
    })

    test("copies the URL with the clipboard when the open command fails", async () => {
      if (desktop === null) return
      const dir = fakes()
      fake(dir, desktop.open, { exit: 1 })
      fake(dir, desktop.copy, { readsStdin: true })
      const url = "https://example.com/authorize"
      const opened = await onPath(
        dir,
        () =>
          run(
            Effect.flatMap(liveClipboard(renderer([])), (clipboard) => liveUrlOpener(clipboard)),
          ).then((opener) => opener.open(url)),
        desktop.display,
      )
      expect(opened).toBe("copied")
      expect(argsOf(dir, desktop.open)).toEqual([url])
      expect(readFileSync(join(dir, `${desktop.copy}.stdin`), "utf8")).toBe(url)
    })
  })
})
