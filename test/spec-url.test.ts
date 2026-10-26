// A spec at a web URL (§ 4.14), tutti's addition to --spec: fetched over https through the HttpClient
// (its test layer here), a GitHub file page as its raw file and a private one through gh (stub
// scripts), checked as a file is and refused where it can't be a spec, and committed as a copy that
// records its URL without the query (real git); a copy's name, and a GitHub page's raw URL, from any
// URL text.
import { beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { noServersNote } from "../src/agent/mcp.ts"
import { Start } from "../src/run/events.ts"
import { commitSpec, readSpec, type Spec, sourceOf } from "../src/run/spec.ts"
import {
  copyName,
  type Fetched,
  fetchOnce,
  fetchSpec,
  githubFile,
  type LiveFetch,
  maxSpecBytes,
  type SpecFetch,
  specUrl,
} from "../src/run/specSource.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"
import { type Answer, layer as httpLayer, redirect, type Sent } from "../src/testing/HttpClient.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const raw = "https://raw.githubusercontent.com/shop/app/main/docs/shop.md"
const page = "https://github.com/shop/app/blob/main/docs/shop.md"

/** The gh stubs, written once for the file: macOS scans a new executable the first time it runs. */
let gh: { readonly reads: string; readonly loggedOut: string; readonly missing: string }

beforeAll(() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-url-gh-")))
  const stub = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }
  gh = {
    // Answers only the contents API with the raw media type, as gh would for the private file.
    reads: stub(
      "gh-reads",
      `[ "$1 $2 $3 $4" = "api repos/shop/app/contents/docs/shop.md?ref=main -H Accept: application/vnd.github.raw" ] || { echo "unexpected: $*" >&2; exit 1; }\nprintf '# Private shop\\n'`,
    ),
    loggedOut: stub(
      "gh-logged-out",
      `echo "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4`,
    ),
    missing: join(dir, "no-gh-here"),
  }
})

/** A fetch over the HttpClient's test layer, answering `answers`, its requests kept in `sent`. */
const fetching = (
  answers: Readonly<Record<string, Answer | "never">>,
  sent: Array<Sent> = [],
  command = gh.missing,
): SpecFetch<LiveFetch> => {
  const http = httpLayer(answers, sent)
  return (target) => Effect.provide(fetchSpec(target, command), http)
}

/** The spec at `given` read in a fresh in-memory repository, `setUp` run on it first. */
const read = (
  given: string,
  fetch: SpecFetch<LiveFetch>,
  setUp: Effect.Effect<void, never, Repository> = Effect.void,
) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-url-")))
  return Effect.runPromise(
    Effect.andThen(setUp, readSpec(given, "--spec", repo, repo, fetch)).pipe(
      Effect.provide(Layer.mergeAll(memoryGit({ dir: repo }), BunServices.layer)),
    ),
  )
}

const spec = async (given: string, fetch: SpecFetch<LiveFetch>): Promise<Spec> => {
  const result = await read(given, fetch)
  if (Result.isFailure(result)) throw new Error(result.failure)
  return result.success
}

const problem = async (
  given: string,
  fetch: SpecFetch<LiveFetch> = fetching({}),
): Promise<string> => {
  const result = await read(given, fetch)
  if (Result.isSuccess(result)) throw new Error(`expected a problem with ${given}`)
  return result.failure
}

