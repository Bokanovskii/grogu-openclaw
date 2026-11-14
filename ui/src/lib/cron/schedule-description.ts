import { t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";

registerCronEnglish();

/** Describe the actual cron fields, never a separately maintained schedule label. */
export function describeCronExpression(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = fields.length === 6 ? fields.slice(1) : fields;
  const seconds = fields.length === 6 ? fields[0] : undefined;
  if ((!seconds || seconds === "0") && day === "*" && month === "*") {
    if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")) {
      const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
      if (weekday === "*") {
        return t("cron.scheduleWords.daily", { time });
      }
      if (weekday === "1-5") {
        return t("cron.scheduleWords.weekdays", { time });
      }
      const names = weekday
        ?.split(",")
        .map((value) =>
          /^[0-7]$/.test(value) ? t(`cron.scheduleWords.day${Number(value) % 7}`) : null,
        );
      if (names?.length && names.every(Boolean)) {
        return t("cron.scheduleWords.weekly", { days: names.join(", "), time });
      }
    }
    if (hour === "*" && weekday === "*" && minute === "*") {
      return t("cron.scheduleWords.everyMinute");
    }
    if (
      hour === "*" &&
      weekday === "*" &&
      /^\*\/\d+$/.test(minute ?? "") &&
      60 % Number(minute!.slice(2)) === 0
    ) {
      return t("cron.scheduleWords.everyMinutes", { count: minute!.slice(2) });
    }
    if (hour === "*" && weekday === "*" && /^\d+$/.test(minute ?? "")) {
      return t("cron.scheduleWords.hourly", { minute: minute!.padStart(2, "0") });
    }
  }
  // Complex schedules retain every field, including cron's day-of-month/weekday OR semantics.
  return t("cron.scheduleWords.fields", {
    minute: minute ?? "?",
    hour: hour ?? "?",
    day: day ?? "?",
    month: month ?? "?",
    weekday: weekday ?? "?",
    ...(seconds ? { seconds } : { seconds: "0" }),
  });
}
