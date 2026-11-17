# The Linear sync

Filing work in Linear and watching it move there while tutti works it: setting the sync up, what a
synced run does, what goes to Linear and what never does, what a failed pull or push means, and
turning it off. Back to the [README](../README.md).

The sync is optional and off unless you set it up. A project without it gets a tutti that knows
nothing of Linear: no `bd linear` process, no call to Linear, no check and no line of output. It is
built on Beads' own Linear sync, `bd linear`; Beads stays what a run reads and writes.

In short: you file an issue in your Linear team and move it to **Todo** when it is ready. tutti's
next pull makes it a ticket, a worker takes it, and Linear shows it move to **In Progress** and
**Done** as the ticket is worked, merged and closed. The tickets a run files, a worker's follow-ups
say, are created in Linear too.

## What you need

- A Linear team, which the sync files issues in and reads them from.
- Beads 1.3.0 or later, whose `bd linear` has the outbound state map a team with two states of one
  type (In Progress and In Review, say) needs. `bd version` says which you have.
- A personal API key of a Linear account that reaches the team.

## Creating the key and keeping it

1. Create a personal API key in Linear, under Settings, Account, Security & access
   (<https://linear.app/settings/account/security>).
2. Export it in your shell's profile (`~/.zshrc`, `~/.bashrc`), so that every shell that starts
   tutti has it:

   ```sh
   export LINEAR_API_KEY=lin_api_...
   ```

3. Open a new shell, or `source` the profile.

tutti reads the key from the environment and nowhere else. It never stores it: not in the
settings, not in the log, an event or a transcript, and not in bd's configuration. Keep it out of
bd's configuration yourself too: never `bd config set linear.api_key`, as bd keeps its
configuration in the Beads database, which syncs to your git remote. tutti's setup warns if it finds
one there. tutti gives the key only to the `bd linear` processes it starts: no worker, check or
organ gets it, whether the sync is on or not.

For automation, bd's OAuth pair, `LINEAR_OAUTH_CLIENT_ID` and `LINEAR_OAUTH_CLIENT_SECRET`, does
what the key does; tutti treats it the same way. `tutti linear setup` itself needs the key.

## Turning it on

### `tutti linear setup`

In a project `tutti init` has set up, with the key in the environment:

```
tutti linear setup
```

It reads the teams the key reaches and asks which one to sync with (`--team NOE` answers it; a key
that reaches one team takes it), reads that team's workflow states, and shows the mapping:

```
Linear team NOE (Noesis)
Linear to Beads: backlog deferred, unstarted open, started in_progress, completed closed, canceled closed; an issue in Backlog waits, deferred, until it is moved to Todo
Beads to Linear: open Todo, in_progress In Progress, deferred Backlog, closed Done
```

Where the team has more than one state of a type, such as In Progress and In Review, it asks which
one a ticket in that status moves its issue to. It then sets bd's configuration (`linear.team_id`,
`linear.state_map.<type>`, `linear.outbound_state_map.<status>`) and writes the `linear` block to
`.tutti/settings.json`:

```json
{
  "linear": { "team": "NOE", "pull_every": "10m" }
}
```

Commit the settings: the block is what turns the sync on, for every run in the project. Run the
setup again whenever you like: it sets only what differs and says what it changed, or
`Nothing changed`. Without a terminal it asks nothing (each state is the first of its type, and a key
that reaches several teams needs `--team`). Without the key it says where to create one and writes
nothing.

