// scripts/install.sh's check of the new binary (§ 12 Install): it runs --version on the copy beside
// the old binary, not in the temporary folder, which may be mounted noexec, and reads its stdout
// only, as tutti update does. The fixtures are in test/install-script.ts.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  install,
  installed,
  newKey,
  publicPem,
  releasesFolder,
  temp,
  timeout,
} from "./install-script.ts"

describe("scripts/install.sh checks the new binary", () => {
  const key = newKey()

  test(
    "where the temporary folder is noexec, runs it in the folder it installs in",
    () => {
      // Runs only from the folder EXEC_ONLY names, as where every other one, /tmp among them, is
      // mounted noexec. (macOS's mktemp -d ignores TMPDIR, so the temporary folder can't be named.)
      const releases = releasesFolder(key.privateKey, [
        {
          tag: "v0.3.0",
          binary: `if [ -n "\${EXEC_ONLY:-}" ]; then
  case "$0" in "$EXEC_ONLY"/*) ;; *) echo "$0: Permission denied" >&2; exit 126 ;; esac
fi
echo 'tutti v0.3.0'`,
        },
      ])
      const dir = temp("dir")
      const ran = install({
        releases,
        key: publicPem(key),
        env: { TUTTI_INSTALL_DIR: dir, EXEC_ONLY: dir },
      })
      expect(ran.code, ran.out).toBe(0)
      expect(installed(dir)?.version).toBe("tutti v0.3.0")
      expect(ran.out).not.toContain("Permission denied")
    },
    timeout,
  )

  test(
    "a warning on --version's stderr doesn't fail the install",
    () => {
      const releases = releasesFolder(key.privateKey, [
        { tag: "v0.3.0", binary: "echo 'warning: something' >&2\necho 'tutti v0.3.0'" },
      ])
      const ran = install({ releases, key: publicPem(key) })
      expect(ran.code, ran.out).toBe(0)
      expect(installed(ran.dir)?.version).toBe("tutti v0.3.0")
      expect(ran.out).toContain(`Installed tutti v0.3.0 in ${join(ran.dir, "tutti")}.`)
    },
    timeout,
  )

  test(
    "a new binary that doesn't run replaces nothing and leaves no copy behind",
    () => {
      const releases = releasesFolder(key.privateKey, [
        { tag: "v0.3.0", binary: "echo 'cannot load libstdc++' >&2\nexit 3" },
      ])
      const dir = temp("dir")
      writeFileSync(join(dir, "tutti"), "old\n")
      const ran = install({ releases, key: publicPem(key), env: { TUTTI_INSTALL_DIR: dir } })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain(
        "tutti install: the new binary doesn't run: it exited 3: cannot load libstdc++",
      )
      expect(readdirSync(dir)).toEqual(["tutti"])
      expect(readFileSync(join(dir, "tutti"), "utf8")).toBe("old\n")
    },
    timeout,
  )

  test(
    "a new binary whose --version names another release replaces nothing",
    () => {
      const releases = releasesFolder(key.privateKey, [
        { tag: "v0.3.0", binary: "echo 'warning: something' >&2\necho 'tutti v0.2.0'" },
      ])
      const dir = temp("dir")
      writeFileSync(join(dir, "tutti"), "old\n")
      const ran = install({ releases, key: publicPem(key), env: { TUTTI_INSTALL_DIR: dir } })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain("the new binary's --version says 'tutti v0.2.0', not tutti v0.3.0")
      expect(readdirSync(dir)).toEqual(["tutti"])
      expect(readFileSync(join(dir, "tutti"), "utf8")).toBe("old\n")
    },
    timeout,
  )
})
