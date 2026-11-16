------------------------------ MODULE Scheduler ------------------------------
(* A model of tutti's scheduler and of the loop that ends a run, small enough for TLC to try
   every order of their steps. SKILL.md beside it says what it covers and how to read a result.

   Three kinds of fiber share the state:
     the loop     src/run/look.ts (nothingLeft, untilDone), its fill in src/run/schedule/fill.ts,
                  and the end's decision in src/run/runEnd.ts (whatsLeft, decide);
     a ticket     its fiber from src/run/schedule/slots.ts (occupy) to its release, with the three
                  ways its work ends that matter here;
     the merges   src/run/mergequeue.ts, a ticket from the line to merged.

   A step of the model is one read or one write of state the fibers share, or a run of them with
   no await between. With AnyYield FALSE a fiber is switched out only where the code may await bd,
   git, a worker or a file, which is how Effect runs fibers until one has done some 2000 steps in
   a row; with AnyYield TRUE it may be switched out between any two steps. *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  N,            \* the tickets are 1..N, in the order bd ready lists them
  Concurrent,   \* --concurrent: the slots
  Limit,        \* --limit: the most tickets the run starts
  MaxRequeues,  \* how often one ticket may go back in the queue from Working
  AnyYield,     \* whether a fiber may be switched out between any two steps
  Assume,       \* what is taken for granted, each name a finding when it is left out:
                \*   "everyLookFills"       no look is woken by an attention change alone
                \*   "releaseCountsAtOnce"  a fiber frees its slot and counts its end in one step
  Variant       \* "asCode", or the name of a break put in on purpose (see the actions)

Tickets == 1..N
None == 0       \* no ticket
Loop == N + 1   \* the loop, where `hot` names a fiber

VARIABLES
  \* The shape of the backlog, chosen at the start and never changed.
  solo,         \* the tickets labelled solo (holds.ts isSolo)
  overlap,      \* the pairs whose footprints share an area or a function (holds.ts overlapHold)
  blocks,       \* <<a, b>>: a blocks b in bd
  \* What the fibers share.
  bd,           \* bd's status of each ticket: "open", "claimed", "closed", "deferred"
  phase,        \* the ledger's phase of each ticket (phase.ts), "None" for one not in it
  running,      \* Slots.running: the tickets whose fibers hold a slot
  slotsVer,     \* counts the changes of Slots.running, for fill.ts's `running !== s.running`
  started,      \* Slots.started: what --limit counts
  ends,         \* Scheduling.ends: the fibers ended, each counted once its slot is freed
  uncounted,    \* fibers whose slot is freed and whose end is not counted yet
  inQueue,      \* the merge queue's waiting and merging tickets
  \* A ticket's fiber.
  fpc,          \* where it is
  relAgain,     \* release's `again`: its start is given back to --limit
  requeues,     \* how often it went back in the queue from Working
  dispatches,   \* how often the fill dispatched it
  twice,        \* whether a ticket was dispatched while its last fiber still held its slot
  \* The loop.
  lpc,          \* where it is
  first,        \* whether no look has been taken yet
  why,          \* what woke the look: "read" (it fills) or "attn" (an attention change alone)
  mergedBefore, \* Look.mergedBefore
  filledAt,     \* look.ts's filledAt
  found,        \* the fill's read of bd ready
  queue,        \* readQueue's candidates
  snapPhase,    \* lineUp's read of the ledger
  snapRunning,  \* lineUp's read of the slots
  snapVer,      \* slotsVer as lineUp read the slots
  lCanTake,     \* Look.canTake
  lRunning,     \* Look.running
  lSettled,     \* Look.settled
  \* Which fiber is in a run of steps with no await between, or None.
  hot

shape == <<solo, overlap, blocks>>
shared == <<bd, phase, running, slotsVer, started, ends, uncounted, inQueue>>
fibers == <<fpc, relAgain, requeues, dispatches, twice>>
looks == <<lpc, first, why, mergedBefore, filledAt, found, queue, snapPhase, snapRunning,
           snapVer, lCanTake, lRunning, lSettled>>
vars == <<shape, shared, fibers, looks, hot>>

-----------------------------------------------------------------------------
(* What the code computes from a reading of the ledger (ph) and of the slots (run). The fill
   applies these to what lineUp read; the properties apply them to the state as it is. *)

\* slots.ts waiting: Queued or HeldBack.
Waiting(ph, t) == ph[t] \in {"Queued", "HeldBack"}

\* slots.ts mergingIn: past their work, not merged, holding no slot. Merging is folded into ToMerge.
Past(ph, run) == {t \in Tickets : ph[t] = "ToMerge" /\ t \notin run}

\* slots.ts prune: the tickets whose issue and solo label the slots keep.
Kept(ph, run) == run \cup Past(ph, run)

\* slots.ts taken and slotFree: no ticket is handed back to its worker in this model.
Taken(ph, run) ==
  Cardinality(run) +
    (IF Cardinality(Past(ph, run)) > Concurrent
       THEN Cardinality(Past(ph, run)) - Concurrent ELSE 0)
SlotFree(ph, run) == Taken(ph, run) < Concurrent

\* holds.ts mergeHold, notMerged: a blocker at work or closed and not merged.
MergeHeld(ph, t) == \E a \in Tickets : <<a, t>> \in blocks /\ ph[a] \in {"Working", "ToMerge"}

\* fill.ts overlapping: never asked of a solo ticket.
OverlapHeld(ph, run, t) == t \notin solo /\ \E a \in Kept(ph, run) : {a, t} \in overlap

\* bd ready: open, and every blocker closed.
BdReady == {t \in Tickets : bd[t] = "open" /\ \A a \in Tickets : <<a, t>> \in blocks => bd[a] = "closed"}

First(S) == CHOOSE t \in S : \A u \in S : t <= u

-----------------------------------------------------------------------------
(* One pass of fillSlots, from what lineUp read. *)

\* fill.ts lineUp: "waiting(state, issue.id) && !was.running.has(issue.id)".
\* Variant "noRunningCheck" drops the second half.
InLine == {t \in queue : Waiting(snapPhase, t) /\ (Variant = "noRunningCheck" \/ t \notin snapRunning)}
Slot == SlotFree(snapPhase, snapRunning)
\* fill.ts holdsOf, choose.
NotHeld == {t \in InLine : ~MergeHeld(snapPhase, t)}
Skipped == IF Slot THEN {t \in NotHeld : OverlapHeld(snapPhase, snapRunning, t)} ELSE {}
Free == NotHeld \ Skipped
KeptRead == Kept(snapPhase, snapRunning)
\* fill.ts pick.
Start ==
  IF Free # {} /\ solo \cap KeptRead = {} /\ ~(First(Free) \in solo /\ KeptRead # {})
    THEN First(Free) ELSE None
HeldSet == (InLine \ NotHeld) \cup Skipped \cup (IF Slot /\ Start = None THEN Free ELSE {})

-----------------------------------------------------------------------------
Init ==
  /\ solo \in SUBSET Tickets
  /\ overlap \in SUBSET {{x, y} : x, y \in Tickets}
  /\ \A pair \in overlap : Cardinality(pair) = 2
  /\ blocks \in SUBSET {pair \in Tickets \X Tickets : pair[1] < pair[2]}
  /\ bd = [t \in Tickets |-> "open"]
  /\ phase = [t \in Tickets |-> "None"]
  /\ running = {}
  /\ slotsVer = 0
  /\ started = 0
  /\ ends = 0
  /\ uncounted = 0
  /\ inQueue = {}
  /\ fpc = [t \in Tickets |-> "idle"]
  /\ relAgain = [t \in Tickets |-> FALSE]
  /\ requeues = [t \in Tickets |-> 0]
  /\ dispatches = [t \in Tickets |-> 0]
  /\ twice = FALSE
  /\ lpc = "wait"
  /\ first = TRUE
  /\ why = "read"
  /\ mergedBefore = TRUE
  /\ filledAt = 0
  /\ found = {}
  /\ queue = {}
  /\ snapPhase = phase
  /\ snapRunning = {}
  /\ snapVer = 0
  /\ lCanTake = TRUE
  /\ lRunning = {}
  /\ lSettled = TRUE
  /\ hot = None

\* `who` goes on: `sync` when no await can come before its next step.
Go(who, sync) == hot' = IF AnyYield \/ ~sync THEN None ELSE who
MayStep(who) == hot \in {None, who}

-----------------------------------------------------------------------------
(* The loop: look.ts. Any wake may come at any time (the ready poll does every 30 s), so a look
   may begin whenever the loop waits. The first look has no reason recorded and reads. A look
   takes its reasons (wakes.take) and reads mergedBefore with no await between. *)

Wake ==
  /\ lpc = "wait"
  /\ why' \in (IF first \/ "everyLookFills" \in Assume THEN {"read"} ELSE {"read", "attn"})
  /\ first' = FALSE
  /\ lpc' = "begin"
  /\ Go(Loop, TRUE)
  /\ UNCHANGED <<shape, shared, fibers, mergedBefore, filledAt, found, queue, snapPhase,
                 snapRunning, snapVer, lCanTake, lRunning, lSettled>>

\* nothingLeft: mergedBefore, then "filledAt = yield* scheduler.ends" before the fill.
\* Variant "filledAtAfter" reads filledAt once the fill is over instead.
Begin ==
  /\ lpc = "begin"
  /\ mergedBefore' = (inQueue = {})
  /\ IF why = "read"
       THEN /\ filledAt' = (IF Variant = "filledAtAfter" THEN filledAt ELSE ends)
            /\ lpc' = "read1"
       ELSE /\ filledAt' = filledAt
            /\ lpc' = "k1"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, found, queue, snapPhase, snapRunning,
                 snapVer, lCanTake, lRunning, lSettled>>

\* fill.ts readQueue: bd ready, read by a bd process, is what it was when that process ran.
Read1 ==
  /\ lpc = "read1"
  /\ found' = BdReady
  /\ lpc' = "read2"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, queue, snapPhase,
                 snapRunning, snapVer, lCanTake, lRunning, lSettled>>

\* readQueue's candidates (slots.ts candidate), queueCandidates and dropUnready. Only a fill
\* moves a ticket into the ledger or a waiting one out of it, and one fill runs at a time
\* (oneFill), so its several ledger moves are one step here.
Read2 ==
  /\ lpc = "read2"
  /\ LET cands == {t \in found : phase[t] = "None" \/ Waiting(phase, t)} IN
       /\ queue' = cands
       /\ phase' = [t \in Tickets |->
            IF t \in cands /\ phase[t] = "None" THEN "Queued"
            ELSE IF Waiting(phase, t) /\ t \notin found THEN "None"
            ELSE phase[t]]
  /\ lpc' = "line1"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, bd, running, slotsVer, started, ends, uncounted, inQueue, fibers, first,
                 why, mergedBefore, filledAt, found, snapPhase, snapRunning, snapVer, lCanTake,
                 lRunning, lSettled>>