`pull_every` is how often a run pulls after the pull it starts with, `"10m"` by default; `"0"` pulls
at the start only. [The linear block](setup.md#the-linear-block) has its keys.

### From `tutti init`

`tutti init` asks *Sync tickets with Linear?*, with **No** selected. No writes nothing. Yes takes
the setup's steps in the form: the team, the states, then the mapping to confirm. With no key in
the environment, Yes says where to create one and how to export it, and `init` goes on: run
`tutti linear setup` once the key is there. `--linear NOE` answers the question for a script, and
`--linear=false` declines it. A project whose settings hold the block already isn't asked.

### By hand

The block can be written by hand, and bd's keys set with `bd config set`. A run's start then checks
what the sync needs and says what is missing (see [The start's warnings](#the-starts-warnings)).

## A synced run

The START block names the sync:

```
linear: NOE, pull at start and every 10m
```

**The gate is Todo.** An issue in Linear's Backlog is pulled as a deferred ticket, which no run
starts. Moving it to Todo hands it to tutti: the next pull opens the ticket, and the run takes it
as it takes any ready ticket. No label or project is needed. An issue filed straight into Todo is
worked from the next pull.

**Pulls.** Once as the run starts, before it fills its slots, and then every `pull_every`, tutti
lists the team's issues from Linear and pulls the ones it may take: issues no ticket links yet (not
completed or canceled), which become tickets, and issues whose tickets are deferred here that have
left Backlog, which hands them over. Each pull says what it did:

```
LINEAR: pulled from NOE at the start: added NOE-5, NOE-6; released NOE-3
```

A pull never changes a ticket a run holds (one a worker has, one waiting to merge, one set aside),
nor any linked ticket that isn't deferred. So once an issue is a ticket, Linear's edits of it, its
title or description, no longer reach Beads: change the ticket with `bd` instead.

**Pushes.** As a linked ticket's worker starts, as it merges and closes, and as it is deferred or
set aside for review, tutti writes its status to Linear, the issue moving to the state the setup
mapped:

```
LINEAR: t-1 closed, pushed to NOE-12 (updated)
```

Pushes run in the background, one at a time: a merge never waits on Linear.

**Shown.** In a synced run, a ticket linked to a Linear issue shows the issue's key beside its ID,
faint, in its row, on its card and in its worker view (`t-1 NOE-12`), and the log names it the same
way. The summary counts what the sync did:

```
Linear  3 pulls · 2 added · 1 released · 4 pushed (1 created)
```

and the run report names the Linear issues the run closed.

## What goes to Linear, and what never does

Goes to Linear:

- The status of each ticket linked to a Linear issue, as above.
- Each ticket filed during a run, a worker's follow-ups and what tutti files itself: it is created
  in the team as it is filed, linked, and pushed as the others are from then on. Its title,
  description, status and priority go with it, and its acceptance criteria, design and notes as
  sections of the issue's description.

Never goes to Linear:

- The backlog's history: tickets that were there before the run and aren't linked.
- The questions tutti files for you (label `human`): they stay in tutti, for `tutti answer` and the
  dashboard.
- Epics and ephemeral tickets.
- Assignees, comments, a ticket's parent and its links. A ticket's type goes only where the team
  has a label of that name; tutti creates no labels.
- The key, or anything of your login.

**The local version wins.** A push writes the ticket as Beads has it: a linked issue's title,
description or priority edited in Linear is overwritten at the ticket's next push. Edit the ticket,
not the issue, once it is linked.

## When a pull or push fails

The sync never stops a run, holds a fill or changes the exit code.

- **A pull that fails**, Linear refusing the key or unreachable, `bd` failing or past its time limit
  (60 s), says so once and changes nothing:

  ```
  LINEAR_PULL_FAILED: Linear refused the key: …; the run goes on with the backlog it has
  ```

  The run works the backlog it has, and the next pull lists the same issues again, so nothing filed
  meanwhile is missed once the cause is gone. An issue `bd` couldn't pull is named on the pull's
  line, `could not pull NOE-9 (not found in Linear)`.

- **A push that fails** says so and is tried again at the run's end:

  ```
  LINEAR: t-1 closed, not pushed: …; tried again at the run's end
  ```

  The end waits up to a minute for the pushes still queued, tries each failed one once more, and
  lists those that still failed:

  ```
  LINEAR_PUSH_FAILED: t-1: …
  ```

  The ticket itself is as the run left it; only its Linear issue is behind. A later run pushes it
  when its status next changes; to bring it up to date now, once the cause is fixed:

  ```sh
  bd linear sync --push --prefer-local --issues t-1
  ```

  Always name the ticket: `bd linear sync --push` with no `--issues` creates an issue for every
  ticket in the backlog, and a pull with none overwrites every linked ticket with Linear's version.

### The start's warnings

With the block there, a run's start checks for the credentials, for a `bd` that has `bd linear`,
and for bd's state map. Each lack is a warning, and the run goes on without the sync:

| Warning | What to do |
|---|---|
| `linear: not syncing: no LINEAR_API_KEY in the environment …` | export the key in the shell that starts tutti ([Creating the key](#creating-the-key-and-keeping-it)) |
| `linear: not syncing: the installed bd has no bd linear; update Beads` | update Beads to 1.3.0 or later |
| `linear: not syncing: bd's configuration has no state map for …` | run `tutti linear setup` |
| `linear: not syncing: could not run bd linear: …` or `could not read bd's configuration: …` | what bd said follows; `bd doctor` may say more |

## Turning it off

- **For one run:** `tutti --no-linear`, or `TUTTI_NO_LINEAR=1`. The START block says
  `linear: off, --no-linear`.
- **For good:** remove the `linear` block from `.tutti/settings.json` and commit it. The run then
  knows nothing of Linear again. Tickets already linked keep their link (`external_ref`) and are
  simply no longer synced; their issues stay in Linear as they last were. bd's `linear.*`
  configuration is left in place, harmless without the block; `bd config unset <key>` removes a key
  if you want it gone (`bd config list` shows them).
- **The key:** remove the `export` from your shell's profile, and revoke the key in Linear under
  Settings, Account, Security & access.

Setting it up again later is `tutti linear setup`.

## Checking the sync against Linear

For tutti's contributors, on each Beads update: a contract test runs the sync against a real Linear
team, through tutti's own setup and `bd linear` calls, and checks what the sync rests on: the
Backlog gate, a pull by key changing only what it names, a push moving the issue with the local
version winning, acceptance criteria, design and notes reaching the issue, the time a pull and a push
take, and the version of Beads. It runs only with its variable and the key:

```sh
TUTTI_LIVE_LINEAR=1 TUTTI_TEST_LINEAR_TEAM=NOE scripts/test.sh test/contract/linear.test.ts
```

`TUTTI_TEST_LINEAR_TEAM` names the team, unless the key reaches only one. The test works in a
scratch Beads database, files only issues titled `THROWAWAY tutti contract …` and deletes them for
good as it ends, then checks the team holds none and that the project's `linear.*` configuration is
as it was.
