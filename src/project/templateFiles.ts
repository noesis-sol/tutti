// The files init writes from tutti's templates (§ 8.3), which init (src/init/checks.ts), the
// templates' versions (./templateVersions.ts) and so the run read: the create-check-suite skill,
// the verifier subagent, and the worker prompt's section and line about them.
import { join } from "node:path"
import skillTemplate from "./templates/create-check-suite.md" with { type: "text" }

/** The skill's folder, from the project's top: Claude Code's project skills. */
export const skillDir = join(".claude", "skills", "create-check-suite")

/** The skill's one file. */
export const skillPath = join(skillDir, "SKILL.md")

/** The skill as tutti carries it. */
export const skillText: string = skillTemplate

/** The verifier subagent, from the project's top: committed, as a worktree has only that. */
export const verifierPath = join(".claude", "agents", "verifier.md")

/** The worker prompt's section that has workers run the verifier: TICKET_ID filled in per ticket. */
export const verifierSection = `
## Verify
- Before you close the ticket, once your checks pass after your last commit, have the verifier
  subagent (${verifierPath}) check your change: give it the ticket's ID, TICKET_ID, the
  commit at which your checks passed (\`git rev-parse HEAD\`), the commands you ran there, and the
  file their output is in where you kept one, so that it needn't run them again; nothing of your
  reasoning. Run it in the foreground and wait for its answer.
- Fix each gap it reports that affects correctness or the ticket's requirements, commit, run your
  checks again, and ask it again with the new commit and commands. Run the slower suites again only
  where the fix touches what they cover; where you don't, give it too the commit at which they last
  passed. The rest is optional: note on the ticket any you leave.
- From the second round on, give it the earlier rounds' findings too: each round's verdict and the
  gaps it raised, as it gave them, still nothing of your reasoning, so that it weighs them rather
  than start blind. When it disagrees with an earlier round (a line that starts DISAGREES WITH
  ROUND), don't go round again to settle it: note both rounds' findings on the ticket and ask the
  maintainer which holds, as a question, as under Close.
- After three rounds that still end in FAIL, note its findings on the ticket. Close the ticket only
  when you judge them outside the ticket's requirements; otherwise defer it, as under Close. A fix
  you committed after the last round isn't lost: the run takes the ticket back once, for one more
  round on it.
`

/** The worker prompt's line before its bullets on running each suite on part of the project. */
export const suitesIntro = "  The suites, and how to run each on part of the project:\n"

/** Whether a worker prompt has workers run the verifier. */
export const usesVerifier = (prompt: string): boolean => prompt.includes(verifierPath)
