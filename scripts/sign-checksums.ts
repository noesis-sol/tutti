// scripts/sign-checksums.ts: signs a release's checksums.txt with the ed25519 release key (§ 12
// Releases), for scripts/install.sh and tutti update to verify: it writes the raw 64-byte signature
// to checksums.txt.sig beside it, as `openssl pkeyutl -sign -rawin` would. The key is a PKCS#8 PEM
// private key in $TUTTI_RELEASE_KEY, the repository secret of that name in the release workflow
// (.github/workflows/release.yml). Without it, with a key that isn't ed25519, or with one whose
// public half isn't among the release keys tutti builds in (src/update/keys.ts), which tutti update
// would refuse the release for, it signs nothing and exits 1, saying why.
//
//   TUTTI_RELEASE_KEY="$(cat release-key.pem)" bun scripts/sign-checksums.ts dist/checksums.txt
//
// The key is made once, by the maintainer, and its public half is added to src/update/keys.ts (which
// says how to rotate it) before it signs a release:
//
//   openssl genpkey -algorithm ed25519 -out release-key.pem
//   openssl pkey -in release-key.pem -pubout          # the public key
//   gh secret set TUTTI_RELEASE_KEY < release-key.pem
import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { parsePublicKey, type ReleaseKey, releaseKeys } from "../src/update/keys.ts"

/** The environment variable holding the private key. */
export const keyEnv = "TUTTI_RELEASE_KEY"

/** The PEM key as an ed25519 private key, or why it isn't one. */
export const releaseKey = (pem: string | undefined): KeyObject | string => {
  if (pem === undefined || pem.trim() === "") {
    return `$${keyEnv} is empty: it holds the release key, a PKCS#8 PEM ed25519 private key (in the release workflow, the repository secret ${keyEnv})`
  }
  if (!pem.includes("-----BEGIN PRIVATE KEY-----")) {
    return `$${keyEnv} is not a PKCS#8 PEM private key (-----BEGIN PRIVATE KEY-----)`
  }
  let key: KeyObject
  try {
    key = createPrivateKey({ key: pem, format: "pem" })
  } catch (error) {
    return `$${keyEnv} doesn't parse: ${error instanceof Error ? error.message : String(error)}`
  }
  return key.asymmetricKeyType === "ed25519"
    ? key
    : `$${keyEnv} is a ${key.asymmetricKeyType ?? "symmetric"} key, not an ed25519 key`
}

/** `data`'s raw 64-byte ed25519 signature with `key`, checked against the key's public half. */
export const signChecksums = (data: Uint8Array, key: KeyObject): Uint8Array => {
  const signature = sign(null, data, key)
  if (!verify(null, data, createPublicKey(key), signature)) {
    throw new Error("the signature doesn't verify with the key's own public half")
  }
  return signature
}

/**
 * `data`'s signature with `key` once it verifies with one of `keys`, as tutti update verifies it,
 * or why it doesn't: the key isn't a release key, and tutti update would refuse the release.
 */
export const signRelease = (
  data: Uint8Array,
  key: KeyObject,
  keys: ReadonlyArray<ReleaseKey>,
): Uint8Array | string => {
  const signature = signChecksums(data, key)
  for (const releaseKey of keys) {
    const parsed = parsePublicKey(releaseKey.pem)
    if (typeof parsed !== "string" && verify(null, data, parsed, signature)) return signature
  }
  return `$${keyEnv}'s public key is not in src/update/keys.ts, so tutti update would refuse the release: add it there first`
}

/** Signs `file` with the PEM key, which must be one of `keys`, into `file`.sig; or says why not. */
export const signFile = (
  file: string,
  pem: string | undefined,
  keys: ReadonlyArray<ReleaseKey>,
): string | undefined => {
  const key = releaseKey(pem)
  if (typeof key === "string") return key
  const signature = signRelease(readFileSync(file), key, keys)
  if (typeof signature === "string") return signature
  writeFileSync(`${file}.sig`, signature)
  return undefined
}

if (import.meta.main) {
  const [file, ...rest] = process.argv.slice(2)
  if (file === undefined || rest.length > 0) {
    process.stderr.write(
      `usage: ${keyEnv}=<PEM key> bun scripts/sign-checksums.ts <checksums.txt>\n`,
    )
    process.exit(2)
  }
  const why = signFile(file, process.env[keyEnv], releaseKeys)
  if (why !== undefined) {
    process.stderr.write(`sign-checksums: ${why}\n`)
    process.exit(1)
  }
}
