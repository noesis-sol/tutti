# Colour schemes

Where tutti's colours come from, how to choose a scheme, and how to write one. Back to the
[README](../README.md).

## Schemes and roles

tutti's colours come from a **colour scheme**. The default, `orchestra`, is orchestra's colours
carried over exactly, with the Charm theme of `huh` for the forms, whose dark variant is lighter than
`huh`'s so the forms' quiet text reads on a dark background. It is the only scheme built in.
Others are JSON files that a project or a person adds.

A scheme gives colours to **roles**, never to screen elements. A role is a meaning, such as `live`
(live work) or `needsYou`. Each part of the screen uses a role, and everything else is the same in
every scheme: bold, faint, italic, the glyphs, the words and the border shapes. So every state reads
the same whatever the colours, and colour is never the only signal: `■ blocked` and `◼ to merge`
keep their glyphs and words.

Each role has a variant for light backgrounds and one for dark ones. In the `orchestra` scheme:

**Status and structure:**

| Role | Light | Dark | Means |
|---|---|---|---|
| `live` | `#0E7490` | `#22D3EE` | live work: a picked-up ticket, a working worker, the `Current` label, spinners, ticket IDs |
| `done` | `#15803D` | `#4ADE80` | done: merged, completed, a worker's finished turn, `✓` |
| `notice` | `#A16207` | `#FACC15` | worth a look, nothing blocking: set aside, held back, resolving, fixing, testing (bold), retrying, usage, warnings, the stop question |
| `needsYou` | `#B91C1C` | `#F87171` | needs you: blocked, a permission request or question waiting, stopped, a stop line |
| `windingDown` | `#C2410C` | `#FB923C` | winding down, and only that |
| `frame` | `#9CA3AF` | `#6B7280` | frames: the totals strip, the tickets table, the `picking the next ticket…` box |
| `organ` | `#6D28D9` | `#A78BFA` | organs: triage verdicts (`◆`), organ lines, `tutti init`'s marks |
| `organText` | `#7C3AED` | `#C4B5FD` | the organ lines' text |
| `toMerge` | `#1D4ED8` | `#60A5FA` | waiting for its turn to merge (`◼ to merge`, `to merge (2nd)`) |
| `merging` | `#BE185D` | `#F472B6` | a merge under way (`◆ merging`) |
| `emphasis` | `#374151` | `#E5E7EB` | keys to press, the `Tickets` label, worker numbers, tool names, `steered` |
| `pill` | `#7D56F4` | `#7D56F4` | the title pill's background, and the frame of `tutti init`'s **Next** box |
| `pillText` | `#FAFAFA` | `#FAFAFA` | text on the pill |

**The report, transcripts and selection:**

| Role | Light | Dark | Used for |
|---|---|---|---|
| `heading1` | `#6D28D9` | `#A78BFA` | H1 in the run report and in the worker view |
| `heading2` | `#0E7490` | `#22D3EE` | H2 |
| `heading3` | `#374151` | `#E5E7EB` | H3 and below |
| `code` | `#BE185D` | `#F472B6` | inline code and code blocks |
| `link` | `#1D4ED8` | `#60A5FA` | links |
| `added` | `#15803D` | `#4ADE80` | added lines in diffs, an edit's `+N` |
| `removed` | `#B91C1C` | `#F87171` | removed lines in diffs, an edit's `−M` |
| `selection` | `#7D56F4` | `#7D56F4` | the background of selected text |
| `selectionText` | `#FAFAFA` | `#FAFAFA` | selected text |

**Forms:** the start question, `tutti init`'s form, the confirmations, the buttons on attention cards
and the composer.

