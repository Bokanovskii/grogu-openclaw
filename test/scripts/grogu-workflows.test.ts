import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveUpstreamWorkflows, assertWorkflowIsolation } from "../../grogu/workflows.js";
import { createGroguRuntimeFixture } from "../../src/agents/grogu-runtime.test-support.js";

const fixtures: ReturnType<typeof createGroguRuntimeFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.cleanup()));

function workflowFixture() {
  const fixture = createGroguRuntimeFixture();
  fixtures.push(fixture);
  const active = path.join(fixture.directory, ".github/workflows");
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, "grogu-ci.yml"), "synthetic downstream workflow");
  fs.writeFileSync(path.join(active, "locale-refresh.yml"), "synthetic upstream workflow");
  return { fixture, active };
}

describe("upstream automation quarantine", () => {
  it("keeps the full lint stage local while preserving the hosted source gate", () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/grogu-ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("Run offline source checks without the lint stage");
    expect(workflow).toContain("pnpm check --skip-lint --base");
    expect(workflow).toContain("Control UI i18n verify");
    expect(workflow).toContain("type-aware Oxlint/tsgolint");
    expect(workflow).toContain("Stylelint");
    expect(workflow).toContain("REQUIRED LOCAL gate");
    expect(workflow).not.toContain("continue-on-error");
    const freeDisk = workflow.indexOf("- name: Free runner disk");
    const checkout = workflow.indexOf("- uses: actions/checkout@");
    expect(freeDisk).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(freeDisk);
    expect(workflow).toMatch(/- name: Report runner disk\n\s+if: always\(\)/u);
  });

  it("rejects newly introduced upstream workflows and preserves them outside the executable directory", async () => {
    const { fixture, active } = workflowFixture();
    await expect(assertWorkflowIsolation(fixture.directory)).rejects.toThrow(/locale-refresh/);
    await archiveUpstreamWorkflows(fixture.directory);
    await expect(assertWorkflowIsolation(fixture.directory)).resolves.toBeUndefined();
    expect(
      fs.readFileSync(
        path.join(fixture.directory, ".github/upstream-workflows/locale-refresh.yml"),
        "utf8",
      ),
    ).toBe("synthetic upstream workflow");
    expect(fs.existsSync(path.join(active, "grogu-ci.yml"))).toBe(true);
  });

  it("refuses competing definitions instead of overwriting a maintained archived workflow", async () => {
    const { fixture, active } = workflowFixture();
    const archive = path.join(fixture.directory, ".github/upstream-workflows");
    fs.mkdirSync(archive);
    fs.writeFileSync(path.join(archive, "locale-refresh.yml"), "maintained definition");
    await expect(archiveUpstreamWorkflows(fixture.directory)).rejects.toThrow(/competing/);
    expect(fs.readFileSync(path.join(archive, "locale-refresh.yml"), "utf8")).toBe(
      "maintained definition",
    );
    expect(fs.existsSync(path.join(active, "locale-refresh.yml"))).toBe(true);
  });
});
