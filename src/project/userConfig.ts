// The user config, `$XDG_CONFIG_HOME/tutti/config.json` (§ 8.5): one person's preferences, for
// every project. The project's settings hold none of these but the colour scheme, and for that the
// user config's choice wins; flags override both. A missing file gives the defaults.
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Config, Effect, Option, Schema } from "effect"
import { choice, readConfigFile, withDefault } from "./configFile.ts"

export const UserConfig = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  /** false leaves the mouse to the terminal, for its own selection (§ 7.3). */
  mouse: Schema.Boolean.pipe(withDefault(true)),
  /** false turns the desktop notifications off (§ 7.9). */
  notify: Schema.Boolean.pipe(withDefault(true)),
  /** api keeps ANTHROPIC_API_KEY for workers and organs beside a subscription login (§ 4.13). */
  billing: choice(["subscription", "api"]).pipe(withDefault("subscription")),
  /** The colour scheme's variant; auto follows the terminal's background (§ 7.11). */
  appearance: choice(["auto", "light", "dark"]).pipe(withDefault("auto")),
  /** Your colour scheme, over the project's; null: the project's (§ 7.11). */
  colour_scheme: Schema.NullOr(Schema.NonEmptyString).pipe(withDefault(null)),
})

export type UserConfig = typeof UserConfig.Type

/**
 * tutti's directory in the user's config directory: `$XDG_CONFIG_HOME/tutti`, or
 * `~/.config/tutti` when XDG_CONFIG_HOME is unset, empty or relative, as the XDG spec says. Both
 * variables are optional strings, which the environment can't fail to give.
 */
export const userConfigDir = Effect.gen(function* () {
  const xdg = yield* Config.option(Config.String("XDG_CONFIG_HOME"))
  const home = yield* Config.String("HOME").pipe(Config.withDefault(homedir()))
  const base = Option.filter(xdg, isAbsolute).pipe(Option.getOrElse(() => join(home, ".config")))
  return join(base, "tutti")
}).pipe(Effect.orDie)

/** Where the user config is. */
export const userConfigPath = Effect.map(userConfigDir, (dir) => join(dir, "config.json"))

/** Reads the user config; a missing file gives the defaults. */
export const readUserConfig = Effect.flatMap(userConfigPath, (file) =>
  readConfigFile(UserConfig, file),
)
