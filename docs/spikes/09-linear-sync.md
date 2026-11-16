# Spike 09: what Linear sync's design rests on

Ticket tutti-qatu.1, for the epic tutti-qatu (Linear sync); its design field's section "To confirm
first" names the six points and the fallback each has.

- **Versions:** bd 1.3.4 (Homebrew), macOS 26.6.2 arm64, 2026-11-16. Linear team NOE (Noesis,
  `285603b3-2ca2-4d27-bebd-027835c24fd2`); its workflow states: Backlog (backlog), Todo (unstarted),
  In Progress and In Review (both started), Done (completed), Canceled (canceled), Duplicate
  (duplicate).
- **Setup:** a throwaway Beads database (`git init`, `bd init --non-interactive --prefix spk
  --sandbox`, embedded Dolt, no remote) in a temp folder, so that no linear.* key and no pulled
  ticket reached the project's database, which syncs to its git remote. Its configuration:

  ```
  bd config set linear.team_id 285603b3-2ca2-4d27-bebd-027835c24fd2
  bd config set linear.state_map.backlog deferred      # accepted: "Set linear.state_map.backlog = deferred"
  bd config set linear.state_map.unstarted open
  bd config set linear.state_map.started in_progress
  bd config set linear.state_map.completed closed
  bd config set linear.state_map.canceled closed
  bd config set linear.outbound_state_map.open Todo
  bd config set linear.outbound_state_map.in_progress "In Progress"
  bd config set linear.outbound_state_map.deferred Backlog
  bd config set linear.outbound_state_map.closed Done
  ```

- **The key** came only from the environment: `LINEAR_API_KEY` from the maintainer's shell profile,
  put in each command's environment by a wrapper and sent to Linear's GraphQL API as a header read
  from a pipe. It was never given to `bd config`, printed, or written to a file; a search of the
  spike's outputs, its database and this worktree for it found it in no file.
- **What stood for the maintainer in Linear** (filing an issue, moving it, editing it) was Linear's
  GraphQL API: `issueCreate`, `issueUpdate` and `issue` queries.
- **Throwaway issues:** NOE-7, NOE-8 and NOE-9, each titled `THROWAWAY tutti spike qatu.1: …
  (delete me)`. All three were deleted (`issueDelete(permanentlyDelete: true)`, success), and the
  team's issue list, archived included, then held only NOE-1 to NOE-6, none of them the spike's.
  The scratch database's linear.* keys were unset; the project's database had none before or after,
  and `bd linear status` there said `Status: Not configured` before and after.
- **No unscoped pull or push was run.** Every pull named its issues (`bd linear pull <key>` or
  `--issues`), every push its ticket.

## Summary

| Point | Result |
|---|---|
| 1. Backlog held as deferred, Todo hands it over | **Confirmed.** `linear.state_map.backlog deferred` is accepted; a Backlog issue is pulled as `deferred`, and after it moves to Todo the next pull of it sets it `open` |
| 2. A pull limited to new issues | **Failed.** `--create-only` acts only on pushes; a pull overwrites any linked ticket not changed locally since bd's last sync, held or not. Fallback taken: pull by reference only the issues no ticket links yet (and, for the handover, the deferred linked ones). How tutti lists those is the maintainer's question tutti-94ru |
| 3. A push moves the Linear issue, local winning | **Confirmed.** A push by ticket ID moved NOE-7 Todo → In Progress → Done as the ticket was claimed and closed, and overwrote the title, description and priority edited in Linear meanwhile. A plain `--push` overwrote them too, without `--prefer-local` |
| 4. Acceptance criteria, design and notes in Linear | **They reach it**, as `## Acceptance Criteria`, `## Design` and `## Notes` sections of the description. But a pull of that issue back folds the sections into the ticket's description, so each later push adds another copy |
| 5. Time of a pull and a one-ticket push | Pull of one issue by reference: 1.0 s (1.65 s cold). Push of one ticket: 1.6 to 2.5 s. Proposed limits: 60 s for a pull, 30 s for a push |
| 6. The oldest bd with all of it | **bd 1.2.0** (2026-08-11), the first with `linear.outbound_state_map`, which a team with two states of one type (NOE) needs to push at all |

## 1. Backlog is held as deferred; Todo hands it over

