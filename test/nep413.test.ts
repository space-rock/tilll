import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Nep413Error, nep413Digest, signNep413, verifyNep413, type Nep413Payload } from "../src/near/nep413.js";
import { base58Encode } from "../src/near/keys.js";
import { thrownBy } from "./helpers/failure.js";

const u32 = (n: number) => Buffer.from(new Uint32Array([n]).buffer);
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

/** The signed example printed in the NEAR Intents docs (signing-intents.md). It is verified, not re-signed: no secret key is published. */
const DOCS_EXAMPLE = {
  payload: {
    recipient: "intents.near",
    nonce: "Vij2xgAlKBKzgNPJFViEQRgYyS7p2NEiYTTY4XmT8go=",
    message:
      '{"deadline":"2025-05-21T10:34:04.254392Z","intents":[{"intent":"transfer","receiver_id":"bob.near","tokens":{"nep141:usdc.near":"10"}}],"signer_id":"alice.near"}',
  } as Nep413Payload,
  public_key: "ed25519:C3jXhkGhEx88Gj7XKtUziJKXEBMRaJ67bWFkxJikVxZ2",
  signature: "ed25519:2ns3eCikZFxFA6e9ApunuDG4XwJUPrB8q82fYViBKjheqiDYcCmLN9RnB9NhoEvCdNoS3L3qYD9FAnKd7UkTnuij",
};

const NONCE_BYTES = Buffer.alloc(32, 9);
const payload: Nep413Payload = {
  message: '{"hello":"world"}',
  nonce: NONCE_BYTES.toString("base64"),
  recipient: "verifier.testnet",
};
const SECRET = `ed25519:${base58Encode(Buffer.alloc(32, 7))}`;

describe("the documented example", () => {
  it("verifies, which confirms the byte layout (borsh payload, 2^31+413 tag, SHA-256, ed25519)", () => {
    expect(verifyNep413(DOCS_EXAMPLE)).toBe(true);
  });

  it("stops verifying if any part of the payload changes", () => {
    for (const changed of [
      { ...DOCS_EXAMPLE.payload, recipient: "intents.testnet" },
      { ...DOCS_EXAMPLE.payload, message: DOCS_EXAMPLE.payload.message.replace('"10"', '"11"') },
      { ...DOCS_EXAMPLE.payload, nonce: Buffer.alloc(32, 1).toString("base64") },
    ]) {
      expect(verifyNep413({ ...DOCS_EXAMPLE, payload: changed })).toBe(false);
    }
  });
});

describe("nep413Digest", () => {
  it("is SHA-256 of the little-endian tag 2^31+413 followed by the Borsh payload, written out byte by byte", () => {
    const expectedBytes = Buffer.concat([
      Buffer.from("9d010080", "hex"), // 2147484061 little-endian
      str(payload.message),
      NONCE_BYTES, // [u8; 32], no length prefix
      str(payload.recipient),
      Buffer.from([0]), // callbackUrl: None
    ]);
    expect(nep413Digest(payload).toString("hex")).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
  });

  it("encodes a callbackUrl as Some(string): 1 then the string", () => {
    const expectedBytes = Buffer.concat([
      Buffer.from("9d010080", "hex"),
      str(payload.message),
      NONCE_BYTES,
      str(payload.recipient),
      Buffer.from([1]),
      str("https://app.example/cb"),
    ]);
    expect(nep413Digest({ ...payload, callbackUrl: "https://app.example/cb" }).toString("hex")).toBe(
      createHash("sha256").update(expectedBytes).digest("hex"),
    );
  });

  it("treats a null callbackUrl (as generate-intent returns it) like an absent one", () => {
    expect(nep413Digest({ ...payload, callbackUrl: null }).toString("hex")).toBe(nep413Digest(payload).toString("hex"));
  });

  it("signs UTF-8 bytes, not characters", () => {
    const text = { ...payload, message: "café ☕" };
    const expectedBytes = Buffer.concat([
      Buffer.from("9d010080", "hex"),
      str("café ☕"),
      NONCE_BYTES,
      str(payload.recipient),
      Buffer.from([0]),
    ]);
    expect(nep413Digest(text).toString("hex")).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
  });

  it.each([
    ["a nonce that is not base64", "!!!not base64!!!"],
    ["a nonce of 31 bytes", Buffer.alloc(31).toString("base64")],
    ["a nonce of 33 bytes", Buffer.alloc(33).toString("base64")],
    ["an empty nonce", ""],
  ])("refuses %s", (_name, nonce) => {
    expect(() => nep413Digest({ ...payload, nonce })).toThrow(Nep413Error);
  });
});

describe("signNep413", () => {
  it("returns ed25519:<base58> public key and signature that verify", () => {
    const signed = signNep413(SECRET, payload);

    expect(signed.public_key).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(signed.signature).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(verifyNep413({ payload, ...signed })).toBe(true);
  });

  it("is deterministic, and the signature does not verify for a different payload or key", () => {
    const a = signNep413(SECRET, payload);
    expect(signNep413(SECRET, payload)).toEqual(a);
    expect(verifyNep413({ payload: { ...payload, message: "{}" }, ...a })).toBe(false);
    const other = signNep413(`ed25519:${base58Encode(Buffer.alloc(32, 8))}`, payload);
    expect(verifyNep413({ payload, public_key: a.public_key, signature: other.signature })).toBe(false);
  });

  it("does not alter the payload it was given", () => {
    const copy = structuredClone(payload);
    signNep413(SECRET, payload);
    expect(payload).toEqual(copy);
  });

  it("refuses a bad secret key without echoing it", () => {
    const err = thrownBy(Error, () => signNep413("ed25519:not*base58*secret", payload));
    expect(err.message).not.toContain("not*base58*secret");
  });
});

describe("verifyNep413", () => {
  it.each([
    ["a public key of the wrong type", { public_key: "secp256k1:abc" }],
    ["a signature that is not base58", { signature: "ed25519:!!!" }],
    ["a signature of the wrong length", { signature: "ed25519:2ns3eCik" }],
    ["a missing prefix", { signature: DOCS_EXAMPLE.signature.slice(8) }],
  ])("is false, not a crash, for %s", (_name, override) => {
    expect(verifyNep413({ ...DOCS_EXAMPLE, ...override })).toBe(false);
  });
});
