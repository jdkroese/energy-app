# Working with multiple agents — worktree-per-agent

> 2026-06-25. How to run several Claude (or human) sessions on this repo at once
> without the stale-tree / "my commit reverted your work" / clobbered-deploy mess.

## The one rule

**One agent = one git worktree = one branch = one PR. Coordinate only through
`origin`, never through the shared filesystem.**

The pain everyone hits comes from two sessions editing the **same checkout**. Their
uncommitted changes interleave on disk; one session's checkout goes stale while the
other pushes; a naive "commit everything" then reverts the other's work; and a deploy
from the stale tree clobbers what's live. Isolating each session into its own worktree
removes the shared-filesystem coupling entirely — git becomes the only thing they share.

## Start a session (the easy way)

```bash
scripts/new-worktree.sh <name>      # e.g. scripts/new-worktree.sh livechart
```

This creates `../energy-app-<name>` on a fresh branch off the **latest** `origin/main`,
installs deps, and prints the next steps. Then:

```bash
cd ../energy-app-<name>
claude            # this session is now isolated
```

Do it again in another terminal for a second agent. They cannot touch each other's files.

## The loop

1. **Branch off the latest origin/main** (the helper does this; or `git worktree add -b <name> ../energy-app-<name> origin/main`).
2. **Work, commit small and often.** Keep the worktree's tree clean between tasks.
3. **Push your branch:** `git push -u origin <name>`.
4. **Open a PR and merge** (or fast-forward `main` if you own the change). Merging to
   `main` is what triggers the deploy — see below.
5. **Before pushing again after time has passed:** `git fetch && git rebase origin/main`
   so you land cleanly on others' work instead of diverging.

## Deploys

- **CI deploys on push to `main`** (`.github/workflows/deploy.yml` → self-hosted runner
  on the mini). Nobody should `ssh`/`scp` a build to the mini by hand.
- **Only `main` deploys.** Feature branches never deploy, so push them freely.
- **Doc / script / CI-only changes don't deploy** — `deploy.yml` has a `paths-ignore`
  for `**/*.md`, `docs/**`, `scripts/**`, `.github/**`, `.gitignore`. (A commit that also
  touches app code still deploys.)
- **Every real deploy restarts the API, which boots control DISARMED** (battery + devices,
  by design). After a deploy that you care about, **re-arm** battery L2 Auto (and arm
  Devices for AC/Airzone automation). See [[energy-app-control]] / [[energy-app-mac-mini]].

## Guardrails already in place

- **Deploy-guard hook:** blocks `git push` / SSH-to-the-mini when your **current checkout
  is behind `origin/main`** ("Local is N commits behind origin/main…"). This is a feature —
  it stops stale deploys from clobbering newer work. If you hit it, you're on a stale tree:
  `git fetch && git rebase origin/main` (or work from a fresh worktree).
- **`.claude/worktrees/` is git-ignored** so in-repo worktrees don't show up as noise.
  Prefer **sibling** worktrees (`../energy-app-<name>`, what the helper makes) over in-repo
  ones anyway.

## Keeping the main checkout sane

Treat the original clone (`E:\Claude\Energy_app`) as a **reference / launch pad**, not a
place to do parallel work. Keep it clean and current:

```bash
git fetch origin
git status                 # confirm nothing here is unsaved-and-unpushed
git merge --ff-only origin/main
```

If it's ever a stale mess again, back up anything unique first (`git stash` for tracked
changes; copy untracked files aside), then `git merge --ff-only origin/main`.

## When to use subagents instead of separate sessions

If the parallel work is part of **one** task (fan-out research, several independent edits
you want merged into one coherent result), let a single Claude session **spawn subagents**
rather than you opening N terminals — it keeps one plan and one reviewer. Give writing
subagents their own worktree isolation so they don't collide. Use separate top-level
sessions only when you genuinely want independent threads of control.

## Always work with task numbers

Every unit of orchestrated work gets a **task number** so progress is measurable and
nothing silently drops. The orchestrating session keeps a numbered task list — one entry
per brief, bugfix, feature, or refinement — marks each `in_progress` when an agent picks it
up and `completed` when its PR is open and verified, and refers to work by its number in
updates ("#3 in review", "#5 blocked on #4"). Briefs handed to subagents and the PRs they
open should carry the task number. The rule of thumb: **no number → not tracked → it doesn't
count as progress.**

## Minimize approvals — bias to autonomy

Inside an **already-agreed** process, agents run to completion without pausing for
step-by-step approval. Once a brief/design is signed off, the agent creates its worktree,
implements, typechecks/builds, verifies, pushes, and opens a PR **without checking in at
each step** — the PR is the review gate, not the intermediate steps. Remove permission
friction up front (scoped `settings.local.json` allows; sibling worktree paths in
`additionalDirectories`) so background agents don't stall on prompts.

The only thing that should interrupt an agent mid-process is a **genuine clarification
question** — an ambiguity it cannot resolve from the brief, the code, or sensible defaults.
Reserve human approval for: the initial brief/design sign-off, anything irreversible or
outward-facing (**merging to `main`, deploys, disarming**), and those clarification
questions. Everything else, the agent just does.