NOE-7 was created in Backlog, then pulled into the scratch database:

```
$ bd linear pull NOE-7
✓ Pulled 1 issues (1 created, 0 updated)

spk-pec0lu deferred 2 https://linear.app/noesis-sol/issue/NOE-7 THROWAWAY tutti spike qatu.1: backlog gate (delete me)
```

Then NOE-7 was moved to Todo in Linear and pulled again:

```
$ bd linear pull NOE-7   (after moving NOE-7 to Todo in Linear)
✓ Pulled 1 issues (0 created, 1 updated)

spk-pec0lu open 2 https://linear.app/noesis-sol/issue/NOE-7 THROWAWAY tutti spike qatu.1: backlog gate (delete me)
```

The ticket kept its ID, `external_ref` (the issue's URL without its slug) and priority (Linear
Medium is P2). **The gate works as the design has it**; the fallback (tutti reading Todo issues
from Linear itself) is not needed for it.

## 2. A pull limited to new issues: `--create-only` does not do it

A first test looked like a pass. NOE-8 was created in Todo; spk-pec0lu (NOE-7) was claimed
locally, as a run would hold it, and NOE-7's title edited in Linear after the claim:

```
$ bd linear sync --pull --create-only --issues NOE-7,NOE-8
Acquiring sync lock...
✓ Pulled 1 issues (1 created, 0 updated)

  spk-pec0lu in_progress https://linear.app/noesis-sol/issue/NOE-7 | THROWAWAY tutti spike qatu.1: backlog gate (delete me)
  spk-7bkaks open https://linear.app/noesis-sol/issue/NOE-8 | THROWAWAY tutti spike qatu.1: new issue for create-only (delete me)
```

The same pull without `--create-only` then reset the held ticket to Linear's state and title:

```
$ bd linear pull NOE-7   (no --create-only; ticket held in_progress locally, Linear Todo and edited later)
✓ Pulled 1 issues (0 created, 1 updated)
  spk-pec0lu open https://linear.app/noesis-sol/issue/NOE-7 | THROWAWAY tutti spike qatu.1: backlog gate, edited in Linear twice (delete me)
```

bd's source (`internal/tracker/engine.go` at v1.3.4) says why: `CreateOnly` is read only in
`doPush`. What kept NOE-7 in the first pull was the pull's conflict guard, which skips a linked
ticket whose `updated_at` is after `linear.last_sync`, and every non-dry-run sync, a pull by
reference or a push included, moves `last_sync` to its own end. The claim had come after the last
sync; by the second pull, the first had moved `last_sync` past it. A ticket a run claimed before
any later sync is therefore not protected, with or without `--create-only`:

```
$ bd update spk-7bkaks --claim   (a run takes the ticket)
  local spk-7bkaks: in_progress | THROWAWAY tutti spike qatu.1: new issue for create-only (delete me) | 2026-11-16T13:40:18Z
$ bd linear pull NOE-9   (any later sync: it moves linear.last_sync past the claim)
✓ Pulled 1 issues (0 created, 1 updated)
# In Linear: NOE-8 title edited (state left Todo)
$ bd linear sync --pull --create-only --issues NOE-8
Acquiring sync lock...
✓ Pulled 1 issues (0 created, 1 updated)
  local spk-7bkaks: open | THROWAWAY tutti spike qatu.1: NOE-8 edited in Linear while held (delete me) | 2026-11-16T13:40:26Z
```

bd 1.4.0-rc.2 is the same: its `CreateOnly` uses are all in `doPush` (one new one for the dry
run, gastownhall/beads#6337).

**Fallback taken:** every pull during a run is by reference, and names only

- the Linear issues no ticket's `external_ref` names yet (they are created), and
- the linked tickets that are deferred locally and whose Linear issue has left Backlog (the
  handover of point 1; a deferred ticket is never one a run holds).

A linked ticket that is open, in progress or closed is never pulled during a run. To name those
issues tutti needs the team's issues changed since its last pull, with their state type; bd has no
scoped way to list them. Whether tutti asks Linear's API for that list (one GraphQL call; the spec
has tutti call Linear itself only at setup) or reads it from `bd linear sync --pull --dry-run`'s
`Would import` / `Would update` lines (a dry run does not move `last_sync`, by the source; not run
here, as an unscoped pull), and whether the start keeps its full pull, is the maintainer's question
tutti-94ru, which tutti-qatu.4 and tutti-qatu.7 wait on.

