// The verifier's template and the worker prompt's Verify section (src/init/checks.ts): the verifier
// quotes the worker's passing check rather than run it again, runs the suites only on what a change
// touches, builds on the earlier rounds' findings, and passes Bash no timeout where a worker's
// settings raised Bash's default.
import { describe, expect, test } from "bun:test"
import { verifierSection, verifierText } from "../src/init/checks.ts"
import { fastRunner, fullRunner } from "../src/init/runners.ts"

const agent = verifierText([], ["scripts/check.sh"], ["npx playwright test"])

/** The text of the agent's section titled `title`, up to the next heading. */
const section = (title: string): string => {
  const start = agent.indexOf(`\n## ${title}\n`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = agent.indexOf("\n## ", start + 1)
  return agent.slice(start, end < 0 ? undefined : end)
}

describe("the verifier reuses the worker's passing check", () => {
  // On tutti's runs 176 of 182 rounds repeated a check the worker had just passed.
  test("the worker gives it the commit, the commands and their output file", () => {
    expect(agent).toContain(
      "Give it the ticket's ID, the commit at which your checks passed and the commands you ran there.\n",
    )
    expect(verifierSection).toContain(
      "give it the ticket's ID, TICKET_ID, the\n  commit at which your checks passed (`git rev-parse HEAD`), " +
        "the commands you ran there, and the\n  file their output is in where you kept one, so that it " +
        "needn't run them again; nothing of your\n  reasoning.",
    )
    expect(verifierSection).toContain("and ask it again with the new commit and commands.")
  })

  test("it quotes them when HEAD is that commit and the tree is clean", () => {
    const verify = section("How to verify")
    for (const want of [
      "3. The worker tells you the commit at which its own checks passed, the commands it ran there, and\n" +
        "   the file their output is in where it kept one.",
      "When `git rev-parse HEAD` is that commit and\n   `git status --porcelain` prints nothing, those " +
        "results stand: quote them (the end of the file,\n   where it gave one) rather than run them again, " +
        "and run only a suite they leave out that covers\n   what the change touches.",
    ]) {
      expect(verify).toContain(want)
    }
    expect(agent).not.toContain("in the foreground, and quote the command")
  })
})

describe("the verifier runs the suites on what the change touches", () => {
  test("otherwise it runs each suite on part of the project, and leaves the whole to tutti", () => {
    const verify = section("How to verify")
    expect(verify).toContain(
      "Otherwise, or when it gave no commit, run the suites on what the change\n   touches, as under Its checks",
    )
    expect(verify).toContain("Quote\n   each command and the end of its output.")
    expect(verify).toContain(
      `Leave the whole suite to tutti: \`${fastRunner}\` runs\n   on the ticket before it merges, and \`${fullRunner}\` at the end of the run.\n`,
    )
    expect(section("Its checks")).toContain(
      "- Run each of those commands on what a change touches where its tool allows it\n",
    )
  })
})

describe("a later round builds on the earlier rounds", () => {
  // On tutti-nrg.4.15 round 1 held a requirement one way and round 3 the other.
  test("the verifier weighs their findings and says where it disagrees", () => {
    const verify = section("How to verify")
    expect(verify).toContain(
      "6. From the second round on, the worker gives you the earlier rounds' findings: each round's verdict\n" +
        "   and the gaps it raised. Check each again on its own terms rather than take or drop it unseen;",
    )
    expect(verify).toContain("say so in a line that starts `DISAGREES WITH ROUND <n>:`")
    expect(verify).toContain(
      "so that the worker takes the contradiction to the maintainer rather than go round again.\n",
    )
  })

  test("the worker passes them on, and asks the maintainer rather than go round again", () => {
    expect(verifierSection).toContain(
      "- From the second round on, give it the earlier rounds' findings too: each round's verdict and the\n" +
        "  gaps it raised, as it gave them, still nothing of your reasoning,",
    )
    expect(verifierSection).toContain(
      "When it disagrees with an earlier round (a line that starts DISAGREES WITH\n  ROUND), don't go round " +
        "again to settle it: note both rounds' findings on the ticket and ask the\n  maintainer which holds, " +
        "as a question, as under Close.\n",
    )
    // The rule comes before the three rounds' limit, which it settles first.
    expect(verifierSection.indexOf("earlier rounds' findings")).toBeLessThan(
      verifierSection.indexOf("After three rounds"),
    )
  })
})

describe("the verifier gives a check its time", () => {
  test("it passes Bash no timeout where a worker's settings raised the default", () => {
    const rules = section("Rules")
    for (const want of [
      "- Give a check its time: Bash waits on a command for the default timeout its description gives (2\n" +
        "  minutes unless raised), then moves it to the background.",
      "as in a tutti worker, whose settings raise it to the merge check's limit\n" +
        "  (`checks.fast.timeout` in `.tutti/settings.json`, 30m when unset), pass Bash no timeout: one of\n" +
        "  your own shortens it.",
      "Elsewhere, pass Bash `timeout: 600000`, its maximum (10 minutes), for every\n  check,",
      "`until grep -q '^exit ' <file>; do sleep 10; done`",
      "Never `sleep` for long: Bash refuses it.\n",
    ]) {
      expect(rules).toContain(want)
    }
    expect(agent).toContain("\ntools: Read, Grep, Glob, Bash\n")
  })
})
