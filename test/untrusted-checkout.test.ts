import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import {
  Account,
  type AccountError,
  type AccountProbe,
  ignoredAllowFile,
  ignoresAllowRules,
  readInitialization,
  UntrustedCheckout,
  untrustedFilesIn,
} from "../src/agent/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { live } from "./gates.ts"

/** The line Claude Code 2.1.301 writes to stderr (docs/spikes/01-sdk-session.md, item 6). */
const untrustedLine =
  'Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/work/project"].hasTrustDialogAccepted: true in /home/me/.claude.json.'

const trustMessage = (files: string) =>
  `Claude Code ignores the permissions.allow rules in ${files}: /work/project isn't trusted. Run claude once in /work/project and accept the trust dialog, or run tutti init to mark it trusted.`

describe("the untrusted-checkout line", () => {
  test("is Claude Code's line, naming its file", () => {
    expect(ignoresAllowRules(untrustedLine)).toBe(true)
    expect(ignoredAllowFile(untrustedLine)).toBe(".claude/settings.json")
  })

  test("matches whatever the count, file or punctuation", () => {
    const line =
      "Ignoring 3 permissions.allow entries from /work/project/.claude/settings.local.json - this workspace has not been trusted"
    expect(ignoresAllowRules(line)).toBe(true)
    expect(ignoresAllowRules("permissions.allow ignored; not been trusted")).toBe(true)
    expect(ignoredAllowFile("permissions.allow ignored; not been trusted")).toBe(null)
  })

  test("needs both parts in one line", () => {
    expect(ignoresAllowRules("Ignoring 1 permissions.allow entry from .claude/settings.json")).toBe(
      false,
    )
    expect(ignoresAllowRules("this workspace has not been trusted")).toBe(false)
    expect(untrustedFilesIn("Ignoring 1 permissions.allow entry\nhas not been trusted\n")).toEqual(
      [],
    )
  })

  test("reads every line of the stderr, each file once", () => {
    const stderr = [
      "Some warning",
      untrustedLine,
      untrustedLine.replace("settings.json", "settings.local.json"),
      untrustedLine,
      "",
    ].join("\r\n")
    expect(untrustedFilesIn(stderr)).toEqual([
      ".claude/settings.json",
      ".claude/settings.local.json",
    ])
    expect(untrustedFilesIn("")).toEqual([])
  })

  test("matches any line with both parts, whatever is around them", () => {
    const noNewline = fc.string().map((s) => s.replace(/[\r\n]/g, " "))
    fc.assert(
      fc.property(
        noNewline,
        noNewline,
        noNewline,
        fc.boolean(),
        (before, between, after, swapped) => {
          const [first, second] = swapped
            ? ["not been trusted", "permissions.allow"]
            : ["permissions.allow", "not been trusted"]
          const line = `${before}${first}${between}${second}${after}`
          expect(ignoresAllowRules(line)).toBe(true)
          expect(untrustedFilesIn(`noise\n${line}\nnoise`)).toHaveLength(1)
        },
      ),
    )
  })

  test("never matches a line without both parts", () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        fc.pre(!line.includes("permissions.allow") || !line.includes("not been trusted"))
        expect(ignoresAllowRules(line)).toBe(false)
      }),
    )
  })

  test("names the file of a line in Claude Code's shape", () => {
    const file = fc
      .string({ minLength: 1 })
      .filter((s) => !/[\r\n]|:\s/.test(s) && !s.endsWith(":") && s.trim() === s && s !== "")
    fc.assert(
      fc.property(fc.nat(), file, fc.string(), (count, name, tail) => {
        const line = `Ignoring ${count} permissions.allow entries from ${name}: this workspace has not been trusted.${tail.replace(/[\r\n]/g, "")}`
        expect(ignoredAllowFile(line)).toBe(name)
      }),
    )
  })

  test("never throws, whatever it reads", () => {
    fc.assert(
      fc.property(fc.string(), (stderr) => {
        const files = untrustedFilesIn(stderr)
        expect(new Set(files).size).toBe(files.length)
      }),
    )
  })
})

describe("UntrustedCheckout", () => {
  test("names the files and the main checkout, and how to trust it", () => {
    const one = new UntrustedCheckout({
      checkout: "/work/project",
      files: [".claude/settings.json"],
    })
    expect(one.message).toBe(trustMessage(".claude/settings.json"))
    const two = new UntrustedCheckout({
      checkout: "/work/project",
      files: [".claude/settings.json", null],
    })
    expect(two.message).toBe(trustMessage(".claude/settings.json, the project's settings"))
  })
})

const subscriptionInit = {
  account: {
    email: "maintainer@example.com",
    subscriptionType: "Claude Max",
    apiProvider: "firstParty",
  },
  current_permission_mode: "auto",
}

/** The probe's result, its session saying `init` and `settings`, and writing `stderr`. */
const probe = (init: unknown, stderr: string, settings?: unknown) =>
  Effect.runPromise(
    Effect.exit(
      Effect.gen(function* () {
        return yield* (yield* Account).probe
      }).pipe(
        Effect.provide(
          Account.layerWith(() => Effect.sync(() => readInitialization(init, settings, stderr)), {
            PATH: "/usr/bin",
          }).pipe(Layer.provide(TestAppConfig.layer())),
        ),
      ),
    ),
  )

const failures = (exit: Exit.Exit<AccountProbe, AccountError>): Array<AccountError> => {
  if (Exit.isSuccess(exit)) throw new Error("the probe succeeded")
  return exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))
}

describe("the probe", () => {
  test("an untrusted main checkout is a setup problem", async () => {
    const [error, ...rest] = failures(await probe(subscriptionInit, `${untrustedLine}\n`))
    expect(rest).toEqual([])
    expect(error).toBeInstanceOf(UntrustedCheckout)
    expect((error as UntrustedCheckout).checkout).toBe("/work/project")
    expect(error?.message).toBe(trustMessage(".claude/settings.json"))
  })

  test("other stderr is no problem", async () => {
    const exit = await probe(subscriptionInit, "Debugger attached.\nsome warning\n")
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("reports it with the other probe problems at once", async () => {
    const noLogin = { account: { tokenSource: "none", apiProvider: "firstParty" } }
    const broken = {
      errors: [{ file: "/home/me/.claude/settings.json", path: "", message: "Invalid JSON" }],
    }
    const errors = failures(await probe(noLogin, untrustedLine, broken))
    expect(errors.map((error) => error._tag)).toEqual([
      "NotLoggedIn",
      "SettingsUnreadable",
      "UntrustedCheckout",
    ])
  })
})

live.describe("the live probe in an untrusted main checkout", () => {
  test(
    "Claude Code says it ignores the project's allow rules",
    async () => {
      // A temp repository no one has trusted, its settings allowing one command.
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-untrusted-")))
      Bun.spawnSync(["git", "init", "-q", repo])
      mkdirSync(join(repo, ".claude"))
      writeFileSync(
        join(repo, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Bash(echo hi)"] } }),
      )
      const exit = await Effect.runPromise(
        Effect.exit(
          Effect.gen(function* () {
            return yield* (yield* Account).probe
          }).pipe(
            Effect.provide(
              Account.layer.pipe(
                Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({}, repo))),
              ),
            ),
          ),
        ),
      )
      const untrusted = failures(exit).find(
        (error): error is UntrustedCheckout => error instanceof UntrustedCheckout,
      )
      expect(untrusted?.checkout).toBe(repo)
      expect(untrusted?.files).toEqual([".claude/settings.json"])
    },
    { timeout: 90_000 },
  )
})