## 3. A push moves the Linear issue; the local version wins

spk-pec0lu (NOE-7, Todo in Linear) was claimed and pushed by ID:

```
$ bd update spk-pec0lu --claim
$ bd linear sync --push --prefer-local --issues spk-pec0lu
Acquiring sync lock...
✓ Pushed 1 issues
✓ Linear sync complete

Linear NOE-7 after: "state":{"name":"In Progress","type":"started"}
```

Then NOE-7's title, description, priority (Urgent) and state (In Review) were edited in Linear,
the ticket closed locally, and pushed again:

```
$ bd close spk-pec0lu --reason done
$ bd linear sync --push --prefer-local --issues spk-pec0lu
✓ Pushed 1 issues

Linear NOE-7 after: "title":"THROWAWAY tutti spike qatu.1: backlog gate, edited in Linear twice (delete me)",
  "description":"Throwaway issue made by tutti's spike tutti-qatu.1. Deleted when the spike ends.",
  "priority":3,"state":{"name":"Done","type":"completed"}
```

The local version won wholesale: Linear's title, description and priority edits were overwritten,
not only the state. Without `--prefer-local` it is the same: spk-7bkaks was claimed, NOE-8's title
then edited in Linear (Linear newer), and a plain push overwrote it:

```
$ bd linear sync --push --issues spk-7bkaks   (no --prefer-local)
✓ Pushed 1 issues
Linear NOE-8 after: "title":"THROWAWAY tutti spike qatu.1: new issue for create-only (delete me)", "state":{"name":"In Progress"}

$ bd linear sync --push --prefer-local --issues spk-7bkaks   (nothing changed since)
✓ Linear sync complete            # nothing pushed: bd skips content unchanged since its last push
```

bd's source agrees: a push-only sync updates a linked Linear issue whenever its content differs
from the ticket's (Linear's `ContentEqual` push hook in `cmd/bd/linear.go`, not timestamps), and
`--prefer-local` decides conflicts only in a bidirectional sync. tutti still passes it, as the spec
says, so a push stays local-wins should bd change that. Edits the maintainer makes in Linear to a ticket tutti pushes are lost at its next push.

## 4. Acceptance criteria, design and notes

A ticket with all four fields was created and pushed (it created NOE-9):

```
$ bd create --type task --title "THROWAWAY tutti spike qatu.1: fields pushed (delete me)" --description "DESC-MARK the description." --acceptance "AC-MARK the acceptance criteria." --design "DESIGN-MARK the design." --notes "NOTES-MARK the notes."
$ bd linear push spk-moq
linear: bead spk-moq: label "task" not found on Linear team (skipped)
✓ Pushed 1 issues
external_ref: https://linear.app/noesis-sol/issue/NOE-9/throwaway-tutti-spike-qatu1-fields-pushed-delete-me
```

NOE-9's description in Linear:

```
DESC-MARK the description.

## Acceptance Criteria

AC-MARK the acceptance criteria.

## Design

DESIGN-MARK the design.

## Notes

NOTES-MARK the notes.
<!-- bd-idempotency: a590f1df4a90 -->
```

**All three reach Linear**, as sections of its description. A push writes `external_ref` as the
issue's URL with its slug; a pull writes it without (`…/issue/NOE-9`): the Linear key is the path
segment after `issue/` either way.

They don't come back as fields. After a pull of NOE-9, the ticket's description is the whole of
Linear's, sections and idempotency marker included, while its acceptance criteria, design and notes
fields keep their old values. The next push appends the sections to that description again:

```
$ bd linear pull NOE-9
✓ Pulled 1 issues (0 created, 1 updated)
  description: 'DESC-MARK the description.\n\n## Acceptance Criteria\n\nAC-MARK … NOTES-MARK the notes.\n<!-- bd-idempotency: a590f1df4a90 -->'
  acceptance_criteria: 'AC-MARK the acceptance criteria.'
$ bd update spk-moq --claim
$ bd linear sync --push --prefer-local --issues spk-moq
Linear NOE-9 description after: … the sections twice …

# No edit in Linear since the last push
$ bd linear pull NOE-9
✓ Pulled 1 issues (0 created, 1 updated)
local description now has 2 Acceptance Criteria headings; status in_progress
$ bd update spk-moq --status open
$ bd linear sync --push --prefer-local --issues spk-moq
Linear NOE-9: Todo ; description has 3 Acceptance Criteria headings, 445 chars
```

