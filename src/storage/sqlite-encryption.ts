import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createStorageValueEncryption, type StorageValueEncryption } from "./encryption.js";

export const PROTECTED_STORAGE_KEY_FILE_ENV = "OPENCLAW_PROTECTED_STORAGE_KEY_FILE";
const SEALED_TEXT_PREFIX = "OCSEAL1:";
const SEALED_VALUE_MAGIC = Buffer.from("OCSEAL1\n");
const TEXT_OPEN_FUNCTION = "openclaw_storage_text_open";
const TEXT_SEAL_FUNCTION = "openclaw_storage_text_seal";

type SqliteEncryptionState = {
  encryption?: StorageValueEncryption;
  strict: boolean;
};

const states = new WeakMap<DatabaseSync, SqliteEncryptionState>();

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Load the host-owned key without following a link or retaining the raw key. */
export function loadStorageValueEncryptionFromFile(
  keyPath: string,
  stateDir: string,
): StorageValueEncryption {
  if (!path.isAbsolute(keyPath) || !path.isAbsolute(stateDir)) {
    throw new Error("Protected storage key and state paths must be absolute.");
  }
  const stateRealPath = realpathSync(stateDir);
  const keyRealPath = realpathSync(keyPath);
  if (isWithin(stateRealPath, keyRealPath)) {
    throw new Error("Protected storage key must be outside the state directory.");
  }
  const before = lstatSync(keyPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error("Protected storage key must be a regular, unlinked file.");
  }
  if ((before.mode & 0o077n) !== 0n) {
    throw new Error("Protected storage key must not be readable by group or others.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && before.uid !== BigInt(uid)) {
    throw new Error("Protected storage key must be owned by the protected service user.");
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  if (noFollow === undefined) {
    throw new Error("This platform cannot safely open the protected storage key.");
  }
  const descriptor = openSync(keyPath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1n ||
      opened.size !== 32n
    ) {
      throw new Error("Protected storage key changed or has an invalid size.");
    }
    const key = Buffer.alloc(33);
    const bytesRead = readSync(descriptor, key, 0, key.length, 0);
    if (bytesRead !== 32) {
      throw new Error("Protected storage key must contain exactly 32 bytes.");
    }
    try {
      return createStorageValueEncryption(key.subarray(0, 32));
    } finally {
      key.fill(0);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function createSqliteStorageValueEncryptionFromEnvironment():
  | StorageValueEncryption
  | undefined {
  const keyPath = process.env[PROTECTED_STORAGE_KEY_FILE_ENV];
  if (!keyPath) {
    return undefined;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("Protected storage encryption requires OPENCLAW_STATE_DIR.");
  }
  return loadStorageValueEncryptionFromFile(keyPath, stateDir);
}

function decodeSealedText(value: string): Buffer {
  const encoded = value.slice(SEALED_TEXT_PREFIX.length);
  const decoded = Buffer.from(encoded, "base64");
  if (!encoded || decoded.toString("base64") !== encoded) {
    throw new Error("Invalid protected storage text envelope.");
  }
  return decoded;
}

function openTextValue(state: SqliteEncryptionState, value: string, context: string): string {
  if (!value.startsWith(SEALED_TEXT_PREFIX)) {
    if (state.strict) {
      throw new Error("Protected encrypted storage contains an unencrypted value.");
    }
    return value;
  }
  if (!state.encryption) {
    throw new Error(
      "Protected storage is encrypted but its key is unavailable; restore the key and restart the protected service.",
    );
  }
  return state.encryption.decryptText(decodeSealedText(value), context);
}

/** Install stable SQL functions; unencrypted databases keep identity semantics. */
export function registerSqliteStorageValueEncryption(
  database: DatabaseSync,
  encryption?: StorageValueEncryption,
): void {
  if (states.has(database)) {
    throw new Error("SQLite storage value encryption is already registered.");
  }
  const state: SqliteEncryptionState = { encryption, strict: false };
  database.function(
    TEXT_OPEN_FUNCTION,
    { deterministic: true, directOnly: true },
    (value: unknown, context: unknown) => {
      if (value === null) {
        return null;
      }
      if (typeof value !== "string" || typeof context !== "string") {
        throw new Error("Protected storage text requires a value and owner context.");
      }
      return openTextValue(state, value, context);
    },
  );
  database.function(
    TEXT_SEAL_FUNCTION,
    { directOnly: true },
    (value: unknown, context: unknown) => {
      if (value === null) {
        return null;
      }
      if (typeof value !== "string" || typeof context !== "string" || !context) {
        throw new Error("Protected storage text requires a value and owner context.");
      }
      return sealSqliteStorageText(database, value, context);
    },
  );
  states.set(database, state);
}

export function hasSqliteStorageValueEncryption(database: DatabaseSync): boolean {
  return Boolean(states.get(database)?.encryption);
}

export function isSqliteStorageValueEncryptionStrict(database: DatabaseSync): boolean {
  return states.get(database)?.strict ?? false;
}

export function protectedStorageValueContext(
  table: string,
  column: string,
  identity: readonly (string | number)[],
): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(table) || !/^[a-z][a-z0-9_]*$/u.test(column)) {
    throw new Error("Protected storage context requires canonical table and column names.");
  }
  const identityHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `openclaw:protected:${table}:${column}:${identityHash}`;
}

export function openSqliteStorageText(
  database: DatabaseSync,
  value: string,
  context: string,
): string {
  const state = states.get(database);
  if (!state) {
    throw new Error("SQLite storage value encryption is not registered.");
  }
  return openTextValue(state, value, context);
}

export function openSqliteStorageBytes(
  database: DatabaseSync,
  value: Uint8Array,
  context: string,
): Buffer {
  const state = states.get(database);
  if (!state) {
    throw new Error("SQLite storage value encryption is not registered.");
  }
  const bytes = Buffer.from(value);
  if (bytes.subarray(0, SEALED_VALUE_MAGIC.length).equals(SEALED_VALUE_MAGIC)) {
    if (!state.encryption) {
      throw new Error(
        "Protected storage is encrypted but its key is unavailable; restore the key and restart the protected service.",
      );
    }
    return state.encryption.decrypt(bytes, context);
  }
  if (state.strict) {
    throw new Error("Protected encrypted storage contains an unencrypted value.");
  }
  return bytes;
}

export function sealSqliteStorageText(
  database: DatabaseSync,
  value: string,
  context: string,
): string {
  const state = states.get(database);
  if (!state) {
    throw new Error("SQLite storage value encryption is not registered.");
  }
  if (!state.encryption) {
    return value;
  }
  if (value.startsWith(SEALED_TEXT_PREFIX)) {
    openTextValue(state, value, context);
    return value;
  }
  return `${SEALED_TEXT_PREFIX}${state.encryption.encryptText(value, context).toString("base64")}`;
}

export function sealSqliteStorageBytes(
  database: DatabaseSync,
  value: Uint8Array,
  context: string,
): Buffer {
  const state = states.get(database);
  if (!state) {
    throw new Error("SQLite storage value encryption is not registered.");
  }
  const bytes = Buffer.from(value);
  if (!state.encryption) {
    return bytes;
  }
  if (bytes.subarray(0, SEALED_VALUE_MAGIC.length).equals(SEALED_VALUE_MAGIC)) {
    state.encryption.decrypt(bytes, context);
    return bytes;
  }
  return state.encryption.encrypt(bytes, context);
}

export function setSqliteStorageValueEncryptionStrict(
  database: DatabaseSync,
  strict: boolean,
): void {
  const state = states.get(database);
  if (!state) {
    throw new Error("SQLite storage value encryption is not registered.");
  }
  state.strict = strict;
}

/** Close the per-connection key handle when its SQLite owner is disposed. */
export function disposeSqliteStorageValueEncryption(database: DatabaseSync): void {
  const state = states.get(database);
  if (!state) {
    return;
  }
  states.delete(database);
  state.encryption?.dispose();
}
