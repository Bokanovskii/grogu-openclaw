import { describe, expect, it } from "vitest";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { describeCronExpression } from "./schedule-description.ts";

registerCronEnglish();

describe("saved cron schedules in words", () => {
  it.each([
    ["0 8 * * *", "Every day at 08:00"],
    ["30 9 * * 1-5", "Weekdays at 09:30"],
    ["0 0 8 * * 1", "Mondays at 08:00"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 * * * *", "Every hour at minute 00"],
  ])("describes %s from its actual fields", (expression, description) => {
    expect(describeCronExpression(expression)).toBe(description);
  });

  it("does not mistake a six-field seconds schedule for a daily schedule", () => {
    expect(describeCronExpression("*/5 0 8 * * *")).toContain("seconds */5");
    expect(describeCronExpression("0 8 1 * 1")).toContain("days 1");
  });

  it("preserves minute steps with an uneven gap at the hour boundary", () => {
    expect(describeCronExpression("*/7 * * * *")).toContain("minutes */7");
    expect(describeCronExpression("*/7 * * * *")).not.toContain("Every 7 minutes");
  });
});
