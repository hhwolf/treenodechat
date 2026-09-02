# Threadline V4 design direction

## Product thesis

Threadline is a chat-first workspace for professional, AI-assisted coding projects — a version of the familiar assistant chat with dynamic versioning. The chat is the interface; the project state (intent, rules, runs, accepted code, decisions) is the durable substance underneath it. The conversation is a tree, not a transcript: real decisions fork, and every direction stays inspectable.

The first users are senior engineers and technical solo founders doing multi-day work in an existing codebase.

## Magic moment

A developer opens a project, or returns days later, and the chat plus its tree immediately show the objective, what was tried on each branch, what code was accepted, and the next open decision. Asking an open question yields 2–3 labeled directions with visible reasoning and a recommendation — choosing one forks the thread, and the road not taken remains one click away in the Tree tab.

Work happens through the same chat: the orchestrator model deploys isolated coding agents, checks their evidence, verifies with the project's tests, and integrates reviewed files — narrating each step with links to the real run cards rather than claiming unverified results.

Projects may hold a bounded read-only repository snapshot containing project structure, selected documentation excerpts, and recent commits. Local mode also includes Git working-tree status. This grounds reasoning and branch analysis without exposing secret-like files. Focused coding agents operate separately in detached local Git worktrees or persistent Vercel Sandboxes, with their event stream and resulting diff attached to the corresponding Threadline branch. Users may explicitly accept whole files from completed runs into a persistent Threadline-owned integration branch — a dedicated local worktree, or the same `threadline/…` branch pushed to GitHub for hosted runs. Later runs start from that accepted head, making accepted code part of the project's durable context.

Threadline exposes shared working state, not hidden chain-of-thought: intent, assumptions, context, actions, evidence, decisions, uncertainty, and concise rationale.

## Interaction hierarchy

Exactly four tabs:

1. **Chat** — the default and primary surface: messages, live agent-run cards, direction cards at open decisions, and approval cards for external actions. Fork from any message.
2. **Tree** — the full conversation graph with explored/unexplored direction chips and run badges; clicking a node reopens that path in Chat.
3. **Rules** — one obvious home for everything that governs the project: intent, the connected repository, rule documents (CLAUDE.md, skills, guidelines) with commit-to-repo sync, and the verify command. If a rule exists, it is defined here and injected everywhere.
4. **Ship** — pull requests, deployments, rollbacks, and environment variables, each behind explicit typed confirmation.

There is no dense canvas and no secondary navigation; run detail lives inline on the chat cards that produced it.

## Autonomy boundary

- Shared repository information is available to agents.
- Private and restricted context is excluded from agent packages.
- Reversible local actions may proceed autonomously.
- Agent writes are restricted to a dedicated worktree created from committed `HEAD` locally, or from the project's latest accepted integration commit when one exists. Hosted agents use a dedicated Vercel Sandbox cloned from the configured GitHub repository.
- Runs are explicitly started and may be paused, resumed, or cancelled.
- Agent events and diff evidence persist after the process finishes.
- Accepting local code creates commits only on `threadline/<project>-<id>` inside `.threadline/projects/<project-id>/workspace`. Whole-file selection and three-way application allow parallel non-conflicting work; a conflict restores only that dedicated workspace and returns the run to review.
- Accepting hosted code replays the run's stored binary-safe patch with the same whole-file selection and three-way merge in a short-lived sandbox, then pushes only `threadline/<project>-<id>` to GitHub. It requires a pushable `GITHUB_TOKEN`, is triggered only by the explicit integrate action, and a conflict pushes nothing.
- Threadline never switches, stages, cleans, resets, or commits in the active checkout, never pushes to the user's normal branches, and never merges into the default branch.
- External, private, or irreversible actions require explicit approval.
- Material merges create a recovery checkpoint before changing the main branch.

## Visual system

- Warm neutral canvas and white work surface.
- Dark moss for durable actions and safe state.
- Blue for active work and amber for review attention.
- UI text uses the system sans-serif stack.
- Intent, outputs, and major headings use a system serif stack.
- Borders and spacing create hierarchy; shadows are limited to modal surfaces.
- Status always includes text and shape, never color alone.
- Motion is optional and disabled when reduced motion is requested.

## Success measures

- A developer can resume a project in under one minute without restating context.
- Branch-only context never contaminates sibling work.
- Users can identify what changed and why without reading a transcript.
- Users can merge only accepted changes and recover the prior state.
- Accepted code becomes the base of later runs without manual patch copying.
- The workflow reduces re-explanation, navigation time, and avoidable rework on multi-day coding tasks.