| Role | Light | Dark | Used for |
|---|---|---|---|
| `formText` | `ansi:235` | `ansi:252` | options |
| `formTitle` | `#5A56E0` | `#7571F9` | field titles |
| `formAccent` | `#F780E2` | `#F780E2` | the selector, the prompt (`>`), a focused button's background |
| `formAccentText` | `#FFFDF5` | `#FFFDF5` | a focused button's text |
| `formSelected` | `#02BA84` | `#02BF87` | a selected option, the text cursor |
| `formSelectedMark` | `#02CF92` | `#02A877` | a selected option's `✓` |
| `formError` | `#FF4672` | `#ED567A` | a field's error |
| `formMuted` | `default` | `ansi:248` | descriptions, an unselected option's `•` |
| `formFaint` | `default` | `ansi:245` | `tutti init`'s faint text: its about line, the steps to come, the scout's clock, the summary's details; `default` draws it faint, any other colour as is |
| `formHelpKey` | `#909090` | `#9A9A9A` | the keys in a form's hint |
| `formHelpDesc` | `#B2B2B2` | `#7A7A7A` | what each key in a form's hint does |
| `formHelpSeparator` | `#DDDADA` | `#5A5A5A` | the ` · ` between a form hint's keys |
| `formButton` | `ansi:252` | `ansi:237` | an unfocused button's background |
| `formPlaceholder` | `ansi:248` | `ansi:243` | placeholders |
| `formFrame` | `ansi:238` | `ansi:238` | the focused field's left bar |

`pill`, `formAccent`, `formButton` and `selection` are drawn as backgrounds.

## Choosing a scheme

The first of these that is set wins:

