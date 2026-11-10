import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRastermill } from "rastermill";
import { isDirectScriptExecution, runUiCli } from "../scripts/ui.mts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export async function prepareGroguPublicAssets(publicDir: string): Promise<void> {
  fs.cpSync(path.join(repoRoot, "ui/public"), publicDir, { recursive: true });
  const manifestPath = path.join(publicDir, "manifest.webmanifest");
  const manifest: Record<string, unknown> = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, name: "Grogu", short_name: "Grogu" }, null, 2)}\n`,
  );

  const icon = fs.readFileSync(path.join(repoRoot, "grogu/ui-assets/app-icon.png"));
  const images = createRastermill({ execution: "internal" });
  for (const [filename, maxSide] of [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
  ] as const) {
    const output = await images.encode(icon, { format: "png", resize: { maxSide } });
    fs.writeFileSync(path.join(publicDir, filename), output.data);
  }
  fs.writeFileSync(
    path.join(publicDir, "favicon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><image width="1024" height="1024" href="data:image/png;base64,${icon.toString("base64")}"/></svg>\n`,
  );
}

if (isDirectScriptExecution(process.argv[1], fileURLToPath(import.meta.url))) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grogu-ui-"));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  // The canonical runner exits directly on a failed build; retain cleanup on that path.
  process.once("exit", cleanup);
  try {
    const publicDir = path.join(directory, "public");
    await prepareGroguPublicAssets(publicDir);
    const config = path.join(directory, "vite.config.mjs");
    const upstream = pathToFileURL(path.join(repoRoot, "ui/vite.config.ts")).href;
    fs.writeFileSync(
      config,
      `import upstream from ${JSON.stringify(upstream)};\nexport default (env) => ({...upstream(env), publicDir: ${JSON.stringify(publicDir)}});\n`,
    );
    runUiCli(["build", "--config", config, ...process.argv.slice(2)]);
  } finally {
    process.off("exit", cleanup);
    cleanup();
  }
}
