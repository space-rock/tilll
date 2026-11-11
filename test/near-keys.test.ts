import { describe, expect, it } from "vitest";
import { thrownBy } from "./helpers/failure.js";
import { verify, createPublicKey } from "node:crypto";
import {
  KeyError,
  base58Decode,
  base58Encode,
  implicitAccountOf,
  publicKeyOf,
  signWithSecret,
  verifyEd25519,
} from "../src/near/keys.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("base58", () => {
  it.each([
    ["", ""],
    ["00", "1"],
    ["0000", "11"],
    ["000001", "112"],
    ["48656c6c6f20576f726c6421", "2NEpo7TZRRrLZSi2U"], // "Hello World!"
    ["00000000", "1111"],
    ["ff", "5Q"],
  ])("encodes %s as %s and decodes it back", (bytes, text) => {
    expect(base58Encode(Buffer.from(bytes, "hex"))).toBe(text);
    expect(hex(base58Decode(text))).toBe(bytes);
  });

  it("round-trips random buffers of every small length, keeping leading zero bytes", () => {
    for (let length = 0; length < 70; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i < 2 ? 0 : (i * 37 + length * 11) % 256));
      expect(hex(base58Decode(base58Encode(bytes)))).toBe(hex(bytes));
    }
  });

  it.each(["0", "O", "I", "l", "abc0", "has space", "é"])("refuses %j, which is not in the base58 alphabet", (bad) => {
    expect(() => base58Decode(bad)).toThrow(KeyError);
  });

  it("decodes the public key printed in the NEAR Intents docs to 32 bytes", () => {
    const docKey = "C3jXhkGhEx88Gj7XKtUziJKXEBMRaJ67bWFkxJikVxZ2";
    expect(base58Decode(docKey)).toHaveLength(32);
    expect(base58Encode(base58Decode(docKey))).toBe(docKey);
  });
});

describe("publicKeyOf", () => {
  // RFC 8032 section 7.1, test 1
  const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const seedBytes = Buffer.from(SEED, "hex");
  const publicBytes = Buffer.from(PUBLIC, "hex");

  it("derives the right public key from a 32 byte seed (RFC 8032 test vector)", () => {
    const secret = `ed25519:${base58Encode(seedBytes)}`;
    expect(publicKeyOf(secret)).toBe(`ed25519:${base58Encode(publicBytes)}`);
  });

  it("accepts NEAR's usual 64 byte form, seed followed by public key", () => {
    const secret = `ed25519:${base58Encode(Buffer.concat([seedBytes, publicBytes]))}`;
    expect(publicKeyOf(secret)).toBe(`ed25519:${base58Encode(publicBytes)}`);
  });

  it("refuses a 64 byte key whose public half does not belong to its seed", () => {
    const wrongPublic = Buffer.from(PUBLIC.replace(/^d7/, "d8"), "hex");
    const secret = `ed25519:${base58Encode(Buffer.concat([seedBytes, wrongPublic]))}`;
    expect(() => publicKeyOf(secret)).toThrow(/does not match/);
  });

  it.each([
    ["a missing prefix", base58Encode(seedBytes)],
    ["the wrong key type", `secp256k1:${base58Encode(seedBytes)}`],
    ["a key of the wrong length", `ed25519:${base58Encode(seedBytes.subarray(0, 31))}`],
    ["characters outside base58", "ed25519:not*base58*"],
    ["nothing after the prefix", "ed25519:"],
  ])("refuses %s", (_name, secret) => {
    expect(() => publicKeyOf(secret)).toThrow(KeyError);
  });

  it("never puts the key in an error message", () => {
    const short = base58Encode(seedBytes.subarray(0, 31));
    const error = thrownBy(KeyError, () => publicKeyOf(`ed25519:${short}`));
    expect(error.message).not.toContain(short);
  });
});

