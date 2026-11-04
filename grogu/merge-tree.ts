import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);

export function parseMergeTreeNameOnlyZ(output: string): {
  tree: string;
  conflicts: string[];
} {
  const fields = output.split("\0");
  const tree = sha.parse(fields.shift());
  const conflicts: string[] = [];
  for (const field of fields) {
    if (!field) {
      break;
    }
    conflicts.push(field);
  }
  return { tree, conflicts };
}
