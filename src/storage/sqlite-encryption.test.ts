import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createStorageValueEncryption } from "./encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "./sqlite-encryption.js";

describe("SQLite storage value encryption", () => {
  it("binds encrypted text to its owner and rejects plaintext after admission", () => {
    const database = new DatabaseSync(":memory:");
    const encryption = createStorageValueEncryption(randomBytes(32));
    try {
      registerSqliteStorageValueEncryption(database, encryption);
      const input = "literal \\uD800 and NUL \0";
      const sealed = database
        .prepare("SELECT openclaw_storage_text_seal(?, ?) AS value")
        .get(input, "protected:chat:1") as { value: string };
      expect(sealed.value).not.toContain(input);
      expect(
        database
          .prepare("SELECT openclaw_storage_text_open(?, ?) AS value")
          .get(sealed.value, "protected:chat:1"),
      ).toEqual({ value: input });
      expect(() =>
        database
          .prepare("SELECT openclaw_storage_text_open(?, ?) AS value")
          .get(sealed.value, "protected:chat:2"),
      ).toThrow();
      setSqliteStorageValueEncryptionStrict(database, true);
      expect(() =>
        database
          .prepare("SELECT openclaw_storage_text_open(?, ?) AS value")
          .get(input, "protected:chat:1"),
      ).toThrow();
    } finally {
      disposeSqliteStorageValueEncryption(database);
      database.close();
    }
  });

  it("refuses encrypted values when no key is available", () => {
    const source = new DatabaseSync(":memory:");
    const target = new DatabaseSync(":memory:");
    const encryption = createStorageValueEncryption(randomBytes(32));
    try {
      registerSqliteStorageValueEncryption(source, encryption);
      registerSqliteStorageValueEncryption(target);
      const { value } = source
        .prepare("SELECT openclaw_storage_text_seal(?, ?) AS value")
        .get("chat text", "protected:chat:1") as { value: string };
      expect(() =>
        target.prepare("SELECT openclaw_storage_text_open(?, ?)").get(value, "protected:chat:1"),
      ).toThrow(/key is unavailable/);
    } finally {
      disposeSqliteStorageValueEncryption(source);
      disposeSqliteStorageValueEncryption(target);
      source.close();
      target.close();
    }
  });
});