describe("a spec at a URL", () => {
  test("is fetched as it is, its copy named after it, its source without the query", async () => {
    const sent: Array<Sent> = []
    const url = "https://specs.example.com/v2/shop%20app?token=s3cret#top"
    const s = await spec(
      url,
      fetching(
        { "https://specs.example.com/v2/shop%20app?token=s3cret": { body: "# Shop\n" } },
        sent,
      ),
    )
    expect(s).toMatchObject({
      given: url,
      path: ".tutti/specs/shop-app.md",
      copy: true,
      text: "# Shop\n",
      url: "https://specs.example.com/v2/shop%20app",
      source: "https://specs.example.com/v2/shop%20app",
    })
    // No credentials, cookies or trace headers go with it.
    expect(sent.map((request) => Object.keys(request.headers))).toEqual([[]])
  })

  test("a GitHub file page is fetched as its raw file; a gist page as its one file", async () => {
    const sent: Array<Sent> = []
    const s = await spec(page, fetching({ [raw]: { body: "# Shop\n" } }, sent))
    expect(sent.map((request) => request.url)).toEqual([raw])
    expect(s.path).toBe(".tutti/specs/shop.md")
    expect(s.url).toBe(page)

    const gists: Array<Sent> = []
    const gistRaw = "https://gist.githubusercontent.com/me/abc123/raw/0f/shop.md"
    const gist = await spec(
      "https://gist.github.com/me/abc123",
      fetching(
        {
          "https://api.github.com/gists/abc123": {
            body: JSON.stringify({ files: { "shop.md": { raw_url: gistRaw } } }),
          },
          [gistRaw]: { body: "# Gist shop\n" },
        },
        gists,
      ),
    )
    expect(gists.map((request) => request.url)).toEqual([
      "https://api.github.com/gists/abc123",
      gistRaw,
    ])
    expect(gist).toMatchObject({ path: ".tutti/specs/abc123.md", text: "# Gist shop\n" })

    expect(
      await problem(
        "https://gist.github.com/me/abc123",
        fetching({
          "https://api.github.com/gists/abc123": {
            body: JSON.stringify({ files: { "a.md": {}, "b.md": {} } }),
          },
        }),
      ),
    ).toBe(
      "The spec https://gist.github.com/me/abc123 (--spec) is a gist of 2 files: give the URL of its file's raw view.",
    )
  })

  test("follows redirects over https", async () => {
    const s = await spec(
      "https://specs.example.com/shop.md",
      fetching({
        "https://specs.example.com/shop.md": redirect("/v2/shop.md"),
        "https://specs.example.com/v2/shop.md": redirect("https://cdn.example.com/shop.md"),
        "https://cdn.example.com/shop.md": { body: "# Shop\n" },
      }),
    )
    expect(s.text).toBe("# Shop\n")
  })

  test("a private GitHub file is read through gh's login; without gh, or logged out, says so", async () => {
    const s = await spec(page, fetching({}, [], gh.reads))
    expect(s.text).toBe("# Private shop\n")
    expect(s.url).toBe(page)

    const private_ =
      "The spec https://github.com/shop/app/blob/main/docs/shop.md (--spec) is private or missing; if it is private,"
    expect(await problem(page, fetching({}, [], gh.missing))).toBe(
      `${private_} install gh (https://cli.github.com), log it in (gh auth login) and run again.`,
    )
    expect(await problem(page, fetching({}, [], gh.loggedOut))).toBe(
      `${private_} log gh in (gh auth login) and run again.`,
    )
    // gh only for GitHub: another host's 404 is a 404.
    expect(await problem("https://specs.example.com/shop.md", fetching({}, [], gh.reads))).toBe(
      "Cannot fetch the spec https://specs.example.com/shop.md (--spec): HTTP 404 Not Found.",
    )
  })

  test("refuses http, a redirect to http, too many redirects and a URL with a password", async () => {
    expect(await problem("http://specs.example.com/shop.md")).toBe(
      "The spec http://specs.example.com/shop.md (--spec) is fetched over http: fetch the spec over https.",
    )
    expect(
      await problem(
        "https://specs.example.com/shop.md",
        fetching({
          "https://specs.example.com/shop.md": redirect("http://plain.example.com/shop.md"),
        }),
      ),
    ).toBe(
      "Cannot fetch the spec https://specs.example.com/shop.md (--spec): redirected to plain.example.com over http.",
    )
    const loop: Record<string, Answer> = {}
    for (let i = 0; i < 7; i++) {
      loop[`https://specs.example.com/${i}.md`] = redirect(`/${i + 1}.md`)
    }
    expect(await problem("https://specs.example.com/0.md", fetching(loop))).toBe(
      "Cannot fetch the spec https://specs.example.com/0.md (--spec): redirected more than 5 times.",
    )
    const withPassword = await problem("https://me:s3cret@specs.example.com/shop.md")
    expect(withPassword).toBe(
      "The spec https://specs.example.com/shop.md (--spec) holds a user name or password, and tutti sends no credentials: give the URL without them.",
    )
    expect(await problem("ftp://specs.example.com/shop.md")).toBe(
      "The spec ftp://specs.example.com/shop.md (--spec) is a ftp URL: tutti fetches a spec over https only.",
    )
  })

  test("refuses a 404, too big, a web page, empty text and text that isn't UTF-8", async () => {
    const url = "https://specs.example.com/shop.md"
    const answering = (answer: Answer) => fetching({ [url]: answer })
    const label = `The spec ${url} (--spec)`
    expect(await problem(url)).toBe(`Cannot fetch the spec ${url} (--spec): HTTP 404 Not Found.`)
    expect(await problem(url, answering({ body: new Uint8Array(maxSpecBytes + 1).fill(65) }))).toBe(
      `Cannot fetch the spec ${url} (--spec): is more than 5 MB.`,
    )
    expect(
      await problem(
        url,
        answering({ headers: { "content-type": "text/html; charset=utf-8" }, body: "# Shop" }),
      ),
    ).toBe(`${label} gave a web page, not a spec: give the URL of the raw file.`)
    expect(await problem(url, answering({ body: "\n <!DOCTYPE html>\n<html></html>" }))).toBe(
      `${label} gave a web page, not a spec: give the URL of the raw file.`,
    )
    expect(await problem(url, answering({ body: " \n\n" }))).toBe(
      `${label} is empty: write what to build in it first.`,
    )
    expect(await problem(url, answering({ body: new Uint8Array([0x23, 0xff, 0xfe]) }))).toBe(
      `${label} isn't text: give a Markdown or plain-text file, in UTF-8.`,
    )
  })

  test("refuses a fetch that takes more than 30 s", async () => {
    const url = "https://specs.example.com/shop.md"
    const target = specUrl(url, "--spec")
    if (Result.isFailure(target)) throw new Error(target.failure)
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(fetching({ [url]: "never" })(target.success))
        yield* TestClock.adjust("30 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, TestClock.layer()))),
    )
    expect(got).toEqual(Result.fail(`Cannot fetch the spec ${url} (--spec): took more than 30s.`))
  })

  test("refuses a name whose copy records another source, naming both", async () => {
    const url = "https://specs.example.com/shop.md"
    const result = await read(
      url,
      fetching({ [url]: { body: "# Shop\n" } }),
      Effect.flatMap(Repository, (git) =>
        Effect.asVoid(
          git.commit(
            git.dir,
            "tutti: add spec shop.md\n\nsha256 ab\n\nSpec-Source: ~/specs/shop.md",
            {
              ".tutti/specs/shop.md": "# Another shop\n",
            },
          ),
        ),
      ),
    )
    expect(result).toEqual(
      Result.fail(
        `The spec ${url} (--spec) has the name of another: .tutti/specs/shop.md holds the copy of another spec, ~/specs/shop.md, and would take its tickets. Give the URL of a file of another name, which its copy takes; or, if it is that spec moved, remove .tutti/specs/shop.md in a commit of its own and run again.`,
      ),
    )
  })

  test("is fetched once a run, by the setup and the checks alike", async () => {
    let fetches = 0
    const once = fetchOnce<never>(() =>
      Effect.sync(() => {
        fetches += 1
        return Result.succeed<Fetched>({ bytes: new Uint8Array([0x23]), contentType: null })
      }),
    )
    const target = specUrl("https://specs.example.com/shop.md", "--spec")
    if (Result.isFailure(target)) throw new Error(target.failure)
    await Effect.runPromise(Effect.andThen(once(target.success), once(target.success)))
    expect(fetches).toBe(1)
  })

  test("is named with its URL in the START line, and the start record takes it", () => {
    const s: Spec = {
      given: page,
      from: "--spec",
      source: page,
      path: ".tutti/specs/shop.md",
      copy: true,
      text: "# Shop\n",
      sha256: "ab".repeat(32),
      url: page,
    }
    const started: Started = {
      config: TestAppConfig.appConfig({}, "/work/shop"),
      base: "build/shop",
      prompt: { text: "Work on TICKET_ID.", file: null },
      mcp: { servers: [], note: noServersNote },
      account: TestAccount.accountProbe(),
      organs: { _tag: "AgentSdk" },
      spec: s,
      warnings: [],
    }
    expect(startBlock(started, "0.1.0")[0] as string).toContain(
      ` on build/shop · spec .tutti/specs/shop.md from ${page} (`,
    )
    expect(Object.keys(Start.fields)).toContain("spec_source")
  })
})

