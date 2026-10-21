
## Verify
- Before you close the ticket, once `scripts/check-fast.sh` passes after your last commit, have the
  verifier subagent (.claude/agents/verifier.md) check your change: give it the ticket's ID, TICKET_ID,
  and nothing of your reasoning. Run it in the foreground and wait for its answer.
- Fix each gap it reports that affects correctness or the ticket's requirements, commit, run the
  check again, and ask it again. The rest is optional: note on the ticket any you leave.
- After three rounds that still end in FAIL, note its findings on the ticket. Close the ticket only
  when you judge them outside the ticket's requirements; otherwise defer it, as under Close.
