// --overnight's pre-flight checks one by one (src/run/overnight.ts; tutti-kkb.46): each passing,
// warning and failing, each fix it offers and what making it changes; the machine's processes by
// name (src/run/processes.ts); and the START line and start record of an overnight run.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Schema } from "effect"
import type { AccountProbe } from "../src/agent/Account.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { Start, version } from "../src/run/events.ts"
import type { KeepAwakePlan } from "../src/run/keepAwake.ts"
import { lidNote } from "../src/run/keepAwake.ts"
import { type Kernel, unknownKernel } from "../src/run/load.ts"
import type { Registration } from "../src/run/machine.ts"
import {
  batteryCheck,
  concurrencyCheck,
  type Found,
  headline,
  keepAwakeCheck,
  limitCheck,
  limitedNow,
  loadCheck,
  loginCheck,
  offeredConcurrency,
  otherRunsCheck,
  permissionCheck,
  ticketLimitCheck,
  usageWaitCheck,
  vmCheck,
  waitsOnlyOnQuestions,
} from "../src/run/overnight.ts"
import {
  gb,
  heaviest,
  largeVMs,
  memoryGB,
  type NamedProcess,
  parseNamed,
} from "../src/run/processes.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"

const config = (overrides: Partial<AppConfigValue> = {}): AppConfigValue =>
  TestAppConfig.appConfig({ overnight: true, keepAwake: true, ...overrides })

const withSettings = (change: (s: AppConfigValue["settings"]) => AppConfigValue["settings"]) => {
  const base = config()
  return { ...base, settings: change(base.settings) }
}

const startedOf = (c: AppConfigValue = config(), account?: AccountProbe): Started => ({
  config: c,
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: account ?? TestAccount.accountProbe(),
  organs: { _tag: "AgentSdk" },
  warnings: [],
})

/** What making `found`'s fix leaves of the run `started`. */
const fixed = (found: Found, started: Started = startedOf()): Started => {
  if (found.fix === undefined) throw new Error(`no fix: ${found.text}`)
  return Effect.runSync(found.fix.apply(started) as Effect.Effect<Started, string>)
}