\* fill.ts lineUp, slots.ts current: the ledger, then the slots.
Line1 ==
  /\ lpc = "line1"
  /\ snapPhase' = phase
  /\ lpc' = "line2"
  /\ Go(Loop, TRUE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapRunning, snapVer, lCanTake, lRunning, lSettled>>

\* holdsOf and choose follow, which may read bd and git: the pass decides on what was read here.
Line2 ==
  /\ lpc = "line2"
  /\ snapRunning' = running
  /\ snapVer' = slotsVer
  /\ lpc' = "p1"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapPhase, lCanTake, lRunning, lSettled>>

\* The fill is over: on to the look's reads.
FillOver ==
  /\ lpc' = "k1"
  /\ filledAt' = (IF Variant = "filledAtAfter" THEN ends ELSE filledAt)

\* fill.ts startOrPlace, to mayStart's reading of the slots: a pick made with no slot free picks
\* again if one has freed; with a slot, the ticket starts only if one is free still.
P1 ==
  /\ lpc = "p1"
  /\ lpc' = IF Start # None /\ ~Slot
              THEN (IF SlotFree(phase, running) THEN "line1" ELSE "place")
            ELSE IF Start = None THEN "place"
            ELSE IF SlotFree(phase, running) THEN "p2" ELSE "place"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapPhase, snapRunning, snapVer, lCanTake, lRunning, lSettled>>

\* dispatch.ts mayStart, after beforeStart: the gate, of which the model has --limit.
P2 ==
  /\ lpc = "p2"
  /\ lpc' = IF started < Limit THEN "p3" ELSE "place"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapPhase, snapRunning, snapVer, lCanTake, lRunning, lSettled>>

\* startOrPlace's placing (place.ts placeWaiting) of every ticket in line.
Place ==
  /\ lpc = "place"
  /\ phase' = [t \in Tickets |->
       IF t \in InLine /\ Waiting(phase, t)
         THEN (IF t \in HeldSet THEN "HeldBack" ELSE "Queued")
         ELSE phase[t]]
  /\ lpc' = "check"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, bd, running, slotsVer, started, ends, uncounted, inQueue, fibers, first,
                 why, mergedBefore, filledAt, found, queue, snapPhase, snapRunning, snapVer,
                 lCanTake, lRunning, lSettled>>

