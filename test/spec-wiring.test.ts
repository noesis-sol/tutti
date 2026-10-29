// What src/main.ts does with a spec run (§ 4.14), in the pieces it calls: the setup of a repository
// init hasn't set up (specSetup), none for a spec the run can't read and the setup an earlier run
// left uncommitted taken again; the run scoped to the root epic, with the spec's path (scopedTo);
// and an early start's breakdown stopping the run once it fails (followRest).
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AppConfig } from "../src/cli/AppConfig.ts"
import { scopedTo } from "../src/run/feature.ts"
import { followRest, SpecOutcome } from "../src/run/specRun.ts"
import { leftSetupLine, settingUpLine, specSetup } from "../src/run/specSetup.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"

/** A fresh main checkout with `files` on disk; git, in memory, has only README.md. */
const checkout = (files: Readonly<Record<string, string>> = {}) => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-wiring-"))), "repo")
  mkdirSync(repo)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  return repo
}

/** The setup run in `repo`, its working tree holding `work`, `setUp` writing `wrote`. */
const setUp = (
  repo: string,
  options: {
    readonly spec?: string | null
    readonly work?: Readonly<Record<string, string>>
    readonly wrote?: Readonly<Record<string, string>>
    readonly fails?: number
  } = {},
) => {
  const said: Array<string> = []
  let ran = 0
  return Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Repository
      yield* git.write(repo, options.work ?? {})
      const files = yield* specSetup({
        cwd: repo,
        spec: options.spec === null ? null : { given: options.spec ?? "shop.md", from: "--spec" },
        ownPrompt: false,
        setUp: Effect.gen(function* () {
          ran += 1
          yield* git.write(repo, options.wrote ?? {})
          return options.fails ?? 0
        }),
        say: (text) => Effect.sync(() => void said.push(text)),
      })
      return { files, said, ran }
    }).pipe(Effect.provide(Layer.mergeAll(memoryGit({ dir: repo }), BunServices.layer))),
  )
}

describe("a spec run's setup", () => {
  test("sets a repository init hasn't set up up, the files it wrote for the commit", async () => {
    const repo = checkout({ "shop.md": "# Shop\n" })
    const wrote = { ".tutti/settings.json": "{}\n", "scripts/check-fast.sh": "exit 0\n" }
    const done = await setUp(repo, { work: { "shop.md": "# Shop\n" }, wrote })
    expect(done).toEqual({
      files: [".tutti/settings.json", "scripts/check-fast.sh"],
      said: [settingUpLine],
      ran: 1,
    })
  })

  test("sets nothing up without a spec, or for one it can't read: the checks say why", async () => {
    const repo = checkout()
    expect(await setUp(repo, { spec: null })).toEqual({ files: [], said: [], ran: 0 })
    expect(await setUp(repo, { spec: "nope.md" })).toEqual({ files: [], said: [], ran: 0 })
  })

  test("a setup that fails, or whose form is cancelled, is the exit code the run ends with", async () => {
    const repo = checkout({ "shop.md": "# Shop\n" })
    expect((await setUp(repo, { fails: 2 })).files).toBe(2)
    expect((await setUp(repo, { fails: 130 })).files).toBe(130)
  })

  test("takes the setup an earlier spec run left uncommitted, to commit with the spec", async () => {
    const left = {
      ".tutti/settings.json": "{}\n",
      ".tutti/worker-prompt.md": "Work on TICKET_ID.\n",
      "scripts/check-fast.sh": "exit 0\n",
    }
    const repo = checkout(left)
    const done = await setUp(repo, { work: { ...left, "notes.txt": "mine\n" } })
    expect(done).toEqual({
      files: [".tutti/settings.json", ".tutti/worker-prompt.md", "scripts/check-fast.sh"],
      said: [leftSetupLine],
      ran: 0,
    })
  })

  test("a repository set up and committed needs nothing", async () => {
    const repo = checkout({ ".tutti/settings.json": "{}\n" })
    const done = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Repository
        yield* git.commit(repo, "set up", { ".tutti/settings.json": "{}\n" })
        return yield* specSetup({
          cwd: repo,
          spec: { given: "shop.md", from: "--spec" },
          ownPrompt: false,
          setUp: Effect.succeed(0),
          say: () => Effect.void,
        })
      }).pipe(Effect.provide(Layer.mergeAll(memoryGit({ dir: repo }), BunServices.layer))),
    )
    expect(done).toEqual([])
  })
})

describe("the run a spec run's start scopes", () => {
  test("is scoped to the root epic, with the spec's path", async () => {
    const config = await Effect.runPromise(
      scopedTo(
        "shop-1" as TicketId,
        ".tutti/specs/shop.md",
      )(
        Effect.gen(function* () {
          return yield* AppConfig
        }),
      ).pipe(Effect.provide(configLayer(appConfig({}, "/work/shop")))),
    )
    expect(config.ticket).toBe("shop-1" as TicketId)
    expect(config.specPath).toBe(".tutti/specs/shop.md")
  })

  test("is stopped, with the breakdown's exit code, by an early start's breakdown that fails", async () => {
    const stopped: Array<number> = []
    const stop = (code: number) => Effect.sync(() => void stopped.push(code))
    await Effect.runPromise(followRest(Effect.succeed(SpecOutcome.Stopped({ exitCode: 2 })), stop))
    await Effect.runPromise(
      followRest(Effect.succeed(SpecOutcome.Run({ root: "shop-1" as TicketId })), stop),
    )
    expect(stopped).toEqual([2])
  })
})