describe("a URL's copy name and GitHub raw URL", () => {
  const safe = /^[^.\-/][\p{L}\p{N}._-]*$/u
  const urlText = fc.oneof(
    fc.webUrl({ withQueryParameters: true, withFragments: true }),
    fc
      .tuple(
        fc.constantFrom("https://", "http://", "HTTPS://", "ftp://", "https://me:pw@", ""),
        fc.constantFrom("github.com", "gist.github.com", "raw.githubusercontent.com", "x.org"),
        fc.array(fc.string({ unit: "binary" }), { maxLength: 6 }),
      )
      .map(([scheme, host, segments]) => `${scheme}${host}/${segments.join("/")}`),
    fc.string({ unit: "binary" }),
  )

  test("any URL text gives a safe file name or a clear refusal", () => {
    fc.assert(
      fc.property(urlText, (text) => {
        const read = specUrl(text, "--spec")
        if (Result.isFailure(read)) {
          expect(read.failure).toStartWith("The spec ")
          expect(read.failure).not.toContain("\n")
          return
        }
        const { name, shown } = read.success
        expect(name).toMatch(safe)
        expect(name).toMatch(/\.(md|markdown|txt)$/i)
        expect(name).not.toContain("..")
        expect(name.length).toBeLessThanOrEqual(103)
        expect(shown).not.toContain("?")
        expect(shown).not.toContain("#")
      }),
    )
  })

  test("a GitHub file page's raw URL keeps its owner, repo, ref and path", () => {
    const segment = fc
      .stringMatching(/^[A-Za-z0-9._-]{1,12}$/)
      .filter((s) => s !== "." && s !== "..")
    fc.assert(
      fc.property(
        segment,
        segment,
        segment.filter((s) => s !== "refs"),
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        (owner, repo, ref, path) => {
          const file = githubFile(
            new URL(`https://github.com/${owner}/${repo}/blob/${ref}/${path.join("/")}`),
          )
          expect(file?.raw.href).toBe(
            `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join("/")}`,
          )
          expect(file?.path).toBe(path.join("/"))
        },
      ),
    )
    fc.assert(
      fc.property(urlText, (text) => {
        if (!URL.canParse(text)) return
        const file = githubFile(new URL(text))
        if (file === null) return
        expect(file.raw.protocol).toBe(
          new URL(text).hostname === "raw.githubusercontent.com"
            ? new URL(text).protocol
            : "https:",
        )
        expect(file.raw.hostname).toBe("raw.githubusercontent.com")
      }),
    )
  })

  test("names a copy after the last segment, decoded, with .md where it has no text ending", () => {
    const name = (url: string) => copyName(new URL(url))
    expect(name("https://x.org/specs/Shop%20App.markdown")).toBe("Shop-App.markdown")
    expect(name("https://x.org/specs/notes.txt/")).toBe("notes.txt")
    expect(name("https://x.org/specs/..%2F..%2Fetc%2Fpasswd")).toBe("etc-passwd.md")
    expect(name("https://x.org/.hidden")).toBe("hidden.md")
    expect(name("https://x.org/spec.html")).toBe("spec.html.md")
    expect(name("https://x.org/")).toBeNull()
    expect(name("https://x.org/%2E%2E")).toBeNull()
  })
})

