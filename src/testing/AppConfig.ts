// The AppConfig test layer: a literal value. `appConfig` builds one as a run with no flags, no
// variables and no user config would resolve, in its repository and with its settings (by default
// testSettings, a project's naming only its merge check), and with the rest of `overrides` laid over
// it.
import { Layer, Result } from "effect"
import {
  AppConfig,
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  resolve,
} from "../cli/AppConfig.ts"
import { noFlags } from "../cli/flags.ts"
import type { Settings } from "../project/settings.ts"

/** The machine's cores the test configuration has, so that its default --machine-workers is 5. */
export const testCores = 10

/**
 * The settings of a project whose merge check is scripts/check-fast.sh, as tutti's own: the defaults
 * name none, and a check with no command runs nothing (NoCheckCommand), in the Checks test layer as
 * in the live one.
 */
export const testSettings: Settings = {
  ...defaultSettings,
  checks: {
    ...defaultSettings.checks,
    fast: { ...defaultSettings.checks.fast, command: "scripts/check-fast.sh" },
  },
}

/**
 * A run's configuration in the project at `repo` (`overrides.repo` where it gives one): resolved
 * from `overrides.settings`, else testSettings, as a run's is, so the paths derived from the
 * repository and resolve's checks follow them; the other `overrides` are laid over it.
 */
export const appConfig = (
  overrides: Partial<AppConfigValue> = {},
  repo = "/work/project",
): AppConfigValue => {
  const { repo: given, settings, ...rest } = overrides
  const resolved = resolve({
    repo: given ?? repo,
    flags: noFlags,
    env: () => undefined,
    user: defaultUserConfig,
    settings: settings ?? testSettings,
    cores: testCores,
  })
  if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
  return { ...resolved.success, ...rest }
}

/** The test layer: AppConfig as the literal `value`. */
export const layer = (value: AppConfigValue = appConfig()) => Layer.succeed(AppConfig, value)
