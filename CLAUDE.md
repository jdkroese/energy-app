# Energy app — working agreement

## Web AND mobile, always (standing rule)

Every design or development request is delivered for **both web (desktop) and mobile** by
default — never one without the other. Do not ask which platform; do both unless the user
explicitly scopes it to one.

This is a single responsive React app, not separate codebases:

- Layout branches on `ctx.desktop` from `AppShell` — `useMediaQuery('(min-width: 768px)')`.
  Desktop (≥768px) uses the collapsing **Rail**; mobile (<768px) uses the **TabBar**.
- Screens receive `ctx` and read `ctx.desktop` (commonly aliased `const wide = ctx.desktop`).
- So "do it for web and mobile" means: handle **both** the `wide` and the narrow branch —
  layout, spacing, nav, touch targets, and any new component — not just the one you're looking at.

When verifying a UI change, check **both** viewports (e.g. `preview_resize` to a desktop
width ≥768px and a mobile width <768px) before calling it done. Follow the "Power" design
system (dark control-room aesthetic) for both.

## Git & multi-agent rules (standing rule — ALL agents)

Multiple agents/sessions run on this repo at once. To avoid stale trees, clobbered
work, and broken deploys, every session MUST follow these. Detail: `docs/18-multi-agent-workflow.md`.

1. **One agent = one worktree = one branch.** Never run two sessions in the same checkout.
   Start an isolated worktree with `bash scripts/new-worktree.sh <name>` (creates
   `../energy-app-<name>` off the latest `origin/main`). Do NOT do parallel work in the
   primary checkout — treat it as a clean launch pad.
2. **Coordinate only through `origin`, never the filesystem.** Branch off the latest
   `origin/main`; `git fetch && git rebase origin/main` before every push so you land on
   others' work instead of diverging.
3. **Never push a checkout that is behind `origin/main`**, and never `git commit` another
   session's uncommitted changes. If you find a stale/mixed tree, stop and reconcile
   (`git fetch && git rebase origin/main`) — do not commit-the-whole-tree.
4. **`main` is the only branch that deploys** (CI → self-hosted runner on the mini).
   Push feature branches freely; merge to `main` (PR or fast-forward) to ship. **Never**
   `ssh`/`scp` a build to the mini by hand — the deploy-guard hook blocks stale pushes/SSH.
5. **Deploys PRESERVE the armed state** (since 2026-06-26): a restart restores the last
   armed/mode from `state.json`, so an ordinary release no longer disarms — no re-arm needed.
   A release must only disarm **when the owner is asked and confirms**; to ship a
   deliberately-safe boot (e.g. a risky control-logic change) set `ENERGY_BOOT_DISARMED=1`
   on the API for that restart. Doc/CI/script-only changes are `paths-ignore`d in
   `deploy.yml` and do not deploy at all.
6. **Activate the shared git guard once per clone:** `git config core.hooksPath scripts/githooks`
   (the helper-made worktrees inherit it automatically). It blocks force/stale pushes to `main`.

## Formatting — do NOT run Prettier blind (standing rule)

`package.json` ships a `format` script (`prettier --write .`) and Prettier as a devDep, but
there is **no `.prettierrc`**, and the codebase is **hand-formatted and not Prettier-clean**
(single quotes, semicolons, ~120-col hand wrapping). Running `prettier --write .` reformats
**~75% of files** — and on Prettier's defaults it flips every string literal to double quotes.
That produces a massive diff that collides with the many parallel branches and buries real
changes in style churn (this has already bitten an agent mid-task).

- **Do not run `prettier --write` / the `format` script** as part of a feature or fix. Match
  the surrounding style by hand instead.
- Adopting Prettier for real is a **deliberate, standalone, repo-wide reformat** that must be
  coordinated when few branches are open and land with a committed config in the same commit —
  not something to trigger incidentally. Raise it with the owner first.
