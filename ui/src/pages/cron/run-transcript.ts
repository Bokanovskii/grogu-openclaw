import type { CronHistoryResult } from "@openclaw/gateway-protocol";
import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronRunLogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { isCronJobRunning } from "../../lib/cron-status.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { attachHistoryActivity } from "../chat/chat-history-request.ts";
import { mergeChatTranscriptPages } from "../chat/chat-transcript-pages.ts";
import { renderChatHistoryBoundary } from "../chat/components/chat-history-boundary.ts";
import { renderChatTranscriptFeed } from "../chat/components/chat-transcript-feed.ts";
import type { CronProps } from "./view-types.ts";

type Scope = { client: GatewayBrowserClient; isCurrent: () => boolean };
type Owner = { gateway: GatewayPageController; cron: CronState };
registerCronEnglish();

/** The run log owns transcript identity; never resolve a client-selected session alias. */
export class CronRunTranscript implements ReactiveController {
  private attempt = 0;
  private entry: CronRunLogEntry | null = null;
  private trigger: HTMLButtonElement | null = null;
  private scope: Scope | null = null;
  private messages: unknown[] = [];
  private latestMessages: unknown[] = [];
  private earlierMessages: unknown[] = [];
  private nextCursor: string | undefined;
  private readonly cursors = new Set<string>();
  private loading = false;
  private error: string | null = null;
  private failedCursor: string | undefined;
  private live = false;
  private refreshPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private workspace: CronJob | null = null;

  constructor(
    private readonly host: HTMLElement & ReactiveControllerHost,
    private readonly owner: () => Owner,
  ) {
    host.addController(this);
  }

  private capture(): Scope | null {
    const { gateway, cron } = this.owner();
    const scope = gateway.capture();
    return scope
      ? {
          client: scope.client,
          isCurrent: () => gateway.isCurrent(scope) && this.owner().cron === cron,
        }
      : null;
  }

  viewProps(
    onWorkspace: () => void,
  ): Pick<
    CronProps,
    "onViewRunTranscript" | "onViewLiveRun" | "onViewWorkspace" | "runTranscript"
  > {
    return {
      onViewRunTranscript: (entry, trigger) => void this.open(entry, trigger),
      onViewLiveRun: (job, trigger) => void this.openLive(job, trigger),
      onViewWorkspace: (job, trigger) => {
        onWorkspace();
        void this.openWorkspace(job, trigger);
      },
      runTranscript: this.render(),
    };
  }

  hostDisconnected() {
    this.close();
  }

  close(restoreFocus = false) {
    const trigger = this.trigger;
    this.trigger = null;
    this.attempt++;
    this.entry = null;
    this.scope = null;
    this.messages = [];
    this.latestMessages = [];
    this.earlierMessages = [];
    this.nextCursor = undefined;
    this.cursors.clear();
    this.loading = false;
    this.error = null;
    this.failedCursor = undefined;
    this.live = false;
    this.workspace = null;
    this.refreshPending = false;
    this.clearTimer();
    this.host.requestUpdate();
    if (restoreFocus && trigger?.isConnected) {
      trigger.focus();
    }
  }

  async open(entry: CronRunLogEntry, trigger: HTMLButtonElement) {
    this.close();
    const scope = this.capture();
    if (!scope) {
      return;
    }
    this.entry = entry;
    this.trigger = trigger;
    this.scope = scope;
    await this.load();
    await this.focusTranscript(scope);
  }

  async openLive(job: CronJob, trigger: HTMLButtonElement) {
    if (!isCronJobRunning(job) || job.state.runningAtMs === undefined) {
      return;
    }
    const opening = this.open(
      {
        jobId: job.id,
        jobName: job.displayName ?? job.name,
        action: "finished",
        ts: job.state.runningAtMs,
        runAtMs: job.state.runningAtMs,
      },
      trigger,
    );
    this.live = true;
    await opening;
    this.scheduleRefresh();
  }

  async openWorkspace(job: CronJob, trigger: HTMLButtonElement) {
    this.close();
    const scope = this.capture();
    if (!scope || !job.sessionTarget.startsWith("session:")) {
      return;
    }
    this.scope = scope;
    this.workspace = job;
    this.trigger = trigger;
    this.live = true;
    await this.load();
    await this.focusTranscript(scope);
    this.scheduleRefresh();
  }

