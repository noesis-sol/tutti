// scripts/test.sh kills the bun test workers a run killed outright left running (scripts/test.ts's
// killLeftWorkers): those whose TMPDIR is the temp folder of a run whose process has gone. A live
// run's workers, and other processes, are left alone.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import {
  killLeftWorkers,
  leftWorkers,
  parsePsEnvironment,
  testWorkerCommand,
  type UserProcess,
  userProcesses,
} from "../scripts/test.ts"
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"

const worker = "/opt/homebrew/Cellar/bun/1.4.3/bin/bun test --test-worker --isolate --timeout=15000"

const process_ = (pid: number, command: string, tmpdir?: string): UserProcess => ({
  pid,
  command,
  tmpdir,
})

describe("parsePsEnvironment", () => {
  test("reads the PID, the command line and the last TMPDIR of each line", () => {
    const text = [
      `  501 ${worker} NODE_ENV=test TMPDIR=/tmp/tutti-test-38245-AbC123 HOME=/Users/me`,
      "  502 /bin/zsh -l TMPDIR=/var/folders/x/T/ PATH=/bin TMPDIR=/tmp/later",
      "  503 sleep 60",
      "not a process",
      "",
    ].join("\n")
    expect(parsePsEnvironment(text)).toEqual([
      process_(
        501,
        `${worker} NODE_ENV=test TMPDIR=/tmp/tutti-test-38245-AbC123 HOME=/Users/me`,
        "/tmp/tutti-test-38245-AbC123",
      ),
      process_(
        502,
        "/bin/zsh -l TMPDIR=/var/folders/x/T/ PATH=/bin TMPDIR=/tmp/later",
        "/tmp/later",
      ),
      process_(503, "sleep 60"),
    ])
  })

  test("reads back any line's PID and TMPDIR", () => {
    const word = fc.stringMatching(/^[^\s]+$/)
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99999 }),
        fc.stringMatching(/^[^\n]*$/),
        word,
        (pid, command, tmpdir) => {
          const [read] = parsePsEnvironment(` ${pid} ${command} TMPDIR=${tmpdir}`)
          expect(read?.pid).toBe(pid)
          expect(read?.tmpdir).toBe(tmpdir)
        },
      ),
    )
  })
})

describe("testWorkerCommand", () => {
  test("is a bun test --parallel worker's command line, wherever bun is", () => {
    expect(testWorkerCommand(worker)).toBe(true)
    expect(testWorkerCommand("bun test --test-worker")).toBe(true)
  })

  test("is no other command's", () => {
    for (const command of [
      "bun test --parallel=6",
      "bun scripts/test.ts",
      "grep bun test --test-worker",
      "/usr/bin/mybun test --test-worker",
      "bun test --test-workers",
    ]) {
      expect(testWorkerCommand(command)).toBe(false)
    }
  })
})

describe("leftWorkers", () => {
  const processes = [
    process_(501, worker, "/tmp/tutti-test-111-aaaaaa"),
    process_(502, worker, "/tmp/tutti-test-111-aaaaaa/"),
    process_(503, worker, "/elsewhere/tutti-test-333-cccccc"),
    // A live run's.
    process_(601, worker, "/tmp/tutti-test-222-bbbbbb"),
    // This run's own.
    process_(602, worker, `/tmp/tutti-test-${process.pid}-dddddd`),
    // A worker of no run of scripts/test.sh's, a process that is no worker, a worker without TMPDIR.
    process_(603, worker, "/var/folders/x/T/"),
    process_(604, "sleep 60", "/tmp/tutti-test-111-aaaaaa"),
    process_(605, worker),
  ]

  test("are the workers of runs that have ended, by run", () => {
    const left = leftWorkers(processes, (pid) => pid === 222)
    expect([...left]).toEqual([
      [111, [501, 502]],
      [333, [503]],
    ])
  })

  test("are none while every run is live", () => {
    expect(leftWorkers(processes, () => true).size).toBe(0)
  })
})

describe("killLeftWorkers", () => {
  test("kills the workers of ended runs only, and says so for each run", () => {
    const killed: Array<number> = []
    const lines = killLeftWorkers(
      [
        process_(501, worker, "/tmp/tutti-test-111-aaaaaa"),
        process_(502, worker, "/tmp/tutti-test-111-aaaaaa"),
        process_(503, worker, "/tmp/tutti-test-333-cccccc"),
        process_(601, worker, "/tmp/tutti-test-222-bbbbbb"),
      ],
      (pid) => pid === 222,
      (pid) => {
        killed.push(pid)
        return true
      },
    )
    expect(killed).toEqual([501, 502, 503])
    expect(lines).toEqual([
      "scripts/test.sh: killed 2 test workers left by an earlier run (pid 111)",
      "scripts/test.sh: killed 1 test worker left by an earlier run (pid 333)",
    ])
  })

  test("counts only the workers it could kill", () => {
    const lines = killLeftWorkers(
      [
        process_(501, worker, "/tmp/tutti-test-111-aaaaaa"),
        process_(502, worker, "/tmp/tutti-test-111-aaaaaa"),
        process_(503, worker, "/tmp/tutti-test-333-cccccc"),
      ],
      () => false,
      (pid) => pid === 501,
    )
    expect(lines).toEqual([
      "scripts/test.sh: killed 1 test worker left by an earlier run (pid 111)",
    ])
  })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether `check` holds within `ms`. */
const within = async (check: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await Bun.sleep(50)
  }
  return check()
}

const pidIn = async (file: string): Promise<number> => {
  if (!(await within(() => existsSync(file), 30000))) throw new Error(`${file} never appeared`)
  return Number(readFileSync(file, "utf8").trim())
}

describe("a run's leaked test worker", () => {
  slow.test(
    "is killed by the next run once its run has gone",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tutti-left-workers-"))
      const ended = Bun.spawnSync(["true"]).pid
      const temp = join(dir, `tutti-test-${ended}-AbC123`)
      mkdirSync(temp)
      // Each test writes its worker's PID, then spins in synchronous code: a worker that waits
      // goes once its coordinator has gone, and one that spins never sees it go.
      for (const name of ["one", "two"]) {
        writeFileSync(
          join(dir, `${name}.test.ts`),
          [
            'import { test } from "bun:test"',
            'import { writeFileSync } from "node:fs"',
            `test("${name}", () => {`,
            `  writeFileSync(\`\${import.meta.dir}/${name}.pid\`, String(process.pid))`,
            "  while (true) {}",
            "})",
          ].join("\n"),
        )
      }
      const run = Bun.spawn([process.execPath, "test", "--parallel=2", "--timeout=600000"], {
        cwd: dir,
        env: { ...testEnv, TMPDIR: temp },
        stdout: "ignore",
        stderr: "ignore",
      })
      const workers = [await pidIn(join(dir, "one.pid")), await pidIn(join(dir, "two.pid"))]
      try {
        // bun test killed outright leaves its workers running.
        run.kill("SIGKILL")
        await run.exited
        await Bun.sleep(300)
        expect(workers.every(alive)).toBe(true)
        const mine = userProcesses().filter((p) => workers.includes(p.pid))
        expect(mine.map((p) => p.tmpdir)).toEqual([temp, temp])
        expect(killLeftWorkers(mine)).toEqual([
          `scripts/test.sh: killed 2 test workers left by an earlier run (pid ${ended})`,
        ])
        expect(await within(() => !workers.some(alive), 3000)).toBe(true)
      } finally {
        for (const pid of workers) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            // Gone.
          }
        }
      }
    },
    60000,
  )
})
