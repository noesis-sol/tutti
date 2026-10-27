// tutti init and init --update keep .tutti/settings.json's own formatting where they change a key
// (§ 8.3): src/project/jsonText.ts edits the keys that change in the file's text, and leaves the
// rest of it, its indentation, its one-line sections and its line endings, as it was.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Duration, Effect, Exit } from "effect"
import fc from "fast-check"
import { type InitFlags, init } from "../src/init/init.ts"
import type { Machine } from "../src/init/steps.ts"
import { currentTemplates } from "../src/init/templates.ts"
import { updateTemplates } from "../src/init/update.ts"
import { setIn } from "../src/project/jsonText.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

type Json = Record<string, unknown>

/** `json` with `value` at `path`, as init sets it: each key on the way made an object. */
const setInJson = (json: Json, path: ReadonlyArray<string>, value: unknown): Json => {
  const copy: Json = structuredClone(json)
  let holder = copy
  for (const [depth, key] of path.entries()) {
    const own = Object.hasOwn(holder, key) ? holder[key] : undefined
    const next =
      depth === path.length - 1
        ? value
        : typeof own === "object" && own !== null && !Array.isArray(own)
          ? own
          : {}
    Object.defineProperty(holder, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    holder = next as Json
  }
  return copy
}

describe("setIn", () => {
  const settings = `{
    "concurrent": 1,
    "checks": {
        "fast": { "command": null, "timeout": "30m" },
        "full": { "command": null, "timeout": "60m" }
    },
    "workers": { "mcp_servers": [] }
}
`

  test("a value replaced changes only that value", () => {
    expect(setIn(settings, ["concurrent"], 3)).toBe(
      settings.replace('"concurrent": 1', '"concurrent": 3'),
    )
    expect(setIn(settings, ["checks", "full", "timeout"], "90m")).toBe(
      settings.replace('"60m"', '"90m"'),
    )
  })

  test("an array on one line stays on one line", () => {
    expect(setIn(settings, ["workers", "mcp_servers"], ["chrome", "beads"])).toBe(
      settings.replace('"mcp_servers": []', '"mcp_servers": ["chrome", "beads"]'),
    )
  })

  test("a key added to a one-line object goes on its line", () => {
    expect(setIn(settings, ["checks", "fast", "max_attempts"], 2)).toBe(
      settings.replace('"30m" }', '"30m", "max_attempts": 2 }'),
    )
  })

  test("a key added to an object spread over lines goes on a line of its own, indented as its keys", () => {
    expect(setIn(settings, ["checks", "setup"], { command: "bun install" })).toBe(
      settings.replace(
        '"60m" }\n    },',
        '"60m" },\n        "setup": {\n            "command": "bun install"\n        }\n    },',
      ),
    )
  })

  test("a missing section is made at the end, in the file's indentation", () => {
    const tabs = '{\n\t"concurrent": 1\n}\n'
    expect(setIn(tabs, ["templates", "worker_prompt"], 4)).toBe(
      '{\n\t"concurrent": 1,\n\t"templates": {\n\t\t"worker_prompt": 4\n\t}\n}\n',
    )
  })

  test("an empty object takes its object's layout", () => {
    expect(setIn('{\n  "a": 1,\n  "b": {}\n}', ["b", "c"], true)).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": true\n  }\n}',
    )
    expect(setIn('{ "a": 1, "b": {} }', ["b", "c"], true)).toBe('{ "a": 1, "b": { "c": true } }')
    expect(setIn("{}", ["a"], 1)).toBe('{\n  "a": 1\n}')
  })

  test("a key given twice is set where JSON.parse reads it, the last", () => {
    expect(setIn('{ "a": 1, "b": 2, "a": 3 }', ["a"], 4)).toBe('{ "a": 1, "b": 2, "a": 4 }')
    expect(setIn('{ "a": 1, "b": 2, "a": 3 }', ["c"], 4)).toBe('{ "a": 1, "b": 2, "a": 3, "c": 4 }')
  })

  test("Windows line endings are kept", () => {
    const crlf = '{\r\n  "a": 1\r\n}\r\n'
    expect(setIn(crlf, ["b"], [1])).toBe('{\r\n  "a": 1,\r\n  "b": [\r\n    1\r\n  ]\r\n}\r\n')
  })

  test("strings with quotes, braces and escapes in them are read past", () => {
    const text = '{ "a\\"}": "x\\\\", "b": "{\\"c\\": 1}" }'
    expect(JSON.parse(setIn(text, ["b"], 2))).toEqual({ 'a"}': "x\\", b: 2 })
    expect(JSON.parse(setIn(text, ['a"}'], 2))).toEqual({ 'a"}': 2, b: '{"c": 1}' })
  })

  // A few keys, so that paths meet the document's keys, and any string, to read past.
  const key = fc.oneof(fc.constantFrom("a", "b", "c"), fc.string({ maxLength: 4 }))
  const documents = fc.dictionary(
    key,
    fc.oneof(fc.jsonValue({ maxDepth: 2 }), fc.dictionary(key, fc.jsonValue({ maxDepth: 2 }))),
  )
  const layouts = fc.record({
    indent: fc.constantFrom(0, 2, 4, "\t"),
    crlf: fc.boolean(),
    trailing: fc.constantFrom("", "\n", "  \n"),
  })

  test("the text holds what the object would with the value set", () => {
    fc.assert(
      fc.property(
        documents,
        layouts,
        fc.array(key, { minLength: 1, maxLength: 3 }),
        fc.jsonValue({ maxDepth: 2 }),
        (document, { indent, crlf, trailing }, path, value) => {
          const json: Json = JSON.parse(JSON.stringify(document))
          const plain = `${JSON.stringify(json, null, indent)}${trailing}`
          const text = crlf ? plain.replaceAll("\n", "\r\n") : plain
          const edited = setIn(text, path, value)
          const expected = JSON.parse(JSON.stringify(setInJson(json, path, value)))
          expect(JSON.parse(edited)).toEqual(expected)
        },
      ),
    )
  })
})

