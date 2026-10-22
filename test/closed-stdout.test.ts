import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The fixture is a bun process of its own, which bun's 5 s default fails when other checks run
// beside this one.
setDefaultTimeout(30_000)

const fixture = join(import.meta.dir, "fixtures", "closed-stdout", "plain-end.ts")

describe("a closed stdout", () => {
  test("tutti --plain | head: the run's end goes on to its report, its finalizers and its own exit code", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-closed-stdout-")))
    // head reads the first line and goes, closing the pipe mid-run; the fixture's exit code goes to
    // a file, as sh has no PIPESTATUS.
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        '{ "$0" "$1" "$2"; echo $? > "$2/code"; } | head -n 1',
        process.execPath,
        fixture,
        dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(out).toBe("log line 0\n")
    expect(err).not.toContain("EPIPE")
    expect(readFileSync(join(dir, "code"), "utf8").trim()).toBe("3")
    expect(readFileSync(join(dir, "report"), "utf8")).toBe("the report\n")
    expect(existsSync(join(dir, "released"))).toBe(true)
  })
})
