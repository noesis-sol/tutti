// The user config, `$XDG_CONFIG_HOME/tutti/config.json` (§ 8.5): one person's preferences, for
// every project. The project's settings hold none of these but the colour scheme, and for that the
// user config's choice wins; flags override both. A missing file gives the defaults.
import { homedir, userInfo } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
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
  /**
   * Whether runs keep the machine awake, over the project's keep_awake (§ 8.2); null: the
   * project's.
   */
  keep_awake: Schema.NullOr(Schema.Boolean).pipe(withDefault(null)),
  /**
   * Only the organs' keys gone with their organs (settings.ts's retiredOrganKeys), read whatever
   * they are and ignored; the published schema leaves it out.
   */
  organs: Schema.optionalKey(
    Schema.Struct({
      screen: Schema.optionalKey(Schema.Unknown),
      plan: Schema.optionalKey(Schema.Unknown),
    }),
  ),
})

export type UserConfig = typeof UserConfig.Type

/**
 * The user's home folder: HOME when it is an absolute path; else, as for HOME unset, the home
 * folder of the user's account entry, so that an empty HOME (some cron and service environments)
 * or a relative one doesn't put tutti's files under the current folder.
 */
export const homeFolder = (home: string | undefined): string =>
  home !== undefined && isAbsolute(home) ? home : accountHome()

/** The home folder of the user's account entry, whatever HOME says. */
export const accountHome = (): string => {
  try {
    return userInfo().homedir
  } catch {
    return homedir()
  }
}

/**
 * tutti's directory in the user's config directory: `$XDG_CONFIG_HOME/tutti`, or
 * `~/.config/tutti` when XDG_CONFIG_HOME is unset, empty or relative, as the XDG spec says; `~` is
 * homeFolder's. Both variables are optional strings, which the environment can't fail to give.
 */
export const userConfigDir = Effect.gen(function* () {
  const xdg = yield* Config.option(Config.String("XDG_CONFIG_HOME"))
  const home = yield* Config.option(Config.String("HOME"))
  const base = Option.filter(xdg, isAbsolute).pipe(
    Option.getOrElse(() => join(homeFolder(Option.getOrUndefined(home)), ".config")),
  )
  return join(base, "tutti")
}).pipe(Effect.orDie)

/** Where the user config is. */
export const userConfigPath = Effect.map(userConfigDir, (dir) => join(dir, "config.json"))

/**
 * Where the user config is, as tutti names it to you: from `~` where it is in the home folder,
 * `~/.config/tutti/config.json` most often.
 */
export const userConfigShown = Effect.gen(function* () {
  const file = yield* userConfigPath
  const home = homeFolder(Option.getOrUndefined(yield* Config.option(Config.String("HOME"))))
  const rel = relative(home, file)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
    ? `~/${rel.split(sep).join("/")}`
    : file
}).pipe(Effect.orDie)

/** Reads the user config; a missing file gives the defaults. */
export const readUserConfig = Effect.flatMap(userConfigPath, (file) =>
  readConfigFile(UserConfig, file),
)
