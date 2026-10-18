// scripts/fetch-shellcheck.sh end to end, on a copy of the script in a temp folder, with fake
// curl, sha256sum, tar and uname first on PATH: nothing is downloaded, and the cache is the temp
// folder's.
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve(import.meta.dir, "../scripts/fetch-shellcheck.sh")
// The sha256 pinned for the linux x86_64 archive, which the fake uname makes this machine.
const pinned = "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6"
const cached = ".cache/shellcheck/v0.11.0/shellcheck"
const working = "#!/bin/sh\necho 'ShellCheck - shell script analysis tool'\n"

// One fake for every tool, linked under each tool's name and steered by FAKE_* variables: macOS
// scans each new executable on its first run, which costs up to a second a file. Its tar writes
// FAKE_EXTRACTED to stdout and exits FAKE_TAR_EXIT, the way tar fails partway when the disk fills.
const bin = mkdtempSync(join(tmpdir(), "tutti-fetch-shellcheck-bin-"))
writeFileSync(
  join(bin, "fake"),
  `#!/bin/sh
case "$(basename "$0")" in
uname) case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac ;;
curl)
  [ "$FAKE_CURL_EXIT" = 0 ] || exit "$FAKE_CURL_EXIT"
  while [ "$1" != -o ]; do shift; done
  echo archive >"$2" ;;
sha256sum) echo "${pinned}  $1" ;;
tar) cat "$FAKE_EXTRACTED"; exit "$FAKE_TAR_EXIT" ;;
esac
`,
)
chmodSync(join(bin, "fake"), 0o755)
for (const tool of ["uname", "curl", "sha256sum", "tar"]) symlinkSync("fake", join(bin, tool))

// Lays out a checkout holding the script, and the file the fake tar extracts.
const setup = (extracted: string) => {
  const root = mkdtempSync(join(tmpdir(), "tutti-fetch-shellcheck-"))
  mkdirSync(join(root, "scripts"))
  copyFileSync(script, join(root, "scripts/fetch-shellcheck.sh"))
  writeFileSync(join(root, "extracted"), extracted)
  return root
}

const run = (root: string, { tarExit = 0, curlExit = 0 } = {}) => {
  const proc = Bun.spawnSync(["sh", join(root, "scripts/fetch-shellcheck.sh")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_EXTRACTED: join(root, "extracted"),
      FAKE_TAR_EXIT: String(tarExit),
      FAKE_CURL_EXIT: String(curlExit),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

// Puts a binary in the cache, as an earlier check left it.
const cache = (root: string, binary: string) => {
  mkdirSync(join(root, ".cache/shellcheck/v0.11.0"), { recursive: true })
  writeFileSync(join(root, cached), binary)
  chmodSync(join(root, cached), 0o755)
}

describe("scripts/fetch-shellcheck.sh", () => {
  test("installs the extracted binary, executable, and prints its path", () => {
    const root = setup(working)
    const { code, out } = run(root)
    expect(code).toBe(0)
    expect(out.trim()).toBe(cached)
    expect(readFileSync(join(root, cached), "utf8")).toBe(working)
    expect(statSync(join(root, cached)).mode & 0o111).not.toBe(0)
    expect(existsSync(join(root, `${cached}.part`))).toBe(false)
  })

  test("leaves no binary when tar fails partway, and fails", () => {
    const root = setup("#!/bin/sh\necho trunc")
    const { code, out, err } = run(root, { tarExit: 1 })
    expect(code).toBe(1)
    expect(out).toBe("")
    expect(err).toContain("could not extract shellcheck")
    expect(existsSync(join(root, cached))).toBe(false)
    expect(existsSync(join(root, `${cached}.part`))).toBe(false)
  })

  test("fetches again over a cached binary that doesn't run", () => {
    const root = setup(working)
    cache(root, "#!/bin/sh\nexit 126\n")
    const { code, out } = run(root)
    expect(code).toBe(0)
    expect(out.trim()).toBe(cached)
    expect(readFileSync(join(root, cached), "utf8")).toBe(working)
  })

  test("keeps a cached binary that runs, without downloading", () => {
    const root = setup(working)
    cache(root, working)
    expect(run(root, { curlExit: 7 })).toMatchObject({ code: 0, out: `${cached}\n` })
  })

  test("exits 2 when the archive can't be downloaded", () => {
    const root = setup(working)
    expect(run(root, { curlExit: 7 }).code).toBe(2)
    expect(existsSync(join(root, cached))).toBe(false)
  })
})
