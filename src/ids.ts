import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface NewIdOptions {
  /** Milliseconds since the epoch. Defaults to Date.now(). */
  now?: number;
  /** 10 random bytes. Defaults to crypto.randomBytes. */
  random?: () => Uint8Array;
}

/**
 * `<prefix>_<ULID>`: 48 bits of millisecond time then 80 random bits in Crockford base32, so ids sort by
 * creation time and are unguessable. Ids that share a millisecond are not ordered among themselves.
 */
export function newId(prefix: string, options: NewIdOptions = {}): string {
  let time = options.now ?? Date.now();
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }

  let random = 0n;
  for (const byte of (options.random ?? (() => randomBytes(10)))()) random = (random << 8n) | BigInt(byte);
  let randomPart = "";
  for (let i = 0; i < 16; i++) {
    randomPart = CROCKFORD[Number(random & 31n)]! + randomPart;
    random >>= 5n;
  }

  return `${prefix}_${timePart}${randomPart}`;
}
