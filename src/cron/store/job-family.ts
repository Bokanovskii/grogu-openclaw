import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { isSqliteStorageValueEncryptionStrict } from "../../storage/sqlite-encryption.js";
import { openCronJobValue } from "./job-encryption.js";
import { deleteCronJobRowInDatabase } from "./row-codec.js";
import { getCronStoreKysely } from "./schema.js";

export type CronJobFamilyIdentity = {
  declarationKey: string;
  name: string;
  ownerPluginTag: string;
};

/** Removes one owned job family from obsolete store partitions. */
export function deleteStaleCronJobFamilyRows(
  db: DatabaseSync,
  activeStoreKey: string,
  family: CronJobFamilyIdentity,
): number {
  const protectedStorage = isSqliteStorageValueEncryptionStrict(db);
  const staleRows = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .select(["store_key", "job_id", "declaration_key", "name"])
      .select((eb) => [
        // Native UTF-8 decoding can replace malformed bytes; only ASCII names
        // admit an exact SQL comparison before the existing JavaScript filter.
        !protectedStorage && /^\p{ASCII}*$/u.test(family.name)
          ? eb
              .case()
              .when("name", "=", family.name)
              .then(eb.ref("description"))
              .else(null)
              .end()
              .as("description")
          : "description",
      ])
      .where("store_key", "!=", activeStoreKey),
  ).rows.filter((row) => {
    if (row.declaration_key === family.declarationKey) {
      return true;
    }
    const name = openCronJobValue(db, row.store_key, row.job_id, "name", row.name);
    if (name !== family.name) {
      return false;
    }
    const description = openCronJobValue(
      db,
      row.store_key,
      row.job_id,
      "description",
      row.description,
    );
    return description?.includes(family.ownerPluginTag) === true;
  });
  for (const row of staleRows) {
    deleteCronJobRowInDatabase(db, row.store_key, row.job_id);
  }
  return staleRows.length;
}
