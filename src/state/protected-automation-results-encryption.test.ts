import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createStorageValueEncryption } from "../storage/encryption.js";
import {
  disposeSqliteStorageValueEncryption,
  registerSqliteStorageValueEncryption,
  setSqliteStorageValueEncryptionStrict,
} from "../storage/sqlite-encryption.js";
import {
  openProtectedAutomationResultText,
  prepareProtectedAutomationResultText,
} from "./protected-automation-results-encryption.js";

it("seals result text only on a strict keyed connection and binds its stored bytes to its identity", () => {
  const db = new DatabaseSync(":memory:");
  const context = {
    table: "protected_automation_runs",
    column: "payload_json",
    identity: ["synthetic-run"],
  };
  const plaintext = JSON.stringify({ text: "Synthetic text 🦉" });
  const encryption = createStorageValueEncryption(randomBytes(32));
  try {
    registerSqliteStorageValueEncryption(db, encryption);
    expect(() => prepareProtectedAutomationResultText(db, plaintext, context)).toThrow(
      /admitted encrypted state database/,
    );
    setSqliteStorageValueEncryptionStrict(db, true);
    const prepared = prepareProtectedAutomationResultText(db, plaintext, context);
    expect(prepared.value).not.toContain("Synthetic text");
    expect(JSON.parse(prepared.value)).toMatch(/^OCSEAL1:/);
    expect(prepared.storedBytes).toBe(
      db.prepare("SELECT length(CAST(? AS BLOB)) AS bytes").get(prepared.value)?.bytes,
    );
    expect(openProtectedAutomationResultText(db, prepared.value, context)).toBe(plaintext);
    expect(() =>
      openProtectedAutomationResultText(db, prepared.value, {
        ...context,
        identity: ["another-run"],
      }),
    ).toThrow();
    expect(() => openProtectedAutomationResultText(db, JSON.stringify(plaintext), context)).toThrow(
      /unencrypted value/,
    );
  } finally {
    disposeSqliteStorageValueEncryption(db);
    db.close();
  }
});

it("rejects a strict connection without the encryption key", () => {
  const db = new DatabaseSync(":memory:");
  try {
    registerSqliteStorageValueEncryption(db);
    setSqliteStorageValueEncryptionStrict(db, true);
    expect(() =>
      prepareProtectedAutomationResultText(db, "synthetic", {
        table: "protected_automation_runs",
        column: "payload_json",
        identity: ["synthetic-run"],
      }),
    ).toThrow(/admitted encrypted state database/);
  } finally {
    disposeSqliteStorageValueEncryption(db);
    db.close();
  }
});