  private async focusTranscript(scope: Scope, attempt = this.attempt) {
    await this.host.updateComplete;
    if (this.attempt !== attempt || this.scope !== scope || !scope.isCurrent()) {
      return;
    }
    const region = this.host.querySelector<HTMLElement>("[data-cron-run-transcript]");
    region?.focus({ preventScroll: true });
    region?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  refresh(entries?: CronRunLogEntry[], job?: CronJob | null) {
    if (!this.live || !this.scope?.isCurrent() || document.visibilityState === "hidden") {
      return;
    }
    let becameRecorded = false;
    if (this.entry && entries) {
      const completed = entries.find(
        (entry) => entry.jobId === this.entry?.jobId && entry.runAtMs === this.entry.runAtMs,
      );
      if (completed) {
        this.entry = completed;
        becameRecorded = true;
      } else if (job?.id === this.entry.jobId && !isCronJobRunning(job)) {
        becameRecorded = true;
      }
    }
    if (becameRecorded) {
      this.live = false;
      this.clearTimer();
      this.attempt++;
      this.loading = false;
      this.refreshPending = false;
      this.messages = [];
      this.latestMessages = [];
      this.earlierMessages = [];
      this.nextCursor = undefined;
      this.cursors.clear();
      this.error = null;
      this.failedCursor = undefined;
      this.host.requestUpdate();
      void this.load();
      return;
    }
    if (this.loading) {
      this.refreshPending = true;
    } else {
      void this.load();
    }
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleRefresh() {
    this.clearTimer();
    if (!this.live || !this.host.isConnected || !this.scope?.isCurrent()) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (document.visibilityState !== "hidden") {
        this.refresh();
      }
      this.scheduleRefresh();
    }, 5_000);
  }
  private async load(cursor?: string) {
    const { entry, scope, attempt, workspace } = this;
    if ((!entry && !workspace) || !scope || this.loading || !scope.isCurrent()) {
      return;
    }
    const current = () => this.attempt === attempt && this.host.isConnected && scope.isCurrent();
    this.loading = true;
    this.error = null;
    this.failedCursor = cursor;
    this.host.requestUpdate();
    try {
      if (
        !workspace &&
        (!entry?.jobId ||
          (!entry.runId && (typeof entry.runAtMs !== "number" || !Number.isFinite(entry.runAtMs))))
      ) {
        throw new Error(t("cron.runEntry.transcriptMissingMetadata"));
      }
      const result = await scope.client.request<
        CronHistoryResult & { hasMore?: boolean; nextOffset?: number }
      >(workspace ? "chat.history" : "cron.history", {
        ...(workspace
          ? {
              sessionKey: workspace.sessionTarget.slice("session:".length),
              ...(workspace.agentId ? { agentId: workspace.agentId } : {}),
            }
          : {
              id: entry!.jobId,
              ...(entry!.runId ? { runId: entry!.runId } : { runAtMs: entry!.runAtMs }),
            }),
        limit: 100,
        ...(cursor ? (workspace ? { offset: Number(cursor) } : { cursor }) : {}),
      });
      if (!current()) {
        return;
      }
      if (!Array.isArray(result.messages)) {
        throw new Error(t("cron.runEntry.transcriptUnavailable"));
      }
      const messages = visibleChatHistoryMessages(attachHistoryActivity(result).messages);
      if (cursor) {
        this.cursors.add(cursor);
      }
      if (cursor) {
        this.earlierMessages = mergeChatTranscriptPages(messages, this.earlierMessages).messages;
      } else {
        this.latestMessages = messages;
      }
      this.messages = this.earlierMessages.length
        ? mergeChatTranscriptPages(this.earlierMessages, this.latestMessages).messages
        : this.latestMessages;
      const nextCursor =
        workspace && result.hasMore && result.nextOffset !== undefined
          ? String(result.nextOffset)
          : result.nextCursor;
      if (cursor || this.cursors.size === 0) {
        this.nextCursor = nextCursor && !this.cursors.has(nextCursor) ? nextCursor : undefined;
      }
      this.failedCursor = undefined;
    } catch (error) {
      if (!current()) {
        return;
      }
      this.error = formatUiError(error, t("cron.runEntry.transcriptUnavailable"));
    }
    if (current()) {
      this.loading = false;
      this.host.requestUpdate();
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.load();
      }
    }
  }

  render() {
    if (!this.entry && !this.workspace) {
      return nothing;
    }
    return html`<section
      class="cron-run-transcript"
      role="region"
      tabindex="-1"
      aria-label=${t("cron.runEntry.transcript")}
      data-cron-run-transcript
    >
      <div class="cron-run-transcript__header">
        <h2>
          ${this.workspace ? t("cron.groups.workspace") : this.live ? t("cron.groups.live") : t("cron.runEntry.transcript")}
        </h2>
        <button class="btn btn--sm" @click=${() => this.close(true)}>${t("common.close")}</button>
      </div>
      ${this.live ? html`<p class="muted" role="status">${t("cron.groups.liveUpdating")}</p>` : nothing}
      ${
        this.error
          ? html`<p role="alert">${this.error}</p>
              <button
                class="btn btn--sm"
                ?disabled=${this.loading}
                @click=${() => void this.load(this.failedCursor)}
              >
                ${t("common.retry")}
              </button>`
          : nothing
      }
      ${this.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
      ${
        this.nextCursor
          ? renderChatHistoryBoundary({
              hasMore: true,
              loading: this.loading,
              onShowEarlier: () => void this.load(this.nextCursor),
            })
          : nothing
      }
      ${!this.loading && !this.error && this.messages.length === 0 ? html`<p>${t("cron.runEntry.transcriptEmpty")}</p>` : nothing}
      ${renderChatTranscriptFeed(this.messages, { showReasoning: true, showToolOutput: true })}
      ${
        this.entry
          ? html`<div class="cron-run-delivery">
              <strong>${t("cron.groups.delivery")}</strong>
              <p>
                ${t(
                  this.live
                    ? "cron.groups.deliveryPending"
                    : this.entry.deliveryStatus === "delivered"
                      ? "cron.groups.delivered"
                      : this.entry.deliveryStatus === "not-delivered"
                        ? "cron.groups.notDelivered"
                        : this.entry.deliveryStatus === "not-requested"
                          ? "cron.groups.noDelivery"
                          : "cron.groups.deliveryUnknown",
                )}
              </p>
              ${this.entry.deliveryError ? html`<p role="alert">${this.entry.deliveryError}</p>` : nothing}
            </div>`
          : nothing
      }
    </section>`;
  }
}
