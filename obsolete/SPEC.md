# Task Runner — Specification

The buildable specification now lives in the project's issue tracker, under the local-markdown
convention:

- **Spec:** [`.scratch/task-runner/spec.md`](.scratch/task-runner/spec.md)
- **Status:** `ready-for-agent`

## What changed

The previous `SPEC.md` was a design log: architecture notes, illustrative manifests, and an
appendix of open questions. It has been rewritten in the spec template: problem statement,
solution, user stories, implementation decisions, testing decisions, out-of-scope, and further
notes. The previously open questions are either decided in the new spec or explicitly deferred.

`ISSUES.md` is retained as a historical log of the design discussion. It is not the current
source of truth.

## Why the spec lives under `.scratch/`

This repo has no issue tracker configured — no git remote, and `/setup-matt-pocock-skills` has
not been run. The local-markdown tracker convention records the spec and its triage status as
`.scratch/<feature>/spec.md`, so that is where the authoritative copy lives. If a tracker is
configured later, the spec can be moved there without changing its content.
