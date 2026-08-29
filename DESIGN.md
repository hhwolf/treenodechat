# Threadline V3 design direction

## Product thesis

Threadline is a persistent operating system for professional, AI-assisted coding projects. It replaces fragile conversation history with shared project state that humans and agents can inspect, branch, compare, merge, and recover.

The first users are senior engineers and technical solo founders doing multi-day work in an existing codebase.

## Magic moment

A developer opens a repository, or returns days later, and immediately sees the objective, governing context, active branches, proposed changes, and next required action. The agent receives the same structured understanding without the developer retelling the project.

Before committing to a branch, Focus shows a small reviewable reasoning brief: plausible approaches, evidence, assumptions, counterpoints, and the next unresolved question. The AI drafts this structure, but interpretive state becomes durable only after human confirmation.

Projects may hold a bounded read-only repository snapshot containing project structure, selected documentation excerpts, and recent commits. Local mode also includes Git working-tree status. This grounds reasoning and branch analysis without exposing secret-like files. Focused coding agents operate separately in detached local Git worktrees or persistent Vercel Sandboxes, with their event stream and resulting diff attached to the corresponding Threadline branch. Users may explicitly accept whole files from completed runs into a persistent Threadline-owned integration branch — a dedicated local worktree, or the same `threadline/…` branch pushed to GitHub for hosted runs. Later runs start from that accepted head, making accepted code part of the project's durable context.

Threadline exposes shared working state, not hidden chain-of-thought: intent, assumptions, context, actions, evidence, decisions, uncertainty, and concise rationale.

## Interaction hierarchy

The default interface contains only:

1. A compact project Focus.
2. Project intent.
3. Human Attention: only completed reviews, blockers, and decisions.
4. The branch tree.
5. The selected branch's current output, agent state, and next action.
6. A compact current-understanding inspector on wide screens.

Context, recovery, and activity are grouped behind Advanced. Review controls appear only when a branch or reasoning item needs review. Threadline uses a graph-shaped model where it helps, but the base interface deliberately avoids a dense canvas.

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
