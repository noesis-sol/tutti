---
name: verify-scheduler
description: Model-checks tutti's scheduler and the loop that ends a run (TLA+, TLC) for two properties, in every order of the fibers' steps - the run never ends while a ticket it would start is ready, and a ticket is never started twice. Use when a change touches src/run/look.ts, src/run/runEnd.ts, src/run/wakes.ts, src/run/schedule/ (fill, slots, dispatch, place), the merge queue's offer or end of a merge, or when a run ended early, left a ready ticket held, or started a ticket twice.
---

# verify-scheduler

A test of the scheduler tries the orders of steps someone wrote down. This check tries all of
them, in a small model of the code: `Scheduler.tla`, checked by TLC through `check.sh`.

## What it proves

- **The run never ends while a ticket it would start is ready** (`NoEndWhileReady`). Harm when
  it breaks: `tutti` exits with work left that the next fill would have started, and an unattended
  run stops hours early.
- **A ticket is never started twice** (`NeverStartedTwice`): it is not dispatched while its last
  fiber still holds its slot, and it is dispatched again only for each time it went back in the
  queue. Harm when it breaks: two workers in one worktree on one branch.

Both hold for the code as it is, with no assumption: the findings the model first gave are
mended, and the check expects none.

## Run it

```bash
.claude/skills/verify-scheduler/check.sh            # every case, then the covered code; about 75 s
.claude/skills/verify-scheduler/check.sh await      # one case
.claude/skills/verify-scheduler/check.sh --trace break-no-refill          # a counterexample's steps
```

It needs `java` (11 or later) and, the first time, the network: TLC 1.7.4 is fetched into
`.cache/tla/` and checked against its sha256 (`TLA2TOOLS` names another copy). It writes nothing
in the repository.

Each line of its output is a case and what it gave against what is expected:

| Cases | Expected | Meaning of a `FAIL` |
| --- | --- | --- |
| `await*`, `any-step*` | both properties hold | The model, as changed, breaks a property: a bug in the code it describes, or a mistake in the model. See "Reading a failure". |
| `finding-*` | violates `NoEndWhileReady` | The finding no longer shows. If the code was mended, see "When a finding is mended". |
| `break-*` | violates the property named | The model can no longer catch a break it used to: it was weakened. Undo that. |

The last line says whether the covered code is as it was when the model was last read against
it. Exit 0 is all as expected; 1 a case gave something else; 2 the covered code changed; 3 TLC
could not run.

## Does my change touch it

`covered.list` names the code the model describes, and `check.sh` hashes each entry. A change
inside one makes the check exit 2 and name it. The actions of `Scheduler.tla` they correspond to:

| Code | In the model |
| --- | --- |
| `src/run/look.ts` `nothingLeft`: `wakes.take`, `mergedBefore`, `filledAt` read before the fill, then the reads after it in order (running, gate, settled, `endedSinceFill` last); `untilDone`'s `refill`: a look that didn't fill, with nothing left, looks again, filling | `Wake`, `Begin`, `K1` to `K4`, `K4`'s `refill` |
| `src/run/runEnd.ts` `whatsLeft`, `decide` | `K4`'s `freed` and `done` |
| `src/run/wakes.ts` `reads`: a look woken by an attention change alone does not fill | `Wake`'s `why`, `Begin` |
| `src/run/schedule/fill.ts` `readQueue`, `queueCandidates`, `dropUnready` | `Read1`, `Read2` |
| `fill.ts` `lineUp`, `holdsOf`, `choose`, `pick` | `Line1`, `Line2`, and `InLine`, `NotHeld`, `Skipped`, `Free`, `Start`, `HeldSet` |
| `fill.ts` `startOrPlace`, `src/run/schedule/dispatch.ts` `mayStart`, `dispatch`, `src/run/schedule/place.ts` `placeWaiting` | `P1`, `P2`, `Place`, `Check`, `P3` |
| `src/run/schedule/slots.ts` `waiting`, `mergingIn`, `taken`, `slotFree`, `prune`, `candidate` | `Waiting`, `Past`, `Taken`, `SlotFree`, `Kept` |
| `slots.ts` `occupy`'s `release` (its end counted in the update that frees its slot), `requeued` | `Release1`, `Release2` |
| `src/run/holds.ts` `mergeHold`, `notMerged`, `takesNew` | `MergeHeld`, `started < Limit` |
| `src/run/work.ts` `mergedSinceCut` | `RequeueBd`, `Requeue` |
| `src/run/mergequeue.ts` `offer` (ledger, then the line), `merged` (the ledger says Merged first), `isSettled` | `Offer1`, `Offer2`, `Merge1`, `Merge2`, `inQueue = {}` |
| `src/run/run/watchers.ts` the merge wake, `src/run/blockedWatch.ts` the attention wake | why `Wake` may come at any time, for either reason |

