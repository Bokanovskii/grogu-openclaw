import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { CronJob } from "../../api/types.ts";
import { renderCronJobsPagination } from "../../components/cron-jobs-pagination.ts";
import { icon } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { isCronJobActiveFailure } from "../../lib/cron-status.ts";
import type { CronProps } from "./view-types.ts";

registerCronEnglish();

export function renderJobsTable(
  props: CronProps,
  hasAnyJobsFilters: boolean,
  renderJob: (job: CronJob) => unknown,
) {
  // A snapshot revision is the successful-list fact. Until one exists, show
  // pending or failure, never completed-empty guidance.
  const initialPending = props.loading && !props.hasLoaded;
  const tableBusy = props.loading || props.jobsLoadingMore;
  const jobs = props.jobs.toSorted(
    (left, right) => Number(isCronJobActiveFailure(right)) - Number(isCronJobActiveFailure(left)),
  );
  const knownGroups = new Map((props.groups ?? []).map((group) => [group.id, group]));
  const groupedJobs = [
    ...(props.groups ?? [])
      .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label))
      .map((group) => ({
        id: group.id,
        label: group.label,
        description: group.description,
        jobs: jobs.filter((job) => job.groupId === group.id),
      })),
    {
      id: "",
      label: t("cron.groups.other"),
      description: t("cron.groups.otherDescription"),
      jobs: jobs.filter((job) => !job.groupId || !knownGroups.has(job.groupId)),
    },
  ].filter((group) => group.jobs.length > 0);
  return html`
    <div
      class="cron-table ${props.canManage ? "" : "cron-table--read-only"}"
      aria-busy=${tableBusy ? "true" : nothing}
    >
      <div class="cron-table__head">
        <span>${t("cron.jobs.name")}</span>
        <span>${t("cron.jobs.schedule")}</span>
        <span>${t("cron.jobs.nextRun")}</span>
        <span>${t("cron.jobs.lastRun")}</span>
        ${props.canManage ? html`<span aria-hidden="true"></span>` : nothing}
      </div>
      ${
        jobs.length === 0
          ? initialPending
            ? html`
                <div
                  class="cron-empty-state"
                  role="status"
                  aria-live="polite"
                  data-test-id="cron-jobs-loading"
                >
                  <div class="cron-empty-state__title">${t("cron.list.loading")}</div>
                </div>
              `
            : props.hasLoaded
              ? html`
                  <div class="cron-empty-state">
                    <div class="cron-empty-state__title">
                      ${hasAnyJobsFilters ? t("cron.list.noMatching") : t("cron.list.emptyTitle")}
                    </div>
                    ${
                      hasAnyJobsFilters
                        ? nothing
                        : html`<div class="cron-empty-state__copy">
                            ${t("cron.list.emptyHint")}
                          </div>`
                    }
                  </div>
                `
              : nothing
          : repeat(
              groupedJobs,
              (group) => group.id,
              (group) => html`
                <details class="cron-group" data-cron-group=${group.id || "other"} open>
                  <summary class="cron-group__heading">
                    <span class="cron-group__chevron" aria-hidden="true"
                      >${icon("chevronRight")}</span
                    >
                    <span class="cron-group__copy">
                      <span class="cron-group__title"
                        >${group.label}<span class="cron-group__count"
                          >${group.jobs.length}</span
                        ></span
                      >
                      ${group.description ? html`<span class="cron-group__description">${group.description}</span>` : nothing}
                    </span>
                  </summary>
                  ${repeat(group.jobs, (job) => job.id, renderJob)}
                </details>
              `,
            )
      }
      ${renderCronJobsPagination({
        jobsShown: props.jobs.length,
        jobsTotal: props.jobsTotal,
        hasMore: props.jobsHasMore,
        loading: props.loading,
        loadingMore: props.jobsLoadingMore,
        onLoadMore: props.onLoadMoreJobs,
      })}
    </div>
  `;
}
