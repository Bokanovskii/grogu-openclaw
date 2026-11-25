# Alcove owner news brief

This is an inactive definition. The Alcove automation owner must enforce
owner-only access and delivery before it can enable this brief. Other members
must not see the brief, its inputs, its runs, or its results.

- Schedule: `*/30 * * * *` in `America/Los_Angeles`
- Session target: `isolated`
- Model: `sparky/qwen3.8-flash-next`
- Thinking: use the Sparky catalog default (`medium`) unless the owner selects another level
- Web tools: `web_search` and `web_fetch`; no browser
- Delivery: the owner's Alcove inbox and push only; never text messages
- Required input: owner-supplied financial interests, such as symbols, sectors,
  or topics. The owner can explicitly choose none.

Collect the input when the owner enables the brief. Do not guess it or import
private memory or personal Grogu configuration. The automation owner must
provide owner-scoped topic lookup and updates, prior run or delivery context,
and inbox and push delivery. These definitions do not provide those capabilities
or enable web search.

## Brief

Make a bounded pass over fresh news and financial reporting every run. Use the
owner's supplied financial interests and other preferences explicitly supplied
for this brief. Use category-scoped topic lookup to find relevant existing
topics. Verify useful developments at their original sources. Distinguish
primary facts from interpretation and record source links and uncertainty.
Do not use a calendar, mail, messages, or travel plans.

Update the relevant owner-scoped topic with new evidence and the remaining
question. Offer the owner a supported, useful change through the Alcove inbox
and push. Compare the finding with available prior run or delivery context.
Do not notify again for an unchanged story. If comparison context is
unavailable, record the finding as a baseline without notifying.
Record a quiet outcome when there is no useful change. Report source failures
as failures, not as evidence that nothing changed.
