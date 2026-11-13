---
name: autoreview
description: Structured code review through the shared OpenClaw agent-skills installation.
---

# Auto Review

Use the canonical [autoreview skill](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview).
Read the complete installed `~/.agents/skills/autoreview/SKILL.md` and the references
it requires before reviewing. If installed at another operator-selected location,
use that installation. This repository entrypoint contains no review implementation.

If the skill is missing, reuse or clone `https://github.com/openclaw/agent-skills`
and run `python3 scripts/install-skills autoreview` from that checkout. On Windows,
use `python`; `--mode copy` is available when symlinks are unavailable.

Run the shared `scripts/autoreview` helper with Python from the repository being
reviewed, preserving its working directory, only when that helper route is selected.
The root [bounded review policy](../../../AGENTS.md#bounded-review) owns this
repository's reviewer selection and stopping rules, including its direct Copilot
route instead of the shared Codex CLI default.

Keep shared fixes and instructions upstream in `openclaw/agent-skills`. Update
the shared checkout once for all symlinked consumers; reinstall copy-mode skills
after updating their source. Do not add repository-local helpers or test copies.