| Where | | Scope |
|---|---|---|
| `--colour-scheme <name>` | a run flag | this run |
| `TUTTI_COLOUR_SCHEME=<name>` | the environment | this run |
| `"colour_scheme": "<name>"` | the [user config](setup.md#the-user-config) | your runs, in every project |
| `"ui": { "colour_scheme": "<name>" }` | [`.tutti/settings.json`](setup.md#the-settings) | the project's default, committed and shared |
| `orchestra` | | the default |

Your own choice wins over the project's, since colours are a matter of taste and sight.

A name is looked up in this order:

1. `.tutti/colour-schemes/<name>.json` in the main checkout: the project's schemes, committed for its
   team.
2. `$XDG_CONFIG_HOME/tutti/colour-schemes/<name>.json` (`~/.config/tutti/colour-schemes/` when
   `XDG_CONFIG_HOME` is unset): yours.
3. The built-in schemes: `orchestra`.

The first file found is the one used, even when it can't be used: a broken project scheme isn't
replaced by your file of the same name. A name is letters, digits, `.`, `_` and `-`. `orchestra` is
reserved: a file named `orchestra.json` in either folder is ignored, with a warning
(`<path> is ignored: orchestra is a built-in colour scheme's name`).

## Writing a scheme

A scheme is a JSON file named after the scheme. This one, `.tutti/colour-schemes/dusk.json`, changes
four roles of `orchestra` and keeps the rest:

```json
{
  "$schema": "https://raw.githubusercontent.com/noesis-sol/tutti/main/schema/colour-scheme.json",
  "name": "dusk",
  "description": "orchestra's scheme with a teal live colour and a rose pill",
  "extends": "orchestra",
  "colours": {
    "live": { "light": "#0F766E", "dark": "#2DD4BF" },
    "heading2": { "light": "#0F766E", "dark": "#2DD4BF" },
    "pill": "#E11D48",
    "selection": "#E11D48",
    "frame": "ansi:8"
  }
}
```

- **`$schema`** is optional. It points editors at the published JSON Schema,
  [`schema/colour-scheme.json`](../schema/colour-scheme.json), so they complete and check the file.
- **`name`** must match the file's name, without `.json`.
- **`description`** is optional.
- **`extends`** names another scheme, such as `orchestra`. Every role the file leaves out comes from
  that scheme, which may extend another in turn. Without `extends`, the file must give every role.
- **`colours`** maps roles to colours. A value is one colour for both variants, or
  `{ "light": …, "dark": … }` with both. A colour is one of:
  - `#RRGGBB`: an exact colour. On a 256-colour terminal it becomes the nearest of the 256.
  - `ansi:N`, N from 0 to 255: a palette slot. Slots 0 to 15 follow the terminal's own theme, which
    may remap them (one theme draws "cyan" as near-white); `orchestra` avoids them, but a scheme that
    wants to follow the terminal's theme can use them. Slots 16 to 255 are the standard colour cube
    and greys.
  - `default`: the terminal's default foreground, or its default background for the background roles
    above.

Keys other than these, and roles that aren't in the tables above, are errors.

### When a scheme can't be used

A scheme that can't be used never stops a run: tutti uses `orchestra` instead and says why, once:

- in the run's `START` block in the log,
- on the dashboard's warning line, above the hint:
  ` ! colour scheme 'dusk' isn't used: 'colours.frame': 'ansi:300' is not a palette slot (0–255)`,
- in `tutti init`'s summary, as a `colour scheme` line marked `!`.

The reasons:

- the name isn't found in either folder or among the built-in schemes, or isn't a scheme's name;
- the file can't be read, or isn't valid JSON;
- a key isn't one the format knows, a role is unknown, or a colour can't be read
  (`'#12345' is not a colour: use #RRGGBB, ansi:N (0–255) or default`);
- `name` doesn't match the file's name;
- roles are missing and there's no `extends`;
- `extends` names a scheme that isn't found or can't be used, or loops back
  (`'extends' loops back: dusk → dawn → dusk`).

A blank name, given with `--colour-scheme`, `TUTTI_COLOUR_SCHEME` or in a config file, is a setup
problem like any other unreadable setting, not a scheme that can't be used.

### Previewing a scheme

```
tutti colours dusk
```

`tutti colours [<name>]` previews a scheme without a run: the one named, or the one in use. It
prints every role with the scheme it comes from (the file, or the one it extends) and a sample and
value in each variant; then a mock card, attention card, tickets table and hint in your terminal's
variant; then `✓ dusk can be used.`

When the scheme can't be used, the preview shows `orchestra` in its place
(`Colour scheme orchestra, used instead of 'dusk'`), the reason goes to stderr
(`tutti colours: colour scheme 'dusk' isn't used: …`), and the command exits 1, so a scheme can be
checked in CI. A setup problem, such as an unreadable user config, exits 1 too. Warnings about files
named `orchestra.json` are shown but don't fail it.

## Light or dark

A role's light or dark variant is picked from the terminal's background.

- **Detection.** At start, tutti asks the terminal for its background and waits up to 250 ms. A
  background brighter than mid-grey is light; no answer counts as dark.
- **Live switching.** When the terminal reports a change of theme while the dashboard is open, tutti
  switches variants at once.
- **Choosing.** `"appearance": "light"` or `"dark"` in the [user config](setup.md#the-user-config),
  or `TUTTI_APPEARANCE=light` or `dark`, fixes the variant; `auto`, the default, detects it.
  `TUTTI_APPEARANCE` wins over the user config. Live switching happens only with `auto`.

The appearance is the variant; the colour scheme is the set of colours. They are set apart.

Text printed after the dashboard has closed (the summary and the run report) uses the variant the
dashboard detected. A run without a dashboard asks the terminal itself when it prints the report;
when its output isn't a terminal, it carries no colours at all.

## Colour depth and NO_COLOR

The colour depth comes from the environment only:

- `COLORTERM=truecolor` or `24bit`, or a `TERM` of `xterm-kitty`, `xterm-ghostty`, `alacritty`,
  `wezterm`, `foot` or `contour`, or one ending in `-direct`, `-truecolor` or `-24bit`: exact
  colours.
- A `TERM` with `256color` in it, such as `xterm-256color`: the nearest of the 256 colours.
- Anything else: fewer than 256 colours. The dashboard needs 256, so the run prints plain log lines,
  saying why: `Plain output: the terminal reports fewer than 256 colours (TERM=…); the dashboard
  needs 256 or more. Set COLORTERM=truecolor, or a 256-colour TERM such as xterm-256color, if it has
  them.`

Over ssh the terminal's own variables often don't arrive, so set `COLORTERM=truecolor` there (see
[Terminals](dashboard.md#terminals)).

With `NO_COLOR` set to anything but an empty string, every role is drawn in the terminal's default
colour, whatever the scheme. Bold, faint, the glyphs and the words remain. `tutti colours` says so
above its table.
