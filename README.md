# Threadline

Threadline keeps professional developers and coding agents synchronized on large, long-running projects. Instead of treating conversation history as the project, it persists the project's intent, scoped context, parallel branches, proposed changes, decisions, and recovery points.

This V3 is a working local-first application, not a static mock. It includes a React interface, a Node API, and SQLite persistence.

## What works

- Create and switch between persistent projects.
- Turn a rough objective into a structured intent specification.
- Draft a compact reasoning focus with approaches, evidence, assumptions, open questions, and counterpoints.
- Scan a bounded, secret-filtered, read-only repository snapshot for grounded evidence.
- Keep model interpretations provisional until a user confirms or dismisses them.
- Inspect provenance and turn an unassigned approach into an isolated branch.
- Analyze a branch into reviewable findings using the configured model or a local fallback.
- Record who the work is for, what to avoid, the required format, and what good looks like.
- Fork branches with inherited and branch-only context.
- Keep private and restricted context out of agent context packages.
- Track branch state and review proposed changes.
- Start Codex on a focused branch in an isolated Git worktree.
- Follow a durable agent event stream and pause, resume, or cancel active runs.
- Review changed files, diff statistics, full patches, test output, and blockers without opening a transcript.
- Route completed reviews and failures into a human Attention inbox.
- Partially accept and merge changes into the main branch.
- Create an automatic rollback checkpoint before every merge.
- Restore earlier project state without deleting the recovery point.
- Reveal context, recovery, and activity only when Advanced is opened.

## Run locally

Requirements: Node.js 22.12 or newer. Real agent runs also require an installed and authenticated [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

```bash
npm install
npm run dev
```

Open [http://localhost:4174](http://localhost:4174). Project state is stored in `.threadline/threadline.db`, which is ignored by Git.

### Test the full workflow

1. Select **New project** and enter an absolute path to a local Git repository.
2. Review the automatically scanned repository summary on **Focus**.
3. Select **Draft focus**, confirm useful items, and use **Challenge** to add a counterpoint.
4. Fork an approach or open a branch and select **Run with Codex**.
5. Confirm the isolated-worktree boundary, start a focused task, and follow its event stream. Try **Pause**, **Resume**, or **Cancel run** while it is active.
6. Review the resulting diff, then open **Attention** to resolve the review request.
7. Selectively merge accepted Threadline findings, then try a recovery checkpoint.

To start with an empty workspace:

```bash
THREADLINE_EMPTY=1 npm run dev
```

To exercise the complete supervision flow without invoking Codex, use the built-in demo adapter. It creates a small artifact in the same kind of isolated worktree:

```bash
THREADLINE_AGENT_ADAPTER=demo THREADLINE_EMPTY=1 npm run dev
```

By default, Threadline starts `codex exec` with `workspace-write` sandboxing inside a detached worktree created from the repository's committed `HEAD`. Uncommitted changes in the active checkout are not copied. Server credentials such as model-provider, cloud, and GitHub tokens are removed from the agent process environment. Authenticate the Codex CLI with `codex login`; set `CODEX_AGENT_MODEL` only when you need to override its configured model.

## Optional model provider

Without configuration, Threadline creates structured specs locally. To use an OpenAI-compatible chat-completions endpoint, set these server-side variables:

```bash
LLM_API_URL=https://api.openai.com/v1/chat/completions \
LLM_API_KEY=your-key \
LLM_MODEL=gpt-5.6-sol \
npm run dev
```

Model credentials never reach the browser. When a repository has been scanned, the server may send the bounded snapshot and shared context to the configured endpoint. Secret-like files, private context, dependencies, build output, and Threadline state are excluded.

## Verify

```bash
npm test
```

The test suite covers project and intent persistence, reasoning review and challenges, branch isolation, context inheritance, private-context exclusion, partial acceptance, automatic checkpoints, rollback, API behavior, and core interface contracts. It also produces a production build.

## Architecture

```text
src/                 React workspace and API client
server/index.js      Local web server and Vite middleware
server/app.js        HTTP API routes
server/store.js      SQLite schema and domain operations
server/spec.js       Optional model adapter and local spec fallback
server/agent-runtime.js  Isolated worktrees and the Codex event adapter
tests/               Store, API, and interface contract tests
```

The API supports projects, intent updates, spec and reasoning drafts, reasoning review, branches, scoped context, supervised agent runs, event streams, attention items, checkpoints, restore, and selective merge. The schema remains deliberately local and compact.

## Current boundary

Threadline's repository scanner and branch analyzer remain read-only. A coding agent may edit only its dedicated worktree; Threadline never applies that diff to the active checkout automatically. Applying or committing code remains an explicit human step. Authentication, cloud synchronization, multiplayer collaboration, billing, and autonomous external actions remain out of scope.
