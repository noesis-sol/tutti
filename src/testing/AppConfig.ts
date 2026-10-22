// The AppConfig test layer: a literal value. `appConfig` builds one as a run with no flags, no
// variables and no config files would resolve, with `overrides` laid over it.
import { Layer, Result } from "effect"
import {
  AppConfig,
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  resolve,
} from "../cli/AppConfig.ts"
import { noFlags } from "../cli/flags.ts"

/** The machine's cores the test configuration has, so that its default --machine-workers is 5. */
export const testCores = 10

/** A run's configuration in the project at `repo`: its defaults, with `overrides` laid over them. */
export const appConfig = (
  overrides: Partial<AppConfigValue> = {},
  repo = "/work/project",
): AppConfigValue => {
  const resolved = resolve({
    repo,
    flags: noFlags,
    env: () => undefined,
    user: defaultUserConfig,
    settings: defaultSettings,
    cores: testCores,
  })
  if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
  return { ...resolved.success, ...overrides }
}

/** The test layer: AppConfig as the literal `value`. */
export const layer = (value: AppConfigValue = appConfig()) => Layer.succeed(AppConfig, value)
