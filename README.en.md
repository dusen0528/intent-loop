# Intent Loop

[한국어](README.md) · English

> A harness that preserves session constraints during long coding tasks

Stores user constraints separately from conversation summaries and restores them after compaction or resume. Blocks work-tool calls observed by the hooks until the model submits a constraint review for the latest user message.

## Background

As models improve, the harnesses built to compensate for earlier limitations need to be reconsidered. Fixed planning stages, prescribed tool sequences, and repetitive verification instructions can unnecessarily restrict a newer model's judgment. When more decisions are left to the model, these mechanisms should be reduced, weighing the value of each remaining feature against its maintenance cost.

Intent Loop takes this approach. Planning, implementation, verification, and iteration remain with the existing agent. It intervenes only to help preserve user constraints during long tasks.

As a turn grows, user requests, tool outputs, and intermediate results accumulate in context. The agent compacts that context to continue working. A compactor generally focuses on preserving the goal and progress needed to resume work—the **WHAT**. The **HOW**, which constrains the way work is done, can be omitted from the summary. [Related research](https://arxiv.org/html/2608.11242v1)

This distinction matters in long-running tasks. Recent implementation details may survive while an early restriction on file changes or a requirement for approval is no longer available to the next model call. The model can keep pursuing the goal while drifting away from the user's conditions.

## Installation

**Node.js 22+ · Python 3.10+ · Linux/macOS · Your host's CLI**

The default installation is a **user-wide plugin**. Install it once from any directory to load it in that user's new projects and sessions. State is stored separately in each working directory at `.intent-review/<session hash>.json`. This does not install the plugin for other users or on other computers.

### npm (recommended)

```sh
# User-wide Codex plugin
npm exec --yes --ignore-scripts --package=@dusen0528/intent-loop@0.2.0 -- intent-loop init --host codex

# User-wide Claude Code plugin
npm exec --yes --ignore-scripts --package=@dusen0528/intent-loop@0.2.0 -- intent-loop init --host claude
```

`--scope user` is the default. The installer stores plugin files in `~/.local/share/intent-loop/0.2.0/`, then installs `intent-loop@intent-loop` through the host's official plugin CLI. Clearing the npm cache does not remove the runtime files. There are no extra dependencies or automatic npm install scripts.

Codex and Claude use `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`, respectively, alongside the shared `hooks/hooks.json` and `skills/`. Separate marketplace files follow each host's format.

In Codex, review and trust the new plugin's hooks once through `/hooks`. Trust is recorded for the plugin, so it does not need to be repeated for every project, but changes to hook definitions require another review. The installer does not write trust hashes or bypass trust checks. Start a new session after installation or an update.

If a host CLI cannot be found, check its installation and PATH first. If a host command fails, completed steps and source files are retained; resolve the error and retry the same command.

### GitHub / Git clone

If you have access to the repository:

```sh
git clone https://github.com/dusen0528/intent-loop.git
node intent-loop/bin/intent-loop.mjs init --host codex
node intent-loop/bin/intent-loop.mjs init --host claude
```

You can also install directly through the host's marketplace CLI.

```sh
codex plugin marketplace add ./intent-loop
codex plugin add intent-loop@intent-loop

claude plugin marketplace add ./intent-loop --scope user
claude plugin install intent-loop@intent-loop --scope user
```

### Install for a specific project (optional)

```sh
intent-loop init --host codex --scope project
intent-loop init --host claude --scope project
```

Project installation registers hooks in `.codex/hooks.json` or `.claude/settings.json`. **Do not use it alongside the user-wide plugin.** Use `remove --scope project` to remove a project installation.

### Uninstall

```sh
intent-loop remove --host codex
intent-loop remove --host claude
```

User-wide removal uses the host's official uninstall command and preserves state files and marketplace sources.

### State and Git exclusions

`.intent-review/` contains user messages and the original constraint text. Add `**/.intent-review/` to each project's `.gitignore` or your existing global Git ignore file. The installer does not change existing Git settings.

State is scoped by the **working directory (cwd) + session ID** supplied by the host. Starting in a different working directory or worktree creates separate state, even within the same repository. Keep the cwd fixed during a session and start a new session for independent work.

## Failure mode

Suppose a user asks:

```text
Remove duplicate rows from the order data.
Do not modify the original file; save the result to a separate file.
```

After several turns of investigation and fixes, the compacted summary might retain only:

```text
Removing duplicate rows from the order data.
Parser error fixed. Data cleanup logic still needs implementation.
```

Modifying the original file at this point could achieve the deduplication goal while violating the preservation requirement. Intent Loop addresses cases where **task continuity survives but constraint continuity breaks**.

## Design

Task state and session constraints follow separate storage paths.

```text
               ┌→ Existing compactor ──────→ Task summary ─────────┐
Conversation ──┤                                                   ├→ Agent
               └→ Main-model constraint review → Constraint registry┘
                                                 Restored after
                                                 compaction/resume
```

| Information | Contents | Handling |
|---|---|---|
| Ephemeral context | Recent work, progress, next steps | Summarized by the existing compactor |
| Durable session state | Prohibitions, approval conditions, information handling, preferences, output format | Stored in the constraint registry and restored |

The constraint registry is kept outside the compactor's summary. User changes and withdrawals are incorporated through the main model's review, retaining only conditions that remain applicable. **NEVER COMPACT** means the compactor should not arbitrarily shorten or omit constraints; it does not mean immutable, permanent memory.

There is no separate extraction model or new execution loop. Hooks handle review submission checks and restoration. The existing model interprets constraints and chooses the next action.

## Side constraints

A side constraint is a condition that must be respected alongside the main task. The paper's five categories translate into agent work as follows. [Categories and definitions](https://arxiv.org/html/2608.11242v1)

| Type | What it constrains | Examples |
|---|---|---|
| **Action** | Permitted actions | No file deletion, no specific API calls, approval before sending email |
| **Information** | Use or disclosure of information | Do not output certain personal information |
| **Process** | Work order and procedure | Verify before changes, confirm before database changes or production deployment |
| **Preference** | Preferred ways of working | Use Python when possible |
| **Output** | Deliverable format | Respond in JSON |

These conditions can remain applicable beyond a single response. Their strength and scope must also be preserved: `Use Python when possible` should not become `Use only Python`.

## Behavior

| Situation | Intent Loop behavior |
|---|---|
| “Do not modify the original” | Records the constraint with the user's original wording |
| “You may modify temporary files” | Updates the existing constraints to reflect the current conditions |
| Conversation compaction or session resume | Restores the same session's constraint registry |
| Work-tool call without review | Rejects the call and requests a review submission |
| Review from a previous turn is submitted | Does not count it as a review of the new message |

## Usage

After installation, include constraints in a normal task request.

```text
Clean up the order data.
Do not modify the original file or add new dependencies.
Do not include customer email addresses in the result.
```

The agent reviews and submits the constraints before working. Later changes are reflected in the same registry.

```text
You may include customer IDs instead of email addresses.
```

The model performs the constraint review; hooks check whether a review has been submitted for the current message. Clarification is requested when an ambiguous condition affects the next action.

## Review gate

A new user message marks the state as requiring review. Work tools become available after the model submits additions, changes, withdrawals, or a no-change review.

```text
New message → Review required → Submit changes or no change → Work allowed
```

- **UserPromptSubmit** — Issues a new review ID and retains unreviewed messages.
- **PreToolUse** — Blocks work calls before review. Questions and the dedicated submission command remain available.
- **SessionStart** — Restores constraints and review state for the same session on resume or compaction.
- **Stop** — Blocks an unreviewed stop once. If the agent re-enters and stops anyway, work tools remain locked.

`init --host codex|claude` installs a user-wide plugin. With an explicit `--scope project`, it registers the same Python hook in `.codex/hooks.json` or `.claude/settings.json`. User-wide installations use `scripts/review_gate.py` in the host's plugin cache; project installations use `.intent-loop/review_gate.py`. Neither depends on the npm cache location. The package's `hooks/hooks.json` is for plugin loading, and `CLAUDE_PLUGIN_ROOT` is a compatibility environment variable also supported by Codex.

New instructions received during the same turn require another review. Only consecutive events with both the same turn ID and the same message body are treated as duplicates.

There is no separate extraction model, database, MCP server, or new work loop. The installer uses only the Node standard library, and the hooks use only the Python standard library.

## Scope and limitations

Hooks handle **the review procedure and restoration**. Interpreting constraints and applying them to actual work remain the model's responsibility. Hooks do not prove that a no-change judgment is correct.

Blocking applies to new tool calls that the host passes to the hooks. It is not a security boundary controlling already-running processes or tools that bypass hooks. Approval policies recorded as constraints do not grant execution permissions.

Session state is stored in the project's `.intent-review/`. It contains user messages and source excerpts, so add it to `.gitignore`. Start a new session for independent work and keep the working directory fixed.

- [Model instructions](skills/intent-loop/SKILL.md)
- [Hook implementation](scripts/review_gate.py)
- [Installer CLI](bin/intent-loop.mjs)

## Research background

[Lost in Compaction](https://arxiv.org/html/2608.11242v1) studies session constraints omitted from task summaries and a separate constraint extraction and preservation architecture. Intent Loop addresses this problem through the main model's review and small hooks. The paper's experimental results are not presented as performance measurements of this project.

Host behavior: [Codex Hooks](https://learn.chatgpt.com/docs/hooks) · [Claude Code Hooks](https://code.claude.com/docs/en/hooks)

## License

A license has not yet been selected. The npm metadata is `UNLICENSED`.
