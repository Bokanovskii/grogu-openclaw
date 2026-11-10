import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export function readWorkflowSource(filePath: string): Buffer {
  const directory = path.dirname(filePath);
  const archivedPath =
    path.basename(directory) === "workflows" && path.basename(path.dirname(directory)) === ".github"
      ? path.join(directory, "..", "upstream-workflows", path.basename(filePath))
      : undefined;
  let source: Buffer;
  try {
    source = readFileSync(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || !archivedPath) {
      throw error;
    }
    try {
      lstatSync(filePath);
    } catch (inspectionError) {
      if (
        inspectionError instanceof Error &&
        "code" in inspectionError &&
        inspectionError.code === "ENOENT"
      ) {
        // Forks retain upstream definitions outside GitHub Actions' executable directory.
        return readFileSync(archivedPath);
      }
      throw inspectionError;
    }
    throw new Error(
      `Resolve unreadable active workflow entry before using its archive: ${filePath}`,
      {
        cause: error,
      },
    );
  }
  if (archivedPath) {
    try {
      lstatSync(archivedPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return source;
      }
      throw error;
    }
    throw new Error(`Resolve competing active and archived workflow definitions: ${filePath}`);
  }
  return source;
}
