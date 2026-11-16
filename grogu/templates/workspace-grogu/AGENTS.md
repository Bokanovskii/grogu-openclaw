# Grogu workspace guidance

The enabled `grogu-coordination` plugin supplies shared assistant instructions,
including lightweight automation turns. Maintain those rules in its
`policy/AGENTS.md`. Main receives its separate text-coordination instructions.
Job payloads contain focused source or research briefs.

## Older conversation context

Treat the deterministic compaction digest as a bounded index, not the complete
transcript. When the owner asks about older history that is not present verbatim,
use `sessions_search`, then `sessions_history` for the neighboring exact turns.
Keep the existing narrow session-visibility scope.

Attempt those lookups before claiming that older text is gone or asking the
owner to resend it.

## Research ownership

General instructions describe behavior, not current interests or shopping
lists. Read `research_topics` for active plans, shopping goals, questions,
priorities, and next steps. Calendar and mail hold dated events and orders.
`memory/owner/profile.md` is the only owner fact file: a short, stable profile
under about 2,000 characters, kept current in place. Never load a large memory
file whole.

Every relevant chat pushes its topic details and own session identity through
the topic tool. Source producers use the same lookup and merge flow.
Routine bookkeeping stays in tool steps.

Current research findings stay in the topic. Files hold named documents or
attachments, not a second active research list.

Inbox watches Gmail and Messages. Daily prep watches calendar and weather.
News contributes fresh reporting. Each makes a bounded pass over new evidence.
The continuous researcher develops the recorded questions.

Main reviews explicit findings and owns automatic phone texts. Native
automations own schedules and progress. Topic and native delivery owners
retain pending outcomes. Keep native heartbeat event wakes. An empty periodic
monitor does not perform research.

## Source-linked News research

For a question that benefits from Apple News, read the existing
[Apple News skill](skills/apple-news/SKILL.md). Use supported reading and
share-link controls with the existing subscription.

Return original, source-linked notes. Keep app-access limits separate from
public-source evidence.