describe("a spec at a URL, committed", () => {
  const layer = Git.layer().pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )

  slow.test("as a copy recording its URL; the same text again, then changed text", async () => {
    const repo = makeRepo()
    const url = "https://specs.example.com/shop.md?token=s3cret"
    const at = (body: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const read = yield* readSpec(
            url,
            "--spec",
            repo.dir,
            repo.dir,
            fetching({ [url]: { body } }),
          )
          if (Result.isFailure(read)) return yield* Effect.die(read.failure)
          return yield* commitSpec(read.success, repo.dir)
        }).pipe(Effect.provide(layer)),
      )
    const added = await at("# Shop\n")
    expect(added.committed).toBe(true)
    expect(readFileSync(join(repo.dir, ".tutti/specs/shop.md"), "utf8")).toBe("# Shop\n")
    const message = repo.git(["log", "-1", "--format=%B"])
    expect(message).toStartWith("tutti: add spec shop.md\n\nsha256 ")
    expect(sourceOf(message)).toBe("https://specs.example.com/shop.md")
    expect(message).not.toContain("s3cret")

    expect(await at("# Shop\n")).toEqual({ commit: added.commit, committed: false })

    const updated = await at("# Shop\n\n## Listing\n")
    expect(updated.committed).toBe(true)
    expect(repo.git(["log", "-1", "--format=%s"]).trim()).toBe("tutti: update spec shop.md")
  })
})
