# Threadline

Threadline is a chat-first workspace for building software with coding agents. You talk to an orchestrator model that deploys isolated agent runs, verifies their output, and integrates accepted code — while the conversation itself is a **tree**: at genuinely open decisions the model proposes labeled directions with reasoning, picking one forks the thread, and unchosen directions stay explorable.

Four tabs, nothing else:

- **Chat** — the main surface. Messages, live agent-run cards (pause/cancel/diff/verify/integrate), model-proposed direction cards, and approval cards for external actions.
- **Tree** — the whole conversation as a navigable map; click any node to reopen that path.
- **Rules** — one home for everything that governs the project: the intent contract, the connected repository, editable rule documents (CLAUDE.md, skills, guidelines) injected into every chat turn and agent prompt with one-click commit-to-repo sync, and the verify command.
- **Ship** — GitHub pull requests (create/merge), Vercel deployments (trigger/rollback), and environment variables, each behind an explicit typed confirmation.

It supports two deliberately compatible runtimes:

| | Hosted on Vercel | Local development |
|---|---|---|
| Repository | GitHub URL | Absolute local path |
| Persistence | Managed Postgres | SQLite |
| Agent isolation | Persistent Vercel Sandbox | Detached Git worktree |
| Access | Shared secret gate | Localhost only |

## What works

- Chat with an orchestrator (OpenAI Responses API) that can start isolated Codex runs, check their status, run verification, and integrate reviewed files — all as model tools with hard budgets.
- Tree-structured conversation: model-proposed directions with reasoning and a recommendation, manual forks from any message, and a Tree tab that maps every branch.
- Ship-class actions (pull requests, merges, deployments, rollbacks, env vars) can only be *proposed* by the model; each renders an approval card and executes solely on your confirmation.
- Rules documents stored per project, injected into chat and agent prompts, and committable to the repository's `threadline/…` branch (GitHub Contents API hosted, integration workspace locally).
- Structured, editable project intent that every turn and run inherits.
- Bounded, secret-filtered repository snapshots grounding the orchestrator and agents.
- Start, pause, resume, cancel, and inspect focused Codex runs with event evidence and diffs.
- One-click verification of completed runs (auto-detected `npm test`, editable) in a resumed or recreated sandbox hosted, or from the parent process locally.
- Accept selected whole files from completed runs onto a project-owned integration branch — pushed to GitHub hosted, in a dedicated worktree locally.

## Deploy on Vercel

The repository is ready for Vercel Functions, managed Postgres, and Vercel Sandbox. In the Vercel project:

1. Add a managed Postgres integration from the Vercel Marketplace and expose its connection string as `DATABASE_URL`.
2. Add `THREADLINE_ACCESS_TOKEN` using a long random value. For example, generate one locally with `openssl rand -base64 32`.
3. Add `OPENAI_API_KEY` and set `OPENAI_MODEL` to `gpt-5.6-sol`.
4. Optionally add a fine-grained `GITHUB_TOKEN`: read-only **Contents** and **Metadata** unlocks private repositories; **Contents: write** additionally enables hosted integration, rules commits, and pull requests. Public read-only use needs no token.
5. Optionally add `VERCEL_TOKEN` to enable the Ship tab's deployment and env-var management, then set each project's Vercel project id in Ship settings.
6. Apply the variables to Production and Preview, then redeploy.

Use [.env.example](.env.example) as the configuration checklist. Agent sandboxes default to a 40-minute timeout; set `THREADLINE_SANDBOX_TIMEOUT` in milliseconds when a different limit is needed. Never commit real credentials.

On first load, Threadline reports incomplete hosted configuration before touching the database. Once configured, enter the `THREADLINE_ACCESS_TOKEN` value in the browser. The access code is retained only in that browser tab.

### Hosted agent boundary

Each run starts from the project GitHub repository in its own persistent Vercel Sandbox. Setup can reach GitHub and npm; before Codex starts, outbound network access is reduced to `api.openai.com`. Only shared Threadline context enters the prompt. The agent is instructed not to push, commit, or change remotes, and the restricted network prevents GitHub access after setup. Threadline stops the sandbox after collecting its reviewable diff.

## Run locally

Requirements: Node.js 22.12 or newer. Real agent runs also require an installed and authenticated Codex CLI.

```bash
npm install
npm run dev
```

