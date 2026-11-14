import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { base58Encode, implicitAccountOf, publicKeyOf } from "../../src/near/keys.js";

export interface KeyEntry {
  /** `ed25519:<base58>`. Throwaway testnet key. */
  secretKey: string;
  publicKey: string;
  /** The implicit account of the key: 64 lowercase hex characters. */
  accountId: string;
  /** A named `.testnet` account created for this key (the payer needs one: it holds NEAR for gas). */
  namedAccountId?: string;
}

/**
 * A merchant with a *named* account. Its server key (`secretKey`) is not an access key of the account, so before it
 * can sign refunds the account has to register it with the verifier (`add_public_key`). `accessKey` is the account's
 * own full-access key, which signs that registration.
 */
export interface ShopEntry extends KeyEntry {
  accessKey: { secretKey: string; publicKey: string };
}

export interface Keystore {
  /** Receives the merchant's money, and signs refunds. */
  settlement: KeyEntry;
  /** The test customer who pays invoices. */
  payer: KeyEntry;
  /** Optional: a named settlement account, for testing the registered-key path. */
  shop?: ShopEntry;
}

function newEntry(): KeyEntry {
  const secretKey = `ed25519:${base58Encode(randomBytes(32))}`;
  return { secretKey, publicKey: publicKeyOf(secretKey), accountId: implicitAccountOf(secretKey) };
}

function validate(entry: unknown, label: string, path: string): KeyEntry {
  const e = entry as Partial<KeyEntry> | undefined;
  if (!e || typeof e.secretKey !== "string" || typeof e.publicKey !== "string" || typeof e.accountId !== "string") {
    throw new Error(`${path}: ${label} entry is malformed.`);
  }
  if (publicKeyOf(e.secretKey) !== e.publicKey || implicitAccountOf(e.secretKey) !== e.accountId) {
    throw new Error(`${path}: ${label} public key or account does not match its secret key.`);
  }
  return {
    secretKey: e.secretKey,
    publicKey: e.publicKey,
    accountId: e.accountId,
    ...(typeof e.namedAccountId === "string" ? { namedAccountId: e.namedAccountId } : {}),
  };
}

function validateShop(entry: unknown, path: string): ShopEntry {
  const base = validate(entry, "shop", path);
  const access = (entry as { accessKey?: { secretKey?: unknown; publicKey?: unknown } }).accessKey;
  if (!access || typeof access.secretKey !== "string" || typeof access.publicKey !== "string") {
    throw new Error(`${path}: shop access key is malformed.`);
  }
  if (publicKeyOf(access.secretKey) !== access.publicKey) {
    throw new Error(`${path}: shop access key public key does not match its secret key.`);
  }
  return { ...base, accessKey: { secretKey: access.secretKey, publicKey: access.publicKey } };
}

function write(path: string, store: Keystore) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.tmp`;
  writeFileSync(partial, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(partial, path);
}

/**
 * Throwaway testnet keys, created once and reused. Tidepool's faucet allows one claim per address per 24 hours,
 * so regenerating keys on every run would exhaust it. The file is owner-only, and an unreadable file is an error
 * rather than something to overwrite: the keys in it may hold test funds.
 */
export function loadOrCreateKeystore(path: string): Keystore {
  if (existsSync(path)) {
    let parsed: { settlement?: unknown; payer?: unknown; shop?: unknown };
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${path} is not valid JSON. Fix or delete it; it is not overwritten automatically.`);
    }
    return {
      settlement: validate(parsed.settlement, "settlement", path),
      payer: validate(parsed.payer, "payer", path),
      ...(parsed.shop === undefined ? {} : { shop: validateShop(parsed.shop, path) }),
    };
  }
  const store: Keystore = { settlement: newEntry(), payer: newEntry() };
  write(path, store);
  return store;
}

const TESTNET_ACCOUNT = /^[a-z0-9._-]+\.testnet$/;

/** Remember the named testnet account that was created for the payer's key. */
export function setPayerAccount(path: string, accountId: string): void {
  if (!TESTNET_ACCOUNT.test(accountId)) throw new Error(`"${accountId}" is not a .testnet account.`);
  if (!existsSync(path)) throw new Error(`${path} does not exist; create the keystore first.`);
  const store = loadOrCreateKeystore(path);
  write(path, { ...store, payer: { ...store.payer, namedAccountId: accountId } });
}

/** The named shop's keys, created on first use. The account itself is created separately and recorded with {@link setShopAccount}. */
export function ensureShop(path: string): ShopEntry {
  const store = loadOrCreateKeystore(path);
  if (store.shop) return store.shop;
  const access = newEntry();
  const shop: ShopEntry = { ...newEntry(), accessKey: { secretKey: access.secretKey, publicKey: access.publicKey } };
  write(path, { ...store, shop });
  return shop;
}

/** Remember the named testnet account that was created for the shop's access key. */
export function setShopAccount(path: string, accountId: string): void {
  if (!TESTNET_ACCOUNT.test(accountId)) throw new Error(`"${accountId}" is not a .testnet account.`);
  const store = loadOrCreateKeystore(path);
  if (!store.shop) throw new Error("The keystore has no shop yet.");
  write(path, { ...store, shop: { ...store.shop, namedAccountId: accountId } });
}
