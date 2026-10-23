# Doc Layout

This repo uses the default single-context layout. The rationale for splitting
documents by audience is [ADR-0003](../adr/0003-split-documents-by-audience.md).

| Home | Audience | Holds |
| --- | --- | --- |
| `README.md` | everyone | what the project is, requirements, commands, doc index |
| `GLOSSARY.md` | everyone | the project's vocabulary |
| `docs/SPECS.md` | operator, developer | the behavioural specification |
| `docs/adr/NNNN-<slug>.md` | operator, developer | hard-to-reverse decisions and why |
| `docs/DESIGN.md` | operator, developer | module map, interfaces, seams, data flow, limitations |
| `docs/agents/*.md` | agents | per-repo configuration: issue tracker, triage, domain, this layout |
| `.scratch/` | agents | tickets and temporary work; disposable |

## Specifics

- The canonical spec is `docs/SPECS.md`; scratch feature directories hold
  tickets, not a second spec.
- Tickets live at `.scratch/<feature>/issues/NN-<slug>.md`. Each issue file is
  the source of truth; there is no combined index.
- There are no deep-dive documents yet. `docs/DESIGN.md` links one when it
  exists instead of restating it.
- `docs/DESIGN.md` is filled as code lands; `TBD` marks decisions that are
  agreed but not implemented.