describe("implicitAccountOf", () => {
  const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

  it("is the lowercase hex of the public key, which is a NEAR implicit account id (RFC 8032 vector)", () => {
    const secret = `ed25519:${base58Encode(Buffer.from(SEED, "hex"))}`;
    expect(implicitAccountOf(secret)).toBe(PUBLIC);
  });

  it("is 64 hex characters and agrees with publicKeyOf for the 64 byte secret form", () => {
    const secret = `ed25519:${base58Encode(Buffer.concat([Buffer.from(SEED, "hex"), Buffer.from(PUBLIC, "hex")]))}`;
    expect(implicitAccountOf(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(`ed25519:${base58Encode(Buffer.from(implicitAccountOf(secret), "hex"))}`).toBe(publicKeyOf(secret));
  });

  it("refuses an unreadable key the same way publicKeyOf does", () => {
    expect(() => implicitAccountOf("ed25519:abc*")).toThrow(KeyError);
  });
});

describe("signWithSecret", () => {
  // RFC 8032 section 7.1, test 1: the empty message
  const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const SIGNATURE_OF_EMPTY =
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
  const secret = `ed25519:${base58Encode(Buffer.from(SEED, "hex"))}`;

  it("produces the RFC 8032 signature for the empty message", () => {
    expect(signWithSecret(secret, new Uint8Array(0)).toString("hex")).toBe(SIGNATURE_OF_EMPTY);
  });

  it("signs arbitrary bytes so that the matching public key verifies them, and no other bytes", () => {
    const message = Buffer.from("tilll test message");
    const signature = signWithSecret(secret, message);
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(base58Decode(publicKeyOf(secret).slice("ed25519:".length))),
    ]);
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    expect(signature).toHaveLength(64);
    expect(verify(null, message, publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from("other message"), publicKey, signature)).toBe(false);
  });

  it("works with the 64 byte secret key form too", () => {
    const publicBytes = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
    const long = `ed25519:${base58Encode(Buffer.concat([Buffer.from(SEED, "hex"), publicBytes]))}`;
    expect(signWithSecret(long, new Uint8Array(0)).toString("hex")).toBe(SIGNATURE_OF_EMPTY);
  });

  it("refuses an unreadable key", () => {
    expect(() => signWithSecret("ed25519:abc*", new Uint8Array(1))).toThrow(KeyError);
  });
});

describe("verifyEd25519", () => {
  const secret = `ed25519:${base58Encode(Buffer.alloc(32, 7))}`;
  const data = Buffer.from("hello");
  const signature = `ed25519:${base58Encode(signWithSecret(secret, data))}`;

  it("accepts a signature made with the matching secret key", () => {
    expect(verifyEd25519(publicKeyOf(secret), data, signature)).toBe(true);
  });

  it("refuses a changed message, another key and a changed signature", () => {
    expect(verifyEd25519(publicKeyOf(secret), Buffer.from("hellp"), signature)).toBe(false);
    expect(verifyEd25519(publicKeyOf(`ed25519:${base58Encode(Buffer.alloc(32, 8))}`), data, signature)).toBe(false);
    const flipped = Buffer.from(signWithSecret(secret, data));
    flipped[0] = flipped[0]! ^ 1;
    expect(verifyEd25519(publicKeyOf(secret), data, `ed25519:${base58Encode(flipped)}`)).toBe(false);
  });

  it("takes keys and signatures with or without the ed25519: prefix", () => {
    expect(verifyEd25519(publicKeyOf(secret).slice("ed25519:".length), data, signature.slice("ed25519:".length))).toBe(
      true,
    );
  });

  it.each([
    ["an empty public key", "", signature],
    ["a public key of the wrong length", "ed25519:abc", signature],
    ["a public key that is not base58", "ed25519:0OIl", signature],
    ["an empty signature", publicKeyOf(secret), ""],
    ["a signature of the wrong length", publicKeyOf(secret), "ed25519:abc"],
    ["a signature that is not base58", publicKeyOf(secret), "ed25519:0OIl"],
  ])("says false, and never throws, for %s", (_name, key, sig) => {
    expect(verifyEd25519(key, data, sig)).toBe(false);
  });
});
