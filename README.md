# Threadline

Threadline is a desktop-first prototype for managing AI work as a graph of intent, context, branches, agents, artifacts, evidence, decisions, and change sets. Chat remains available, but durable work lives in inspectable workspace objects.

## Run locally

Requirements: Node.js 20+, Python 3, and a modern browser.

```bash
npm install
```

```bash
npm run dev
```

Open [http://localhost:4174](http://localhost:4174).

## Prototype tour

1. Use the `+` in the workspace header to turn a vague request into a structured intent.
2. Choose Learning, Research, or Production mode and approve the inferred assumptions.
3. Compare the Synthesis and Contrarian branches in the center work surface.
4. Open the Context Registry and resolve the 24-hour versus 4-hour conflict.
5. Inspect decision D-004, its evidence, and Sage's operational AI Passport.
6. Review proposed changes and accept only selected items.
7. Merge the accepted results through a named rollback checkpoint.
8. Open Operations to supervise jobs or respond to the expired-source exception.
9. Open Ask Workspace and save its response as a durable Decision, Context item, or Task.

All state is simulated in the browser. Refresh the page to restore the seeded workspace.

## Project structure

- `index.html`: semantic application shell and seeded workspace data
- `styles.css`: layout, visual system, responsive behavior, and component styles
- `app.js`: prototype workflows, dialogs, state transitions, and interactions
- `pretext-layout.js`: resize-aware measurement for editable document content
- `tests/interface.test.js`: zero-dependency interface contract checks

## Verify

```bash
npm test
```

The checks validate JavaScript syntax, required workspace regions, and the key interactive workflow hooks.
