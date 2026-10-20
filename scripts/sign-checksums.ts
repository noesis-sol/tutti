// scripts/sign-checksums.ts: signs a release's checksums.txt with the ed25519 release key (§ 12
// Releases), for scripts/install.sh and tutti update to verify: it writes the raw 64-byte signature
// to checksums.txt.sig beside it, as `openssl pkeyutl -sign -rawin` would. The key is a PKCS#8 PEM
// private key in $TUTTI_RELEASE_KEY, the repository secret of that name in the release workflow
// (.github/workflows/release.yml). Without it, or with a key that isn't ed25519, it signs nothing
// and exits 1, saying why.
//
//   TUTTI_RELEASE_KEY="$(cat release-key.pem)" bun scripts/sign-checksums.ts dist/checksums.txt
//
// The key is made once, by the maintainer, and its public half is the one tutti builds in:
//
//   openssl genpkey -algorithm ed25519 -out release-key.pem
//   openssl pkey -in release-key.pem -pubout          # the public key
//   gh secret set TUTTI_RELEASE_KEY < release-key.pem
import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

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

if (import.meta.main) {
  const [file, ...rest] = process.argv.slice(2)
  if (file === undefined || rest.length > 0) {
    process.stderr.write(
      `usage: ${keyEnv}=<PEM key> bun scripts/sign-checksums.ts <checksums.txt>\n`,
    )
    process.exit(2)
  }
  const key = releaseKey(process.env[keyEnv])
  if (typeof key === "string") {
    process.stderr.write(`sign-checksums: ${key}\n`)
    process.exit(1)
  }
  writeFileSync(`${file}.sig`, signChecksums(readFileSync(file), key))
}
