import { describe, expect, test } from "bun:test"
import { userInfo } from "node:os"
import { isAbsolute, join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import fc from "fast-check"
import { homeFolder, userConfigPath } from "../src/project/userConfig.ts"
import { cacheDir } from "../src/update/update.ts"

// Some cron and service environments set HOME to "": the user config and the update cache stay in
// the account's home folder then, never under the current folder.
const account = userInfo().homedir

const configPath = (env: Record<string, string>) =>
  Effect.runSync(
    Effect.provide(userConfigPath, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  )

const vars =
  (env: Record<string, string>) =>
  (name: string): string | undefined =>
    env[name]

describe("an empty or relative HOME", () => {
  test("homeFolder keeps an absolute HOME", () => {
    expect(homeFolder("/home/me")).toBe("/home/me")
  })

  test("homeFolder gives the account's home folder for HOME unset, empty or relative", () => {
    expect(isAbsolute(account)).toBe(true)
    expect(homeFolder(undefined)).toBe(account)
    expect(homeFolder("")).toBe(account)
    expect(homeFolder("relative")).toBe(account)
    expect(homeFolder("./home")).toBe(account)
  })

  test("homeFolder always gives an absolute path", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (home) => {
        expect(isAbsolute(homeFolder(home))).toBe(true)
      }),
    )
  })

  test("the user config is in the account's ~/.config/tutti", () => {
    const expected = join(account, ".config", "tutti", "config.json")
    expect(configPath({ HOME: "" })).toBe(expected)
    expect(configPath({ HOME: "relative" })).toBe(expected)
    expect(configPath({ HOME: "", XDG_CONFIG_HOME: "" })).toBe(expected)
    expect(configPath({ HOME: "", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/tutti/config.json")
  })

  test("the update cache is in the account's ~/.cache/tutti", () => {
    const expected = join(account, ".cache", "tutti")
    expect(cacheDir(vars({ HOME: "" }))).toBe(expected)
    expect(cacheDir(vars({ HOME: "relative" }))).toBe(expected)
    expect(cacheDir(vars({ HOME: "", XDG_CACHE_HOME: "" }))).toBe(expected)
    expect(cacheDir(vars({ HOME: "", XDG_CACHE_HOME: "/x/cache" }))).toBe("/x/cache/tutti")
  })
})
