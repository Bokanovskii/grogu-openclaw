# Alcove owner home weather brief

This is an inactive definition. The Alcove automation owner must enforce
owner-only access and delivery before it can enable this brief. Other members
must not see the brief, its inputs, its runs, or its results.

- Schedule: `35 * * * *` in `America/Los_Angeles`
- Session target: `isolated`
- Model: `sparky/qwen3.8-flash-next`
- Thinking: `ultra`
- Web tools: `web_search` and `web_fetch`; no browser
- Delivery: the owner's Alcove inbox and push only; never text messages
- Required input: the home location supplied by the owner

Collect the home location when the owner enables the brief. Do not guess it or
import private memory or personal Grogu configuration. The automation owner
must provide prior run or delivery context and inbox and push delivery. These
definitions do not provide those capabilities or enable web search.

## Brief

Read the current forecast for the supplied home location. Include the source,
forecast time, and uncertainty. Identify material changes that are useful to
the owner. Do not use a calendar, mail, messages, or travel plans.

Compare the forecast with available prior run or delivery context. Offer a
useful change through the owner's Alcove inbox and push. Do not notify again
for an unchanged forecast. If comparison context is unavailable, do not claim
that a forecast changed. Record it as a baseline without notifying. Record a
quiet outcome when there is no useful change. Report source failures as
failures, not as evidence that the forecast is unchanged.
