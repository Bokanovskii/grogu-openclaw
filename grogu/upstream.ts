import { execFile } from "node:child_process";
import { promisify } from "node:util";
import semver from "semver";
import { z } from "zod";
import embeddedPin from "./upstream.json" with { type: "json" };

const execute = promisify(execFile);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const release = z.string().regex(/^v[0-9]{4}\.[0-9]{1,2}\.[0-9]+$/);
const upstreamPin = z
  .object({
    schemaVersion: z.literal(1),
    repository,
    release,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
const stableRelease = z
  .object({
    tag_name: release,
    draft: z.literal(false),
    prerelease: z.literal(false),
    html_url: z.string().url(),
  })
  .passthrough();

export function compareStableRelease(current: string, candidate: unknown) {
  release.parse(current);
  const latest = stableRelease.parse(candidate);
  return {
    current,
    latest: latest.tag_name,
    newer: semver.gt(latest.tag_name.slice(1), current.slice(1)),
    releaseUrl: latest.html_url,
  };
}

export async function checkUpstream(cwd: string) {
  const { stdout: rootOutput } = await execute("git", ["rev-parse", "--show-toplevel"], { cwd });
  const root = rootOutput.trim();
  await execute("git", ["status", "--short", "--branch"], { cwd: root });
  const pin = upstreamPin.parse(embeddedPin);
  const { stdout: originUrl } = await execute("git", ["remote", "get-url", "origin"], {
    cwd: root,
  });
  const originName = originUrl
    .trim()
    .replace(/\.git$/, "")
    .match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/)?.[1];
  if (!originName) {
    throw new Error(
      "Upstream maintenance requires an explicit GitHub origin without embedded credentials",
    );
  }
  const { stdout: originOutput } = await execute(
    "gh",
    ["repo", "view", originName, "--json", "nameWithOwner,isPrivate"],
    { cwd: root },
  );
  const origin = z
    .object({ nameWithOwner: repository, isPrivate: z.literal(true) })
    .parse(JSON.parse(originOutput));
  const { stdout } = await execute("gh", ["api", `repos/${pin.repository}/releases/latest`], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  return {
    root,
    origin: origin.nameWithOwner,
    upstream: pin.repository,
    pinnedCommit: pin.commit,
    ...compareStableRelease(pin.release, JSON.parse(stdout)),
  };
}