A pull after a push always updates the ticket, as the push made Linear's issue newer. So **every
pull and push of a ticket with acceptance criteria, design or notes adds one more copy of them** to
both its description and the Linear issue. Under the fallback of point 2, tutti never pulls a
linked ticket it pushes, so it doesn't happen in a run; a full pull would start it (tutti-94ru's
third option). It is a bd defect, to report upstream: tutti-f4nw.

## 5. How long a pull and a one-ticket push take

Five of each, the key already in the environment, from the scratch database (a handful of tickets):

```
1.65 s  exit 0  bd linear pull NOE-8
1.03 s  exit 0  bd linear pull NOE-8
1.03 s  exit 0  bd linear pull NOE-8
0.96 s  exit 0  bd linear pull NOE-8
1.01 s  exit 0  bd linear pull NOE-8
2.53 s  exit 0  bd linear sync --push --prefer-local --issues spk-7bkaks
2.29 s  exit 0  bd linear sync --push --prefer-local --issues spk-7bkaks
1.94 s  exit 0  bd linear sync --push --prefer-local --issues spk-7bkaks
2.11 s  exit 0  bd linear sync --push --prefer-local --issues spk-7bkaks
1.72 s  exit 0  bd linear sync --push --prefer-local --issues spk-7bkaks
```

The other pulls and pushes above, timed with `/usr/bin/time` through the key wrapper (about 1.1 s
of `zsh -i` start), took 2.9 to 5.3 s, so 1.8 to 4.2 s of bd. A full pull was not run (no unscoped
pull); it reads every issue of the team, and its time grows with the team. The
project's own database is far larger than the scratch one, which adds to each call.

**Proposed limits:** a pull, 60 s; a push of one ticket, 30 s: more than ten times what was
measured, and short enough that a hung call doesn't hold bd's lock (one process at a time) for long.
The contract test (tutti-qatu.10) measures them again on each bd bump.

## 6. The oldest bd that has all of it

From bd's source (`git grep` at each release tag of github.com/gastownhall/beads), what tutti uses
and the first release with it:

| What | First release |
|---|---|
| `--create-only`, `--prefer-local` on `bd linear sync` | 0.30.7 |
| `bd linear pull <refs>`, `bd linear push <ids>`, `--issues` (`cmd/bd/sync_push_pull.go`, `sync_flags.go`) | 1.0.1 |
| Acceptance criteria, design and notes as description sections (`internal/linear/mapping.go`) | 1.0.1 or before |
| `--relations`, idempotency markers on create | 1.0.4 |
| `linear.outbound_state_map.<status>` (PR #4119, 2026-07-06) | **1.2.0** |

**bd 1.2.0** (2026-08-11) is the oldest: before it, a push to a team with two states of one type
(NOE's In Progress and In Review) fails (1.1.2: `linear.state_map type fallback is ambiguous for
beads status …`) with no key to choose one. Only 1.3.4 was run; 1.2.0 is
read from its source. tutti's startup check, when the linear block is there, can require bd ≥ 1.2.0
(`bd version` prints `bd version 1.3.4 (Homebrew)`), and the contract test pins what was run.

## What the design takes from this

- **Pulls:** by reference only, new issues and handed-over deferred ones (point 2's fallback);
  how tutti lists them, and whether the start keeps a full pull, waits on tutti-94ru.
- **Pushes:** by ticket ID, `bd linear sync --push --prefer-local --issues <id>`, as the spec has
  them. Linear-side edits of a pushed ticket are overwritten.
- **Setup** writes `linear.state_map.backlog deferred` and the other four types, and
  `linear.outbound_state_map.<status>` for open, in_progress, deferred and closed (point 1, 3).
- **Limits:** 60 s a pull, 30 s a push (point 5).
- **bd:** 1.2.0 or later when the linear block is there (point 6).
