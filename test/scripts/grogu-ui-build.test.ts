import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readImageProbeFromHeader } from "rastermill";
import { afterEach, expect, it } from "vitest";
import { prepareGroguPublicAssets } from "../../grogu/ui-build.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("brands the app without changing upstream manifest identity or unrelated public assets", async () => {
  const output = path.join(tempDirs.make("grogu-ui-assets-"), "public");
  await prepareGroguPublicAssets(output);

  const template = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "ui/public/manifest.webmanifest"), "utf8"),
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.webmanifest"), "utf8"));
  expect(manifest).toEqual({ ...template, name: "Grogu", short_name: "Grogu" });
  for (const [filename, size] of [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
  ] as const) {
    expect(readImageProbeFromHeader(fs.readFileSync(path.join(output, filename)))).toMatchObject({
      format: "png",
      width: size,
      height: size,
    });
  }
  const embeddedIcon = fs
    .readFileSync(path.join(output, "favicon.svg"), "utf8")
    .match(/href="data:image\/png;base64,([^"]+)"/)?.[1];
  expect(embeddedIcon).toBe(
    fs.readFileSync(path.join(repoRoot, "grogu/ui-assets/app-icon.png")).toString("base64"),
  );
  for (const filename of ["favicon.ico", "sw.js"]) {
    expect(fs.readFileSync(path.join(output, filename))).toEqual(
      fs.readFileSync(path.join(repoRoot, "ui/public", filename)),
    );
  }
});
