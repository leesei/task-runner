# Domain Docs

This is a single-context repo: one vocabulary and one ADR set at the root.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read the ADRs that touch the area you are about to work in.

If a file is absent, proceed silently. `/domain-modeling` creates it lazily when
a term or decision is actually settled.

## File structure

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-task-lifecycle-ownership.md
│   └── ...
├── docs/SPECS.md
├── docs/DESIGN.md
└── src/
```

There is no `GLOSSARY-MAP.md`; do not introduce one unless the repo becomes
multi-context.

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in `GLOSSARY.md`.
Do not drift to synonyms the glossary avoids. If the concept is missing, note
the gap rather than inventing language.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, surface it explicitly rather than
overriding it silently:

> _Contradicts ADR-0007 ..., but worth reopening because…_
