# ADR-0003: Split documents by audience

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** `docs/agents/doc-layout.md`, `README.md`, `docs/SPECS.md`, `docs/DESIGN.md`, `GLOSSARY.md`

## Context

Task-runner has three kinds of reader: everyone, the operator or developer, and
the agent. They need different things from the documentation. A user needs
commands and examples; an operator or developer needs behaviour, design, and
the reasons behind decisions; an agent needs precise homes and per-repo rules.

The repository already separates those concerns: `README.md` for entry points,
`docs/SPECS.md` for behaviour, `docs/DESIGN.md` for the current design,
`docs/adr/` for decisions, `GLOSSARY.md` for vocabulary, `docs/agents/` for
agent configuration, and `.scratch/` for disposable tickets.

Keeping one large document would mix audiences and lifetimes. It would either
become a user manual that restates the design or a design record full of
operator and agent detail. The layout is also a contract: links, skills, and
tickets point at these paths.

## Decision

Split documents by audience boundary, not by file size.

- `README.md` is for everyone. It covers what the project is, requirements,
  commands, examples, and the documentation index. It does not restate the
  design.
- `docs/SPECS.md` is the canonical behavioural specification for the operator
  and developer.
- `docs/DESIGN.md` holds the current module map, interfaces, seams, data flow,
  and limitations. When a deep dive is needed — for example an execution,
  logging, or persistence walkthrough — it gets its own document under `docs/`,
  and `docs/DESIGN.md` links it rather than repeating it.
- `docs/adr/NNNN-<slug>.md` records a decision that is hard to reverse,
  surprising without context, and the result of a real trade-off. Reference
  material goes in the design document instead.
- `GLOSSARY.md` holds the project's vocabulary; the domain model stays free of
  implementation detail.
- `docs/agents/*.md` holds agent-only configuration: issue tracker, triage
  labels, domain rules, and this layout.
- `.scratch/` holds tickets and temporary work. It is disposable and is never
  a second specification.

`docs/agents/doc-layout.md` is the authoritative map of which file lives where
and who it faces. This ADR records why the split exists. When a new document
home is added, update the map first.

Each fact has one home. Documents link to the owner instead of copying it.

## Consequences

### Positive

- Each document has one audience and one reason to change.
- Behaviour, design, decisions, and vocabulary can evolve without rewriting
  the README.
- ADRs keep stable identifiers and status even when the design moves on.
- Agents get explicit homes and constraints without making the user-facing
  documentation heavier.
- Disposable tickets cannot silently become a competing spec.

### Negative

- More files and more cross-links; a reader must follow the map.
- Moving or renaming a document requires updating links in README, design,
  ADRs, and agent configuration.
- The split only works if authors respect it; a design explanation pasted into
  the README or a decision buried in `docs/DESIGN.md` recreates the problem.

## Alternatives considered

- **One large `docs/DESIGN.md`.** Rejected: it would mix user-facing commands,
  behavioural rules, design rationale, and agent configuration, and every
  audience would have to filter the rest.
- **Make `README.md` the full manual.** Rejected: the README would grow into a
  second spec and drift from `docs/SPECS.md` and `docs/DESIGN.md`.
- **Put ADRs inside `docs/DESIGN.md`.** Rejected: decisions need stable IDs,
  status, and a record of alternatives; the design document describes the
  current shape, not the history.
- **Keep deep dives inside `docs/DESIGN.md`.** Rejected: the design document
  would become a catch-all; a deep dive can be linked when it is long enough to
  deserve its own home.
- **Put tickets and agent rules in the README.** Rejected: users do not need
  them, and agents need configuration that is stable and easy to find.
