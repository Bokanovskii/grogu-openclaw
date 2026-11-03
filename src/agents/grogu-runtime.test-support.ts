import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createGroguRuntimeFixture() {
  const directory = path.join(process.cwd(), ".cache", `grogu-runtime-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const profileFile = path.join(directory, "profile.json");
  const workspace = path.join(directory, "research");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const profile = {
    schemaVersion: 1,
    bindings: {
      researchCheckpoint: {
        workspace,
        tracks: ["alpha", "beta"],
        artifactPrefix: "plans/synthetic/",
      },
    },
  };
  fs.writeFileSync(profileFile, JSON.stringify(profile), { mode: 0o600 });
  return {
    directory,
    profileFile,
    workspace,
    profile,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
