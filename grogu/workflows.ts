import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";

const allowed = new Set(["grogu-ci.yml", "grogu-upstream.yml"]);

export async function assertWorkflowIsolation(root: string) {
  for (const entry of await readdir(path.join(root, ".github/workflows"), {
    withFileTypes: true,
  })) {
    if (/\.(yml|yaml)$/.test(entry.name) && (!entry.isFile() || !allowed.has(entry.name))) {
      throw new Error(`Inherited workflow must remain quarantined: ${entry.name}`);
    }
  }
}

export async function archiveUpstreamWorkflows(root: string) {
  const active = path.join(root, ".github/workflows");
  const archive = path.join(root, ".github/upstream-workflows");
  await mkdir(archive, { recursive: true });
  for (const entry of await readdir(active, { withFileTypes: true })) {
    if (!/\.(yml|yaml)$/.test(entry.name) || allowed.has(entry.name)) {
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Refusing a non-regular upstream workflow: ${entry.name}`);
    }
    const target = path.join(archive, entry.name);
    try {
      await lstat(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        await rename(path.join(active, entry.name), target);
        continue;
      }
      throw error;
    }
    throw new Error(`Resolve competing archived and active workflow definitions: ${entry.name}`);
  }
  await assertWorkflowIsolation(root);
}