Open [http://localhost:4174](http://localhost:4174). State is stored in `.threadline/threadline.db`, which is ignored by Git.

Start with an empty workspace:

```bash
THREADLINE_EMPTY=1 npm run dev
```

Exercise the full supervision flow without invoking Codex:

```bash
THREADLINE_AGENT_ADAPTER=demo THREADLINE_EMPTY=1 npm run dev
```

Local mode starts real agents with `workspace-write` sandboxing inside a detached worktree. The first run starts from committed `HEAD`; after code is accepted, later runs start from the project integration branch's latest commit. Uncommitted changes in the active checkout are not copied. Server credentials are removed from the agent environment. Set `CODEX_AGENT_MODEL` only when you need to override the Codex CLI's configured model.

Completed local runs expose **Integrate selected files**. Threadline recomputes a binary-safe patch from the run's original base and applies the selected whole files with Git's three-way merge onto `threadline/<project>-<id>`. Accepted changes are committed in `.threadline/projects/<project-id>/workspace` with a local Threadline identity. The active checkout's branch, HEAD, index, and dirty files are never changed. Parallel non-conflicting runs can be accepted in either order; conflicts are reported and the dedicated integration workspace is restored to its prior clean commit. Final delivery remains explicit: use the merge command shown after integration when you are ready to bring that branch into your normal checkout.

Hosted runs integrate the same way when `GITHUB_TOKEN` can push. When a hosted run completes, Threadline stores its full binary-safe patch before the sandbox expires. **Integrate selected files** then replays the selected whole files with the same three-way merge inside a short-lived sandbox and pushes the result to `threadline/<project>-<id>` on GitHub — never to the default branch. Conflicts are reported with the affected files and nothing is pushed. Later hosted runs start from the accepted integration commit, and merging into the default branch stays an explicit human action (for example through a pull request).

## Optional model-assisted reasoning

Hosted deployments use the official OpenAI Responses API when `OPENAI_API_KEY` and `OPENAI_MODEL` are present. Local mode also supports it:

```bash
OPENAI_API_KEY=your-key \
OPENAI_MODEL=gpt-5.6-sol \
npm run dev
```

Without model configuration, Threadline creates specs and reasoning briefs using deterministic local fallbacks. For backward compatibility, an OpenAI-compatible Chat Completions endpoint can still be configured with `LLM_API_URL`, `LLM_API_KEY`, and `LLM_MODEL`.

Model credentials never reach the browser. Repository excerpts and shared context may be sent to the configured model; secret-like files, private context, dependencies, build output, and Threadline state are excluded.

## Test the workflow

1. Create a project (name, repository, brief) — one screen, then you land in **Chat**.
2. Describe a task. The orchestrator answers or starts an isolated agent run; the run card streams status live with **Pause**, **Cancel run**, and **Inspect diff**.
3. When a run finishes, use **Continue with the run result**, click **Verify** to run the tests, and **Integrate selected files** to accept reviewed code onto the `threadline/…` branch.
4. Ask an open-ended question — the model proposes 2–3 directions with reasoning; pick one to fork, or **Fork from here** on any message. See every branch in **Tree**.
5. In **Rules**, refine the intent, edit CLAUDE.md or add a skill document, and **Commit to repo** to sync it.
6. In **Ship**, open a pull request from the integration branch, merge it with a typed confirmation, deploy on Vercel, and manage env vars. Model-proposed ship actions appear in chat as approval cards and do nothing until you approve them.

Run the automated checks with:

```bash
npm test
npx vercel build
```

The suite covers local and Postgres domain behavior, context privacy, repository filtering, hosted authentication, Vercel routing, Sandbox configuration, supervised agent evidence, API behavior, and core interface contracts.

## Architecture

```text
src/                         React chat workspace (App shell, chat, tree, rules, ship)
api/[...].js                 Vercel Function entry point and hosted access gate
server/app.js                Runtime-neutral HTTP API routes
server/orchestrator.js       Chat orchestrator: Responses API tool loop over the engine
server/documents.js          Rules formatting and commit-to-repo sync
server/ship.js               GitHub PR/merge and Vercel deploy/rollback/env pipeline
server/store.js              Local SQLite domain store
server/cloud-store.js        Postgres aggregate store with transactional updates
server/repository.js         Local secret-filtered repository scanner
server/github-repository.js  Hosted GitHub API scanner
server/agent-runtime.js      Local worktree/Codex adapter
server/sandbox-runtime.js    Persistent Vercel Sandbox/Codex adapter
server/spec.js               OpenAI Responses adapter and local fallbacks
tests/                       Domain, API, security, runtime, and UI contracts
```

The hosted store keeps each project graph as a versioned JSONB aggregate. Mutations lock one project row inside a transaction, which preserves branch, event, checkpoint, and attention consistency without prematurely introducing a large relational schema.

See [DESIGN.md](DESIGN.md) for the product model, autonomy boundary, interaction hierarchy, and success measures behind this architecture.

## Current boundary

This is a single-workspace product protected by one strong access code, not yet a multi-user account system. Repository scanning and branch analysis are read-only. In local mode, Threadline can commit explicitly selected agent files to a dedicated project integration branch without touching the active checkout, and never pushes or merges that branch into the user's normal branch. In hosted mode with a `GITHUB_TOKEN` that can push, Threadline can integrate explicitly selected files onto the same dedicated `threadline/…` branch on GitHub; it only ever pushes that branch, and merging into the default branch remains an explicit human action. Without a pushable token, hosted runs stay review-only. Billing, team permissions, live collaboration, and autonomous external actions remain out of scope.