/** A temp repository whose .tutti/settings.json is `text`, with a worker prompt and a home. */
const projectWith = (text: string, prompt = "Ours: TICKET_ID\n") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-settings-formatting-")))
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(join(repo, ".tutti"))
  mkdirSync(home)
  writeFileSync(join(repo, ".tutti/settings.json"), text)
  writeFileSync(join(repo, ".tutti/worker-prompt.md"), prompt)
  return { repo, commonDir: join(repo, ".git"), home }
}

type Project = ReturnType<typeof projectWith>

const read = (project: Project) => readFileSync(join(project.repo, ".tutti/settings.json"), "utf8")

const machineFor = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

const runInit = async (project: Project, flags: InitFlags) => {
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags,
        form: null,
        scout: Effect.fail("there is no scout in these tests"),
        machine: machineFor(project),
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

/** Settings in the project's own formatting (not init's), every check's key there. */
const ours = `{
    "concurrent": 1,
    "checks": {
        "fast": { "command": "scripts/check-fast.sh", "timeout": "30m" },
        "full": { "command": "scripts/check-full.sh", "timeout": "60m" }
    },
    "workers": { "mcp_servers": [] }
}
`

describe("init over settings in the project's own formatting", () => {
  test("changing the concurrency changes that line alone", async () => {
    const project = projectWith(ours)
    await runInit(project, { force: false, mcp: [], changelogUnion: false, concurrent: 3 })
    expect(read(project)).toBe(ours.replace('"concurrent": 1', '"concurrent": 3'))
  })

  test("a check's time limit changes in its one-line section", async () => {
    const project = projectWith(ours)
    await runInit(project, {
      force: false,
      mcp: [],
      changelogUnion: false,
      checkFullTimeout: Duration.minutes(45),
    })
    expect(read(project)).toBe(ours.replace('"60m"', '"45m"'))
  })
})

describe("init --update over settings in the project's own formatting", () => {
  test("recording the templates' versions rewrites the templates' section alone", async () => {
    const before = `{
    "concurrent": 2,
    "keep_awake": true,
    "templates": { "worker_prompt": ${currentTemplates.worker_prompt}, "check_suite_skill": 1 },
    "workers": { "mcp_servers": [] }
}
`
    const project = projectWith(before, builtInWorkerPrompt)
    await Effect.runPromise(updateTemplates(project.repo).pipe(Effect.provide(BunServices.layer)))
    expect(read(project)).toBe(
      before.replace(
        /"templates": \{[^}]*\}/,
        `"templates": { "worker_prompt": ${currentTemplates.worker_prompt} }`,
      ),
    )
  })
})