## When the covered code changed

1. Read the diff of each entry `check.sh` names against its row above.
2. If a step's order, a condition or what a step reads changed, change the same action in
   `Scheduler.tla`. A step of the model is one read or write of state the fibers share, or a run
   of them with no `await` between; do not widen one to make a case pass.
3. Run `check.sh`. A `FAIL` in an `await*` or `any-step*` case after a faithful change is a
   finding about the code: report it with its trace, in the code's words, and leave the model
   failing rather than weaken a property.
4. Only when the model describes the code as it now is: `check.sh --confirm`. It records the
   hashes and the commit in `covered.confirmed`; commit that file with the change.

A change that only renames, moves or comments needs steps 1 and 4.

## Reading a failure

`check.sh --trace <case>` prints the counterexample, a step a line: which fiber stepped
(`LoopStep`, `FiberStep`, `Merge1`, `Merge2`) and the variables it changed. Tickets
are `1` and `2`; the first line gives the backlog's shape (`solo`, `overlap`, `blocks`). `lpc` is
where the loop is, `fpc` where each ticket's fiber is; the action of that name in
`Scheduler.tla` carries the code it stands for.

Read every result with the pstack `/statechart` skill: it shows an invariant's violation as its
shortest path in plain words, and draws how the system moves between states when the check
passes.

It is a real bug when each step of the trace is a step the code can take, in that order. It is
a modeling mistake when a step joins what the code separates by an `await`, splits what the code
does in one `Ref` update, or lets something happen the code forbids: mend the model, and say so.

## Open findings

None open. Those found on 2026-11-16 at commit 2f7a6ce5 are mended: `finding-attention-look`
(tutti-matr), `finding-limit-gap` (tutti-13gj) and `finding-release-gap` (tutti-4kjm).

### When a finding is mended

Change the model as "When the covered code changed" says. The finding's case should then hold
without its assumption: in `check.sh`'s `cases`, take the assumption out of the `await*` and
`any-step*` rows, delete the `finding-*` row, and move the paragraph above out of this file.

## The deliberate breaks

`Variant` in `Scheduler.tla` puts a known break in, so that a pass means something:

- `noEndedSinceFill`: `whatsLeft` without `freed`, the run's end before tutti-855y.
- `filledAtAfter`: `filledAt` read after the fill, not before it.
- `noRunningCheck`: `lineUp` without `!was.running.has(issue.id)`, so a ticket back in the queue
  is dispatched while its last fiber holds its slot.
- `noRefill`: a look an attention change alone woke, which doesn't fill, ends the run, before
  tutti-matr. Ticket 1 blocks ticket 2 and merges; a fill holds ticket 2 back; the merge ends
  and, before its wake is recorded, an attention change wakes a look that reads it all settled.

## What a pass covers, and what it does not

- **Bounds.** Two tickets, in every shape of solo labels, overlap and blocker between them; one
  or two slots; `--limit` 1 or none; a ticket goes back in the queue from Working at most once.
  `check.sh deep-three-tickets` is the `await` case with three tickets and none going back in
  the queue: 89 million states, about 5 minutes, run only when named. It held on 2026-11-16,
  with every look filling, before tutti-matr let a look be woken by an attention change alone.
- **Fibers.** `await*` cases switch a fiber out only where the code may await bd, git, a worker
  or a file; `any-step*` cases between any two steps.
- **Not in the model:** carried and resumed workers (`carry`), rechecks (`recheckSlot`), tickets
  handed back to their workers (Resolving, Fixing), merges that fail or stop, tickets set aside
  and undeferred outside the run (`leftReady`), parents held for subtickets, the holds (stops,
  the usage limit, the machine's cap, the disk), workers waiting on you, triage, the critic, the
  auditor, and quitting. A start through `carry` or `recheckSlot` is not checked for
  `NeverStartedTwice`.
- **Not a liveness check.** It does not show that a ready ticket starts in the end, only that
  the run does not end on it; a wake lost until the next ready poll is not seen.
- **A model, not the code.** It is as true as its rows above; `covered.list` is what says when
  to read them again.