\* "overlaps.skipped.size > 0 && (yield* Ref.get(sched.slots)).running !== s.running": again.
Check ==
  /\ lpc = "check"
  /\ IF Skipped # {} /\ slotsVer # snapVer
       THEN lpc' = "line1" /\ filledAt' = filledAt
       ELSE FillOver
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, found, queue, snapPhase,
                 snapRunning, snapVer, lCanTake, lRunning, lSettled>>

\* dispatch.ts dispatch and slots.ts occupy: counted, Working, its fiber in a slot. The ledger
\* refuses a ticket no longer waiting, and nothing starts. No other fiber reads what lies between
\* these writes in a way the properties see, so they are one step.
P3 ==
  /\ lpc = "p3"
  /\ IF Waiting(phase, Start)
       THEN /\ phase' = [phase EXCEPT ![Start] = "Working"]
            /\ started' = started + 1
            /\ running' = running \cup {Start}
            /\ slotsVer' = slotsVer + 1
            /\ dispatches' = [dispatches EXCEPT ![Start] = @ + 1]
            /\ twice' = (twice \/ Start \in running)
            /\ fpc' = [fpc EXCEPT ![Start] = "work"]
            /\ lpc' = "line1"
            /\ filledAt' = filledAt
       ELSE /\ FillOver
            /\ UNCHANGED <<phase, started, running, slotsVer, dispatches, twice, fpc>>
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, bd, ends, uncounted, inQueue, relAgain, requeues, first, why,
                 mergedBefore, found, queue, snapPhase, snapRunning, snapVer, lCanTake,
                 lRunning, lSettled>>

