# Issue tracker: Local Markdown

Issues for this repo live as markdown files under `.scratch/`.

## Conventions

- One effort per directory: `.scratch/<feature-slug>/`.
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/NN-<slug>.md`, numbered from `01` in
  dependency order.
- The issue file is the source of truth. There is no combined tickets file.
- Triage state is a `**Status:**` line near the top of each issue file. Use the
  triage strings from `triage-labels.md`; mark finished work `done`.
- Comments append under a `## Comments` heading.
- The canonical specification is `docs/SPECS.md`. Scratch files hold tickets,
  not a second spec.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the referenced issue file. Update its `Status:` line when the status
changes.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`done`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `done`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: done`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
