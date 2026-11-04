import { describe, expect, it } from "vitest";
import { admitRollingPullRequests } from "../../grogu/upstream-pr.js";

const pullRequest = {
  number: 12,
  url: "https://github.com/example/private/pull/12",
  headRefOid: "a".repeat(40),
  isDraft: true,
  autoMergeRequest: null,
};

describe("rolling upstream pull request admission", () => {
  it("admits only a single draft with auto-merge disabled at the expected head", () => {
    expect(admitRollingPullRequests([pullRequest], pullRequest.headRefOid)).toEqual([pullRequest]);
    expect(() => admitRollingPullRequests([pullRequest], "b".repeat(40))).toThrow(/head changed/);
  });

  it("refuses publication when draft-only or manual-merge safeguards changed", () => {
    for (const changed of [
      { ...pullRequest, isDraft: false },
      { ...pullRequest, autoMergeRequest: { mergeMethod: "MERGE" } },
      pullRequest,
    ]) {
      expect(() =>
        admitRollingPullRequests(
          changed === pullRequest ? [pullRequest, pullRequest] : [changed],
          pullRequest.headRefOid,
        ),
      ).toThrow();
    }
  });
});
