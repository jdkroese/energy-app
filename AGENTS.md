# Agents — read `CLAUDE.md`

**The working agreement for this repo lives in [`CLAUDE.md`](CLAUDE.md). That file is the
single source of truth. This file exists only to point you at it.**

Different agent harnesses look for different filenames — Claude Code reads `CLAUDE.md`,
Codex and several others read `AGENTS.md`. Without this pointer, an agent whose harness
reads `AGENTS.md` finds nothing, so the standing rules (web **and** mobile every time; one
agent = one worktree = one branch; `main` is the only branch that deploys; never run
Prettier blind) simply don't reach it.

## Do not copy `CLAUDE.md` into here

The obvious fix — duplicating the rules into this file — is the one that fails. It already
happened: a generated copy sat untracked in the repo root and in every worktree, and it had
already drifted from the original on a machine-specific path. Two copies of a standing rule
means one of them is wrong and nobody knows which.

So: if a rule needs to change, change it in `CLAUDE.md`. Leave this file as a pointer.

## The parts that bite hardest

Read `CLAUDE.md` in full before you touch anything. These are the ones that cost real money
or real work when missed:

- **`main` is the only branch that deploys** (CI → a self-hosted runner on the Mac mini).
  Never `ssh`/`scp` a build to the mini by hand; the deploy-guard hook blocks it.
- **One agent = one worktree = one branch.** Coordinate through `origin`, never the
  filesystem, and never commit another session's uncommitted changes.
- **Every design or dev request ships for web AND mobile.** One responsive app; handle both
  the `ctx.desktop` branch and the narrow one, and verify both viewports.
- **Do not run `prettier --write`.** There is no `.prettierrc`, the tree is hand-formatted,
  and a blind run reformats ~75% of files and flips every quote.

Machine-specific paths in `CLAUDE.md` (checkout roots, worktree locations) describe the
owner's Claude Code setup. Map them to wherever your own clone lives rather than editing
them — and, again, rather than forking a second copy of the file.
