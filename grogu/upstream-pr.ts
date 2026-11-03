import { z } from "zod";

const commit = z.string().regex(/^[a-f0-9]{40}$/);

const rollingPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url(),
    headRefOid: commit,
    isDraft: z.boolean(),
    autoMergeRequest: z.union([z.null(), z.object({}).passthrough()]),
  })
  .strict();

export function admitRollingPullRequests(value: unknown, expectedHead?: string) {
  const pullRequests = z.array(rollingPullRequestSchema).parse(value);
  if (pullRequests.length > 1) {
    throw new Error("More than one open rolling upstream pull request exists");
  }
  const pullRequest = pullRequests[0];
  if (!pullRequest) {
    return pullRequests;
  }
  if (!pullRequest.isDraft || pullRequest.autoMergeRequest !== null) {
    throw new Error("The rolling upstream pull request must remain draft-only with auto-merge off");
  }
  if (expectedHead !== undefined && pullRequest.headRefOid !== expectedHead) {
    throw new Error("The rolling PR head changed during candidate preparation");
  }
  return pullRequests;
}