describe("the failures", () => {
  test("a ticket limit fails, and its fix runs without one", () => {
    expect(limitCheck(config())).toEqual({ verdict: "passed", text: "no ticket limit" })
    const found = limitCheck(config({ limit: 10 }))
    expect(found).toMatchObject({
      verdict: "failed",
      text: "--limit 10 is set: the run would stop after 10 tickets",
      fix: { question: "Run without a limit?", done: "the run has no ticket limit" },
    })
    expect(fixed(found, startedOf(config({ limit: 10 }))).config.limit).toBeNull()
  })

  test("one ticket at a time fails, and its fix offers one for each 4 cores, 2 to 4, within the cap", () => {
    expect(offeredConcurrency(4, 0)).toBe(2)
    expect(offeredConcurrency(12, 0)).toBe(3)
    expect(offeredConcurrency(64, 0)).toBe(4)
    expect(offeredConcurrency(64, 3)).toBe(3)
    expect(offeredConcurrency(64, 2)).toBe(2)
    const two = withSettings((s) => ({ ...s, concurrent: 2 }))
    expect(concurrencyCheck(two, 10)).toEqual({ verdict: "passed", text: "2 tickets at a time" })
    const one = withSettings((s) => ({ ...s, concurrent: 1 }))
    const found = concurrencyCheck(one, 12)
    expect(found).toMatchObject({
      verdict: "failed",
      text: "1 ticket at a time (concurrent in .tutti/settings.json, --concurrent): one slow ticket would hold up the night",
      fix: { question: "Run 3 tickets at a time?", done: "the run works on 3 tickets at a time" },
    })
    expect(fixed(found, startedOf(one)).config.settings.concurrent).toBe(3)
    // A cap of 1 on the machine's workers leaves nothing to offer.
    expect(offeredConcurrency(64, 1)).toBe(1)
    const capped = concurrencyCheck({ ...one, machineWorkers: 1 }, 64)
    expect(capped.verdict).toBe("failed")
    expect(capped.fix).toBeUndefined()
    expect(capped.text).toEndWith(", and --machine-workers 1 allows no more")
  })

  test("a permission mode that asks fails, and its fix starts workers in auto", () => {
    const auto = TestAccount.accountProbe()
    // The probe asked again once the fix asks for auto: the mode Claude Code puts in effect.
    const probed: Array<string> = []
    const probeIn = (inEffect: string) => (c: AppConfigValue) =>
      Effect.sync(() => {
        probed.push(c.settings.workers.permission_mode)
        return { ...auto, permissionMode: { requested: "auto" as const, inEffect } }
      })
    const probe = probeIn("auto")
    expect(permissionCheck(auto, probe)).toEqual({
      verdict: "passed",
      text: "workers start in auto permission mode, which doesn't stop to ask",
    })
    const edits = { ...auto, permissionMode: { requested: "acceptEdits", inEffect: "acceptEdits" } }
    expect(permissionCheck(edits as AccountProbe, probe).verdict).toBe("passed")
    const asking = { ...auto, permissionMode: { requested: "default", inEffect: "default" } }
    const found = permissionCheck(asking as AccountProbe, probe)
    expect(found).toMatchObject({
      verdict: "failed",
      fix: {
        question: "Start workers in auto permission mode?",
        done: "workers start in auto permission mode",
      },
    })
    expect(found.text).toContain("whose permission prompts wait for someone")
    const asked = withSettings((s) => ({
      ...s,
      workers: { ...s.workers, permission_mode: "default" },
    }))
    const after = fixed(found, startedOf(asked, asking as AccountProbe))
    expect(after.config.settings.workers.permission_mode).toBe("auto")
    expect(after.account.permissionMode).toEqual({ requested: "auto", inEffect: "auto" })
    expect(probed).toEqual(["auto"])
    // Where auto isn't available, Claude Code says so, and the fix fixes nothing.
    const unavailableFix = permissionCheck(asking as AccountProbe, probeIn("default"))
    expect(
      Effect.runSync(
        Effect.flip(
          unavailableFix.fix?.apply(startedOf(asked, asking as AccountProbe)) as Effect.Effect<
            Started,
            string
          >,
        ),
      ),
    ).toBe("workers would still start in default permission mode: auto mode isn't available here")
    // Auto asked for but not in effect: nothing tutti can do.
    const unavailable = { ...auto, permissionMode: { requested: "auto", inEffect: "default" } }
    const stuck = permissionCheck(unavailable as AccountProbe, probe)
    expect(stuck.verdict).toBe("failed")
    expect(stuck.fix).toBeUndefined()
    expect(stuck.text).toContain("(auto mode isn't available here)")
  })

  test("--keep-awake turned off fails; a system with no keep-awake command warns", () => {
    const command: KeepAwakePlan = {
      _tag: "Command",
      command: { command: "caffeinate", args: ["-i", "-w", "1"] },
    }
    expect(keepAwakeCheck(config(), command)).toEqual({
      verdict: "passed",
      text: "the machine is kept awake while the run goes (caffeinate)",
    })
    const off = keepAwakeCheck(config({ keepAwake: false }), { _tag: "Off" })
    expect(off.verdict).toBe("failed")
    expect(off.text).toStartWith("--keep-awake is off: the machine would sleep in the night")
    expect(off.fix).toBeUndefined()
    const missing = keepAwakeCheck(config(), { _tag: "Missing", warning: "set it not to sleep" })
    expect(missing).toEqual({ verdict: "warned", text: "set it not to sleep" })
  })

  test("claude logged in passes, with the account", () => {
    const account = TestAccount.accountProbe()
    expect(loginCheck(account).verdict).toBe("passed")
    expect(
      loginCheck({
        ...account,
        account: { ...account.account, email: "me@example.com", subscriptionType: "Claude Max" },
      }).text,
    ).toBe("claude is logged in (me@example.com, Claude Max)")
  })
})

