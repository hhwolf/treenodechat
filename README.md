# Threadline

Threadline keeps developers and coding agents synchronized on large, long-running projects. Instead of treating chat history as the project, it persists intent, scoped context, parallel branches, proposed decisions, agent evidence, attention items, and recovery points.

It supports two deliberately compatible runtimes:

| | Hosted on Vercel | Local development |
|---|---|---|
| Repository | GitHub URL | Absolute local path |
| Persistence | Managed Postgres | SQLite |
| Agent isolation | Persistent Vercel Sandbox | Detached Git worktree |
| Access | Shared secret gate | Localhost only |

## What works

- Create and switch between persistent projects.
- Turn a rough objective into a structured, editable intent.
- Ground reasoning in a bounded, secret-filtered repository snapshot.
- Keep model interpretations provisional until a human confirms or dismisses them.
- Fork parallel branches with inherited and branch-only context.
- Keep private and restricted context out of agent prompts.
- Start, pause, resume, cancel, and inspect focused Codex runs.
- Review event evidence, changed files, diff statistics, patches, and blockers without reading a full transcript.
- Route completed reviews and failures into a human Attention inbox.
- Selectively merge accepted Threadline findings with automatic recovery checkpoints.
- Reveal context, recovery, and activity only when Advanced is opened.

## Deploy on Vercel

The repository is ready for Vercel Functions, managed Postgres, and Vercel Sandbox. In the Vercel project:

1. Add a managed Postgres integration from the Vercel Marketplace and expose its connection string as `DATABASE_URL`.
2. Add `THREADLINE_ACCESS_TOKEN` using a long random value. For example, generate one locally with `openssl rand -base64 32`.
3. Add `OPENAI_API_KEY` and set `OPENAI_MODEL` to `gpt-5.6-sol`.
4. Optionally add a fine-grained `GITHUB_TOKEN` with read-only **Contents** and **Metadata** access for private repositories. Public repositories need no token.
5. Apply the variables to Production and Preview, then redeploy.

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

Local mode starts real agents with `workspace-write` sandboxing inside a detached worktree created from committed `HEAD`. Uncommitted changes in the active checkout are not copied. Server credentials are removed from the agent environment. Set `CODEX_AGENT_MODEL` only when you need to override the Codex CLI's configured model.

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

1. Create a project from a GitHub URL when hosted, or a repository path locally.
2. Review the repository grounding on **Focus**.
3. Draft the reasoning focus, confirm useful items, and add a counterpoint with **Challenge**.
4. Fork an approach or open a branch, then select **Run with Codex**.
5. Follow the event stream and try **Pause**, **Resume**, or **Cancel run**.
6. Inspect the resulting patch and resolve its **Attention** item.
7. Selectively merge accepted Threadline findings, then restore a recovery checkpoint.

Run the automated checks with:

```bash
npm test
npx vercel build
```

The suite covers local and Postgres domain behavior, context privacy, repository filtering, hosted authentication, Vercel routing, Sandbox configuration, supervised agent evidence, API behavior, and core interface contracts.

## Architecture

```text
src/                         React workspace and authenticated API client
api/[...].js                 Vercel Function entry point and hosted access gate
server/app.js                Runtime-neutral HTTP API routes
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

This is a single-workspace product protected by one strong access code, not yet a multi-user account system. Repository scanning and branch analysis are read-only. Agent changes remain isolated and review-only; Threadline never pushes or applies them to a real repository automatically. Billing, team permissions, live collaboration, and autonomous external actions remain out of scope.
