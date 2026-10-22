// scripts/install.sh's folder (§ 12 Install): ~/.local/bin by default, made where it doesn't exist,
// never /usr/local/bin unless TUTTI_INSTALL_DIR names it, and the line that puts the folder on the
// PATH for the user's shell where it isn't there. The fixtures are in test/install-script.ts.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { testEnv } from "./env.ts"
import {
  install,
  installed,
  newKey,
  publicPem,
  releasesFolder,
  temp,
  timeout,
} from "./install-script.ts"

describe("scripts/install.sh's folder", () => {
  const key = newKey()
  const releases = releasesFolder(key.privateKey, [{ tag: "v0.1.0" }])

  test(
    "installs in ~/.local/bin without TUTTI_INSTALL_DIR, making it, and says how to put it on the PATH",
    () => {
      const ran = install({ releases, key: publicPem(key) })
      expect(ran.code, ran.out).toBe(0)
      expect(ran.dir).toBe(join(ran.home, ".local/bin"))
      expect(installed(ran.dir)?.version).toBe("tutti v0.1.0")
      expect(ran.out).toContain(`Installed tutti v0.1.0 in ${join(ran.dir, "tutti")}.`)
      expect(ran.out).toContain(`${ran.dir} isn't on your PATH. To add it:`)
      expect(ran.out).toContain(`echo 'export PATH="${ran.dir}:$PATH"' >> ~/.zshrc && exec zsh`)
      // Nothing suggests /usr/local/bin, which Homebrew owns on many Macs.
      expect(ran.out).not.toContain("/usr/local/bin")
    },
    timeout,
  )

  test(
    "says nothing of the PATH where ~/.local/bin is on it already",
    () => {
      const home = temp("home-on-path")
      const dir = join(home, ".local/bin")
      mkdirSync(dir, { recursive: true })
      const ran = install({
        releases,
        key: publicPem(key),
        env: { HOME: home, PATH: `${dir}:${testEnv.PATH}` },
      })
      expect(ran.code, ran.out).toBe(0)
      expect(installed(dir)?.version).toBe("tutti v0.1.0")
      expect(ran.out).not.toContain("isn't on your PATH")
      expect(ran.out).not.toContain("comes before")
    },
    timeout,
  )

  const shells: ReadonlyArray<{
    shell: string
    kernel: "Darwin" | "Linux"
    line: (dir: string) => string
  }> = [
    {
      shell: "/bin/bash",
      kernel: "Darwin",
      line: (dir) => `echo 'export PATH="${dir}:$PATH"' >> ~/.bash_profile && exec bash -l`,
    },
    {
      shell: "/bin/bash",
      kernel: "Linux",
      line: (dir) => `echo 'export PATH="${dir}:$PATH"' >> ~/.bashrc && exec bash`,
    },
    { shell: "/usr/bin/fish", kernel: "Linux", line: (dir) => `fish_add_path ${dir}` },
    {
      shell: "/bin/ksh",
      kernel: "Linux",
      line: (dir) => `echo 'export PATH="${dir}:$PATH"' >> ~/.profile, then log in again`,
    },
  ]
  for (const { shell, kernel, line } of shells) {
    test(
      `gives the line that adds the folder to the PATH for ${shell} on ${kernel}`,
      () => {
        const ran = install({
          releases,
          key: publicPem(key),
          uname: [kernel, "x86_64"],
          env: { SHELL: shell },
        })
        expect(ran.code, ran.out).toBe(0)
        expect(ran.out).toContain(`${ran.dir} isn't on your PATH. To add it:\n  ${line(ran.dir)}\n`)
      },
      timeout,
    )
  }

  test(
    "installs in the folder TUTTI_INSTALL_DIR names, making it, and not in ~/.local/bin",
    () => {
      const dir = join(temp("install-dir"), "nested/bin")
      const ran = install({ releases, key: publicPem(key), env: { TUTTI_INSTALL_DIR: dir } })
      expect(ran.code, ran.out).toBe(0)
      expect(installed(dir)?.version).toBe("tutti v0.1.0")
      expect(existsSync(ran.dir)).toBe(false)
      expect(ran.out).toContain(`${dir} isn't on your PATH`)
    },
    timeout,
  )

  test.skipIf(process.getuid?.() === 0)(
    "stops where it can't write in TUTTI_INSTALL_DIR, with the line that installs there with sudo",
    () => {
      const dir = temp("read-only")
      chmodSync(dir, 0o555)
      const ran = install({ releases, key: publicPem(key), env: { TUTTI_INSTALL_DIR: dir } })
      chmodSync(dir, 0o755)
      expect(ran.code).toBe(1)
      expect(ran.out).toContain(`cannot write in ${dir}`)
      expect(ran.out).toContain(
        `curl -fsSL https://github.com/noesis-sol/tutti/releases/latest/download/install.sh | sudo TUTTI_INSTALL_DIR=${dir} sh`,
      )
      expect(installed(dir)).toBeUndefined()
    },
    timeout,
  )

  test(
    "stops without a HOME or TUTTI_INSTALL_DIR, rather than install in /.local/bin",
    () => {
      const ran = install({ releases, key: publicPem(key), env: { HOME: "" } })
      expect(ran.code).toBe(1)
      expect(ran.out).toContain("HOME isn't set: set TUTTI_INSTALL_DIR to the folder to install in")
    },
    timeout,
  )
})