\* nothingLeft's reads after the fill, in the code's order: the scheduler's running, the gate
\* (canTake), the merge queue (settled), and, last, endedSinceFill. Release2 frees a slot and gives
\* its start back to --limit in one step, so a look that read the slot free reads the limit after.
K1 ==
  /\ lpc = "k1"
  /\ lRunning' = running
  /\ lpc' = "k2"
  /\ Go(Loop, TRUE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapPhase, snapRunning, snapVer, lCanTake, lSettled>>

K2 ==
  /\ lpc = "k2"
  /\ lCanTake' = (started < Limit)
  /\ lpc' = "k3"
  /\ Go(Loop, TRUE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapPhase, snapRunning, snapVer, lRunning, lSettled>>

K3 ==
  /\ lpc = "k3"
  /\ lSettled' = (inQueue = {})
  /\ lpc' = "k4"
  /\ Go(Loop, TRUE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapPhase, snapRunning, snapVer, lCanTake, lRunning>>

\* endedSinceFill, then runEnd.ts whatsLeft and decide: Done ends the run, anything else waits
\* for the next wake. Variant "noEndedSinceFill" leaves `freed` out of `done`.
K4 ==
  /\ lpc = "k4"
  /\ LET endedSinceFill == ends # filledAt
         freed == Variant # "noEndedSinceFill" /\ endedSinceFill /\ lCanTake
         done == ~freed /\ lRunning = {} /\ mergedBefore /\ lSettled
     IN lpc' = IF done THEN "ended" ELSE "wait"
  /\ Go(Loop, FALSE)
  /\ UNCHANGED <<shape, shared, fibers, first, why, mergedBefore, filledAt, found, queue,
                 snapPhase, snapRunning, snapVer, lCanTake, lRunning, lSettled>>

LoopStep ==
  /\ MayStep(Loop)
  /\ \/ Wake \/ Begin \/ Read1 \/ Read2 \/ Line1 \/ Line2 \/ P1 \/ P2 \/ Place \/ Check \/ P3
     \/ K1 \/ K2 \/ K3 \/ K4

-----------------------------------------------------------------------------
(* A ticket's fiber, from occupy to its release. Its work ends one of three ways here: its
   worker closes it and it goes to the merge queue; it is set aside; or it goes back in the
   queue (work.ts mergedSinceCut), its fiber ending a few steps later. *)

FiberMove(t, to) ==
  /\ fpc' = [fpc EXCEPT ![t] = to]
  /\ Go(t, FALSE)

\* Its worker claims it: bd ready lists it until then.
Claim(t) ==
  /\ fpc[t] = "work" /\ bd[t] = "open"
  /\ bd' = [bd EXCEPT ![t] = "claimed"]
  /\ FiberMove(t, "work")
  /\ UNCHANGED <<shape, phase, running, slotsVer, started, ends, uncounted, inQueue, relAgain,
                 requeues, dispatches, twice, looks>>

\* Its worker closes it in bd, which is when bd ready lists what it blocked.
Close(t) ==
  /\ fpc[t] = "work"
  /\ bd' = [bd EXCEPT ![t] = "closed"]
  /\ FiberMove(t, "closed")
  /\ UNCHANGED <<shape, phase, running, slotsVer, started, ends, uncounted, inQueue, relAgain,
                 requeues, dispatches, twice, looks>>

\* mergequeue.ts offer: the ledger first (ToMerge), then the queue's line.
Offer1(t) ==
  /\ fpc[t] = "closed"
  /\ phase' = [phase EXCEPT ![t] = "ToMerge"]
  /\ FiberMove(t, "offered")
  /\ UNCHANGED <<shape, bd, running, slotsVer, started, ends, uncounted, inQueue, relAgain,
                 requeues, dispatches, twice, looks>>

Offer2(t) ==
  /\ fpc[t] = "offered"
  /\ inQueue' = inQueue \cup {t}
  /\ FiberMove(t, "release")
  /\ UNCHANGED <<shape, bd, phase, running, slotsVer, started, ends, uncounted, relAgain,
                 requeues, dispatches, twice, looks>>

\* Set aside: deferred in bd, then Deferred in the ledger.
AsideBd(t) ==
  /\ fpc[t] = "work"
  /\ bd' = [bd EXCEPT ![t] = "deferred"]
  /\ FiberMove(t, "aside")
  /\ UNCHANGED <<shape, phase, running, slotsVer, started, ends, uncounted, inQueue, relAgain,
                 requeues, dispatches, twice, looks>>

Aside(t) ==
  /\ fpc[t] = "aside"
  /\ phase' = [phase EXCEPT ![t] = "Deferred"]
  /\ FiberMove(t, "release")
  /\ UNCHANGED <<shape, bd, running, slotsVer, started, ends, uncounted, inQueue, relAgain,
                 requeues, dispatches, twice, looks>>

\* work.ts mergedSinceCut: open in bd again, then Queued in the ledger (MergedSinceCut).
RequeueBd(t) ==
  /\ fpc[t] = "work" /\ requeues[t] < MaxRequeues
  /\ bd' = [bd EXCEPT ![t] = "open"]
  /\ FiberMove(t, "requeue")
  /\ UNCHANGED <<shape, phase, running, slotsVer, started, ends, uncounted, inQueue, relAgain,
                 requeues, dispatches, twice, looks>>

Requeue(t) ==
  /\ fpc[t] = "requeue"
  /\ phase' = [phase EXCEPT ![t] = "Queued"]
  /\ requeues' = [requeues EXCEPT ![t] = @ + 1]
  /\ FiberMove(t, "release")
  /\ UNCHANGED <<shape, bd, running, slotsVer, started, ends, uncounted, inQueue, relAgain,
                 dispatches, twice, looks>>

\* slots.ts occupy's release: it reads the ledger (requeued), ...
Release1(t) ==
  /\ fpc[t] = "release"
  /\ relAgain' = [relAgain EXCEPT ![t] = phase[t] \in {"None", "Queued", "HeldBack"}]
  /\ fpc' = [fpc EXCEPT ![t] = "release2"]
  /\ Go(t, TRUE)
  /\ UNCHANGED <<shape, shared, requeues, dispatches, twice, looks>>

\* ... frees its slot, giving its start back to --limit, shows the queue, and only then counts
\* its end. With no await between, the count is in this step; with any step a switch, and "releaseCountsAtOnce" not assumed, it is CountEnd's.
Release2(t) ==
  /\ fpc[t] = "release2"
  /\ running' = running \ {t}
  /\ slotsVer' = slotsVer + 1
  /\ started' = IF relAgain[t] THEN started - 1 ELSE started
  /\ IF AnyYield /\ "releaseCountsAtOnce" \notin Assume
       THEN uncounted' = uncounted + 1 /\ ends' = ends
       ELSE uncounted' = uncounted /\ ends' = ends + 1
  /\ FiberMove(t, "idle")
  /\ UNCHANGED <<shape, bd, phase, inQueue, relAgain, requeues, dispatches, twice, looks>>

CountEnd ==
  /\ hot = None
  /\ uncounted > 0
  /\ uncounted' = uncounted - 1
  /\ ends' = ends + 1
  /\ UNCHANGED <<shape, bd, phase, running, slotsVer, started, inQueue, fibers, looks, hot>>

FiberStep(t) ==
  /\ MayStep(t)
  /\ \/ Claim(t) \/ Close(t) \/ Offer1(t) \/ Offer2(t) \/ AsideBd(t) \/ Aside(t)
     \/ RequeueBd(t) \/ Requeue(t) \/ Release1(t) \/ Release2(t)

-----------------------------------------------------------------------------
(* The merges: mergequeue.ts. The ledger says Merged before the queue lets the ticket go. *)

Merge1(t) ==
  /\ hot = None
  /\ t \in inQueue /\ phase[t] = "ToMerge"
  /\ phase' = [phase EXCEPT ![t] = "Merged"]
  /\ UNCHANGED <<shape, bd, running, slotsVer, started, ends, uncounted, inQueue, fibers, looks,
                 hot>>

Merge2(t) ==
  /\ hot = None
  /\ t \in inQueue /\ phase[t] = "Merged"
  /\ inQueue' = inQueue \ {t}
  /\ UNCHANGED <<shape, bd, phase, running, slotsVer, started, ends, uncounted, fibers, looks,
                 hot>>

-----------------------------------------------------------------------------
Next ==
  \/ LoopStep
  \/ \E t \in Tickets : FiberStep(t) \/ Merge1(t) \/ Merge2(t)
  \/ CountEnd

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The properties. *)

\* A fill of the state as it is would start t: ready in bd, not taken up or waiting, nothing
\* holding it back, a slot free and --limit not reached.
Startable(t) ==
  /\ t \in BdReady
  /\ phase[t] = "None" \/ Waiting(phase, t)
  /\ t \notin running
  /\ started < Limit
  /\ SlotFree(phase, running)
  /\ ~MergeHeld(phase, t)
  /\ ~OverlapHeld(phase, running, t)
  /\ solo \cap Kept(phase, running) = {}
  /\ t \in solo => Kept(phase, running) = {}

\* The run never ends while a ticket it would start is ready.
NoEndWhileReady == lpc = "ended" => ~\E t \in Tickets : Startable(t)

\* A ticket is never dispatched while its last fiber still holds its slot, and it is dispatched
\* again only for each time it went back in the queue.
NeverStartedTwice == ~twice /\ \A t \in Tickets : dispatches[t] <= 1 + requeues[t]

TypeOK ==
  /\ running \subseteq Tickets
  /\ inQueue \subseteq Tickets
  /\ \A t \in Tickets : phase[t] \in
       {"None", "Queued", "HeldBack", "Working", "ToMerge", "Merged", "Deferred"}
  /\ hot \in 0..(N + 1)
=============================================================================
