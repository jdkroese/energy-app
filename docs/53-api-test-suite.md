# 52 — Running the API test suite (and the import side effect that made it impossible)

## How to run the tests

```bash
pnpm test
```

From the repo root that fans out to every workspace package that has a `test` script — today
that is `apps/api` only. To run just the API suite, or a single file while iterating:

```bash
pnpm --filter @energy/api test
```

```bash
cd apps/api && node --import tsx --test src/control/climate-coordinator.test.ts
```

The runner is **Node's built-in test runner via tsx** — `node --import tsx --test` — not
vitest, not jest. There is no watch mode wired up; `--test --watch` works if you want one.
The full suite is 47 files / 590 tests and finishes in ~4 seconds.

`apps/api/package.json` defines it as:

```
"test": "node --import tsx --test \"src/**/*.test.ts\""
```

The glob is quoted deliberately: Node expands it itself, so the script behaves identically
under `cmd.exe` on Windows and `sh` on the mini (where `**` would otherwise need `globstar`).

## Why there was no `test` script until now

Seven files passed every assertion and then **never exited**, so any attempt at a full-suite
run hung until it was killed:

- `src/alert-loop-recovery.test.ts`
- `src/connectors/tuya-inference.test.ts`
- `src/control/climate-coordinator.test.ts`
- `src/control/solar-history-correction.test.ts`
- `src/monitors-expensive-import.test.ts`
- `src/routes/live-solar-clamp.test.ts`
- `src/routes/live-solar-split.test.ts`

The seven spanned unrelated subsystems (alerts, Tuya, solar, climate, `/api/live`) and none of
them opened anything themselves, which is what made it look systemic. It was: a **single
import side effect**, reached transitively by all seven.

`apps/api/src/connectors/tuya-local.ts` ended with

```ts
reloadRegistry();
if (isLocalEnabled()) startDiscoveryListener();   // <- ran on import
```

`startDiscoveryListener()` binds two receive-only UDP sockets (ports 6666 and 6667) for Tuya
LAN discovery. Because `./tuya`, `./tuya-lights`, `routes/live`, the climate coordinator and
the alert loop all reach `tuya-local` transitively, *importing almost anything* bound those
sockets — including in a `node --test` process, where nothing ever closes them. Two live
handles, event loop never drains, runner hangs. Confirmed by running the same seven files with
`TUYA_LOCAL_ENABLED=0` (the kill switch that made the import-time gate fall through): all
seven exited 0 immediately.

The other 39 test files were unaffected simply because their import graphs never reached
`tuya-local`.

## The fix

Two changes, both in `tuya-local.ts`, plus one line in `index.ts`.

1. **No loops from imports.** The gate moved out of module scope into an exported
   `bootLocalDiscovery()`, which `apps/api/src/index.ts` now calls once at startup alongside
   `startAlertLoop()` / `startCoordinator()` / the other coordinators. Importing the module
   still calls `reloadRegistry()` (a synchronous, failure-tolerant JSON read — no handle), and
   nothing else. Production behaviour is unchanged: the same `isLocalEnabled()` gate, the same
   default-ON store semantics, the same runtime Settings toggle, just reached from the boot
   sequence instead of from the module's top level.

2. **The listener no longer holds the process open.** The discovery sockets are `unref()`d.
   In production the HTTP server keeps the event loop alive, so this changes nothing there; it
   means a short-lived process that *does* start discovery can still exit on its own.

`src/connectors/tuya-local-boot.test.ts` locks this in: with `TUYA_LOCAL_ENABLED=1` (the hard
force-ON override — the worst case for an import side effect), importing `tuya-local` must
leave `isDiscoveryRunning()` false. It asserts on that exported flag rather than on
`process.getActiveResourcesInfo()`, because unref'd handles are invisible to the latter — an
active-handle assertion here would silently never fail.

Verified end to end: booting `apps/api/src/index.ts` with a scratch `DATA_DIR` leaves UDP
6666 and 6667 bound to the API process, exactly as before the change.

## The rule this leaves behind

**A module must not start a timer, a socket, or a loop as an import side effect.** Only an
explicit `startX()` / `bootX()`, called from `index.ts`, may do that. `apps/api/src` has 25+
`setInterval` coordinator loops and every other one already follows this — `tuya-local` was
the lone exception, and it cost the repo its ability to run a full test suite.

If a test file ever hangs again, the first diagnostic is:

```bash
cd apps/api && node --import tsx --test --test-force-exit src/path/to.test.ts
```

If it passes with `--test-force-exit`, it is an open handle, not a stuck assertion. Then find
the handle by bisecting the import graph — importing each suspect module in isolation and
printing `process.getActiveResourcesInfo()` — and fix it at the source. Do **not** adopt
`--test-force-exit` as the convention: it hides exactly this class of bug, and this one was a
real production module opening real sockets in every process that touched it.
