# Usage-limit fixtures

A turn that ends on the account's usage limit (§ 4.12), one SDK message per line, as AgentHost's
live layer reads them from the stream. The contract tests (`test/contract/sdk.test.ts`) can't
reach a usage limit on demand, so these stand in for it. `test/usage-limit-fixtures.test.ts`
folds them through WorkerState.

- `rejected.jsonl`: the limit as a subscription login meets it. A `rate_limit_event` with
  `status: "rejected"` and its `resetsAt`, an assistant message with `error: "rate_limit"`, and a
  `success` result with `is_error: true` and `api_error_status: 429`.
- `result-429.jsonl`: the same turn with only the result's `is_error` and `api_error_status: 429`.
- `allowed.jsonl`: two `allowed` rate_limit_events of one worker's session, unedited, from the
  mnemos run of 2026-10-23 (SDK 0.3.301, Claude Code 2.1.301): no top-level `utilization`, and the
  account's windows in `unifiedWindows`, a field the SDK's types don't name, the five-hour window
  rising a point between them. `test/usage-windows.test.ts` reads them.

Each line was taken from a real session of SDK 0.3.301 and its embedded Claude Code 2.1.301, recorded
during a contract-test run on 2026-10-17 (an `allowed_warning` rate_limit_event, the assistant
message and the `success` result of a turn). Then these fields were edited to show the limit:

- the event's `status`, `rateLimitType`, `utilization` and `surpassedThreshold`;
- the assistant message's `error`, text and usage;
- the result's `is_error`, `api_error_status`, `result` and costs.

The session and message IDs are made up, and the init keeps only the fields WorkerState and the
live layer read. Swap in a real recording when a session hits the limit.