describe("the warnings", () => {
  test("a wait for the usage limit under 5h warns, and its fix waits 6h", () => {
    expect(usageWaitCheck(config()).verdict).toBe("passed")
    const zero = usageWaitCheck(config({ usageLimitWait: Duration.zero }))
    expect(zero).toMatchObject({
      verdict: "warned",
      text: "--usage-limit-wait is 0: the account's usage limit, reached in the night, would stop the run",
      fix: {
        question: "Wait up to 6h for the usage limit to reset?",
        done: "the run waits up to 6h for the usage limit to reset",
      },
    })
    const two = usageWaitCheck(config({ usageLimitWait: Duration.hours(2) }))
    expect(two.text).toStartWith("--usage-limit-wait is 2h, under the 5h the session limit takes")
    expect(fixed(two).config.usageLimitWait).toEqual(Duration.hours(6))
  })

  test("no ticket time limit warns, and its fix gives each ticket's worker 2h", () => {
    const found = ticketLimitCheck(config())
    expect(found).toMatchObject({
      verdict: "warned",
      fix: { question: "Give each ticket's worker 2h?", done: "each ticket's worker has 2h" },
    })
    expect(fixed(found).config.settings.workers.ticket_limit).toEqual(Duration.hours(2))
    const limited = withSettings((s) => ({
      ...s,
      workers: { ...s.workers, ticket_limit: Duration.minutes(90) },
    }))
    expect(ticketLimitCheck(limited)).toEqual({
      verdict: "passed",
      text: "each ticket's worker has 1h30m",
    })
  })

  test("the account at its usage limit says when it resets, and whether the wait runs out first", () => {
    const now = new Date(2026, 9, 25, 22, 0).getTime()
    const reset = new Date(2026, 9, 25, 23, 30).getTime()
    expect(limitedNow("five_hour", reset, Duration.hours(6), now)).toBe(
      "the account is at its five-hour limit now: no ticket starts until it resets, at 23:30, in 1h30m",
    )
    expect(limitedNow("five_hour", reset, Duration.hours(1), now)).toBe(
      "the account is at its five-hour limit now: no ticket starts until it resets, at 23:30, in 1h30m, after the run's wait for it (--usage-limit-wait 1h) runs out: the run would stop",
    )
    expect(limitedNow(null, null, Duration.hours(6), now)).toBe(
      "the account is at its account's usage limit now: no ticket starts until it resets",
    )
  })

  test("another run on the machine warns, named by its repository, PID and workers", () => {
    expect(otherRunsCheck([]).verdict).toBe("passed")
    const reg: Registration = {
      pid: 4242,
      repo: "/work/other",
      concurrent: 3,
      started: 0,
      running: 2,
      tool: "orchestra",
    }
    expect(otherRunsCheck([reg])).toEqual({
      verdict: "warned",
      text: "another run is going on the machine, a orchestra run in /work/other (PID 4242, 2 workers running, 3 tickets at a time): their workers and checks share the machine with the run's, and slow each other down",
    })
    expect(otherRunsCheck([reg, { ...reg, pid: 7, tool: "tutti" }]).text).toStartWith(
      "2 other runs are going on the machine, ",
    )
  })

  const kernel = (overrides: Partial<Kernel>): Kernel => ({
    ...unknownKernel,
    cores: 10,
    load1: 2,
    pressure: "normal",
    ...overrides,
  })
  const proc = (
    name: string,
    cpu: number,
    memory: number,
    pid = 100,
    parent = 1,
  ): NamedProcess => ({
    pid,
    parent,
    cpu,
    memory,
    name,
  })

  test("a busy machine warns, naming the 3 processes using the most", () => {
    expect(loadCheck(kernel({}), [])).toEqual({
      verdict: "passed",
      text: "the machine isn't busy: a load of 2.0 on 10 cores, memory pressure normal",
    })
    expect(loadCheck(undefined, undefined).verdict).toBe("warned")
    const all = [
      proc("cc1plus", 390, gb, 1),
      proc("node", 120, 3 * gb, 2),
      proc("bun", 80, 2 * gb, 3),
      proc("idle", 0, 0, 4),
    ]
    const busy = loadCheck(kernel({ load1: 23.4 }), all)
    expect(busy.verdict).toBe("warned")
    expect(busy.text).toBe(
      "the machine is busy, a load of 23.4 on 10 cores, memory pressure normal (most of it cc1plus 390%, node 120% and bun 80%): the workers and their checks would run slowly. Quit what the run doesn't need",
    )
    const short = loadCheck(kernel({ pressure: "warn" }), all)
    expect(short.text).toStartWith(
      "memory is short (the kernel's memory pressure is warn), most of it held by node 3.0 GB, bun 2.0 GB and cc1plus 1.0 GB",
    )
  })

  test("a virtual machine holding over 4 GB warns, named as orchestra names them", () => {
    expect(vmCheck(undefined).verdict).toBe("warned")
    expect(vmCheck([proc("node", 1, gb)])).toEqual({
      verdict: "passed",
      text: "no virtual machine holds more than 4.0 GB of memory",
    })
    const docker = [
      proc("com.docker.backend", 1, gb, 30),
      proc("com.apple.Virtualization.VirtualMachine", 5, 8 * gb, 40),
    ]
    expect(largeVMs(docker)).toEqual([
      "a virtual machine holds 8.0 GB of memory (com.apple.Virtualization.VirtualMachine, PID 40); Docker Desktop is running",
    ])
    const under = [proc("OrbStack", 1, gb, 30), proc("qemu-system-aarch64", 5, 12 * gb, 41, 30)]
    expect(largeVMs(under)).toEqual([
      "OrbStack's virtual machine holds 12 GB of memory (qemu-system-aarch64, PID 41)",
    ])
    expect(vmCheck(under).verdict).toBe("warned")
  })

  test("on battery warns, with its level and the lid's note", () => {
    expect(batteryCheck(null, "darwin")).toEqual({
      verdict: "passed",
      text: "the machine has no battery",
    })
    expect(batteryCheck({ level: 80, discharging: false }, "darwin")).toEqual({
      verdict: "passed",
      text: "the machine is plugged in (80%)",
    })
    expect(batteryCheck(undefined, "darwin").verdict).toBe("warned")
    expect(batteryCheck({ level: 62, discharging: true }, "darwin")).toEqual({
      verdict: "warned",
      text: `on battery (62%): plug it in, or the run goes only as long as the battery; ${lidNote("darwin")}`,
    })
  })

  test("a ticket waits only on questions when each blocker not closed is one", () => {
    const issue = (overrides: Partial<Issue>): Issue =>
      ({
        id: "t-1" as TicketId,
        status: "open",
        labels: [],
        dependencies: [],
        ...overrides,
      }) as Issue
    const question = issue({ id: "q-1" as TicketId, labels: ["human"] })
    const work = issue({ id: "w-1" as TicketId })
    const closed = issue({ id: "w-2" as TicketId, status: "closed" })
    const blocks = (on: Issue) => ({ id: on.id, type: "blocks", issue: on })
    expect(waitsOnlyOnQuestions(issue({ dependencies: [blocks(question)] }))).toBe(true)
    expect(waitsOnlyOnQuestions(issue({ dependencies: [blocks(question), blocks(closed)] }))).toBe(
      true,
    )
    expect(waitsOnlyOnQuestions(issue({ dependencies: [blocks(question), blocks(work)] }))).toBe(
      false,
    )
    expect(waitsOnlyOnQuestions(issue({}))).toBe(false)
    expect(
      waitsOnlyOnQuestions(issue({ status: "closed", dependencies: [blocks(question)] })),
    ).toBe(false)
  })
})

