// The README and docs/running.md point to the tutti skill, skills/tutti/SKILL.md, and say where to
// install it, the folders the skill's own header names (Appendix A Other). test/user-docs.test.ts
// checks that their links lead somewhere.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const top = join(import.meta.dir, "..")
const read = (file: string): string => readFileSync(join(top, file), "utf8")
const skill = read("skills/tutti/SKILL.md")
const folders = ["~/.claude/skills/tutti/", ".claude/skills/tutti/"]

describe("the tutti skill's install docs", () => {
  test("the skill's header names the folders the docs give", () => {
    for (const folder of folders) expect(skill).toContain(folder)
  })

  test("the README points to the skill and says where to install it", () => {
    const readme = read("README.md")
    expect(existsSync(join(top, "skills/tutti/SKILL.md"))).toBe(true)
    expect(readme).toContain("](skills/tutti/SKILL.md)")
    expect(readme).toContain("](docs/running.md#running-through-an-agent)")
    for (const folder of folders) expect(readme).toContain(`\`${folder}\``)
  })

  test("docs/running.md points to the skill and says where to install it", () => {
    const running = read("docs/running.md")
    expect(running).toContain("## Running through an agent")
    expect(running).toContain("](../skills/tutti/SKILL.md)")
    for (const folder of folders) expect(running).toContain(`\`${folder}\``)
    expect(running).toContain("cp -R tutti/skills/tutti ~/.claude/skills/tutti")
  })
})
