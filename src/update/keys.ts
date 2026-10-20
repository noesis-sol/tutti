// The release keys built into tutti (§ 12 `tutti update`): the ed25519 public keys a release's
// checksums.txt may be signed with. `tutti update` trusts no sum in checksums.txt until its
// signature, checksums.txt.sig (the raw 64 bytes scripts/sign-checksums.ts writes), verifies with
// one of them, and installs nothing from a release without one.
//
// Each key is PKIX PEM, as `openssl pkey -in release-key.pem -pubout` prints the release key's
// public half, named after the month it was made. scripts/install.sh holds the same keys in its
// `release_keys`.
//
// Key rotation, as orchestra's: to replace the key (it leaked, or is old), add the new one a release
// before retiring the old, so that the binaries of both releases verify the next.
//
// 1. Make the new pair: `openssl genpkey -algorithm ed25519 -out release-key.pem`, and
//    `openssl pkey -in release-key.pem -pubout` for its public half. Add the public half below, named
//    YYYY-MM, and to `release_keys` in scripts/install.sh. Commit it and release, still signed with the
//    old key: this release trusts both.
// 2. Set the repository secret TUTTI_RELEASE_KEY to the new private key
//    (`gh secret set TUTTI_RELEASE_KEY < release-key.pem`), and keep the file out of the repository.
// 3. Once a release signed with the new key is out, remove the old key here and from
//    scripts/install.sh.
import { createPublicKey, type KeyObject } from "node:crypto"

/** A public key releases may be signed with. */
export interface ReleaseKey {
  /** The month it was made, YYYY-MM. */
  readonly name: string
  /** Its public half, PKIX PEM (-----BEGIN PUBLIC KEY-----). */
  readonly pem: string
}

/** The release keys, oldest first. */
export const releaseKeys: ReadonlyArray<ReleaseKey> = [
  {
    name: "2026-10",
    pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtoGlzKgru416pWobucm9ICq3LtFfTEFkOaRy0Yx2Je4=
-----END PUBLIC KEY-----
`,
  },
]

/** The PEM text as an ed25519 public key, or why it isn't one. */
export const parsePublicKey = (pem: string): KeyObject | string => {
  if (!pem.includes("-----BEGIN PUBLIC KEY-----")) {
    return "not a PKIX PEM public key (-----BEGIN PUBLIC KEY-----)"
  }
  let key: KeyObject
  try {
    key = createPublicKey({ key: pem, format: "pem" })
  } catch (error) {
    return `it doesn't parse: ${error instanceof Error ? error.message : String(error)}`
  }
  return key.asymmetricKeyType === "ed25519"
    ? key
    : `a ${key.asymmetricKeyType ?? "symmetric"} key, not an ed25519 key`
}