describe("the checklist", () => {
  test("its first line counts the failures, the warnings and the passes", () => {
    const of = (verdict: Found["verdict"]): Found => ({ verdict, text: verdict })
    expect(headline([of("failed"), of("warned"), of("warned"), of("passed")])).toBe(
      "Overnight pre-flight: 1 failed, 2 warnings, 1 passed",
    )
    expect(headline([of("passed")])).toBe("Overnight pre-flight: 1 passed")
    expect(headline([of("warned"), of("passed")])).toBe("Overnight pre-flight: 1 warning, 1 passed")
  })
})

describe("the machine's processes by name", () => {
  test("ps's listing, macOS's paths read as their base names", () => {
    expect(
      parseNamed(
        "  1     0  12000   0.0 /sbin/launchd\n 40    1 8388608 5,5 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine\n 77 1 100 1.0 kworker/0:1\n",
      ),
    ).toEqual([
      { pid: 1, parent: 0, memory: 12000 * 1024, cpu: 0, name: "launchd" },
      {
        pid: 40,
        parent: 1,
        memory: 8388608 * 1024,
        cpu: 5.5,
        name: "com.apple.Virtualization.VirtualMachine",
      },
      { pid: 77, parent: 1, memory: 100 * 1024, cpu: 1, name: "kworker/0:1" },
    ])
    expect(parseNamed("1 0 12 0.0\n")).toBeUndefined()
    expect(parseNamed("x 0 12 0.0 sh\n")).toBeUndefined()
  })

  test("the heaviest leave out what weighs nothing, and memory reads in GB", () => {
    const all = [
      { pid: 1, parent: 0, memory: 0, cpu: 0, name: "a" },
      { pid: 2, parent: 0, memory: 0, cpu: 3, name: "b" },
    ]
    expect(
      heaviest(
        all,
        3,
        (p) => p.cpu,
        (p) => p.name,
      ),
    ).toEqual(["b"])
    expect(memoryGB(1.5 * gb)).toBe("1.5 GB")
    expect(memoryGB(12.7 * gb)).toBe("12 GB")
  })
})

describe("an overnight run's start", () => {
  test("its START line ends · overnight after the scope", () => {
    const overnight = config({ ticket: "tut-1" as TicketId, autoAnswer: Duration.zero })
    const [line] = startBlock(startedOf(overnight), "0.1.0")
    expect(line).toStartWith(
      "START tutti 0.1.0 in /work/project on main · ticket tut-1 · overnight (limit: none,",
    )
    expect(line).toEndWith(" · auto-answer")
    const [plain] = startBlock(startedOf(config({ overnight: false })), "0.1.0")
    expect(plain).not.toContain("overnight")
  })

  test("its start record has overnight: true", () => {
    const record = {
      v: version,
      kind: "start",
      time: "2026-10-25T23:00:00.000+02:00",
      run: "2026-10-25T23:00:00.000+02:00",
      version: "0.1.0",
      repo: "/work/project",
      branch: "main",
      concurrency: 2,
      billing: "subscription",
      permission_mode: "auto",
      overnight: true,
    }
    expect(Schema.decodeUnknownSync(Start)(record)).toMatchObject({ overnight: true })
    expect(() => Schema.decodeUnknownSync(Start)({ ...record, overnight: false })).toThrow()
  })
})
