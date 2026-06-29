// Serialize async writes that share a backend which can't handle concurrency.
//
// Why this exists: some device backends are single-session and break under
// parallel writes. The Intesis AC Cloud push socket authenticates with ONE shared
// account token and matches no seqNo on its ack — open two sockets at once and the
// second connect_req can drop the first before its set_ack, so a write fails. The
// Airzone underfloor controller is a small embedded webserver that likewise dislikes
// overlapping requests. Flipping several units off in quick succession therefore
// made the second command fail and the optimistic UI toggle snap back; the only
// workaround was to pause a long time between taps.
//
// `serialize(key, task)` runs every task sharing a key strictly one-at-a-time, in
// call order (FIFO). Rapid sequential commands queue cleanly instead of colliding.
// A task that throws does NOT break the chain — the next queued task still runs.

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every earlier `serialize(key, …)` call has settled, so writes
 * sharing `key` never overlap. Returns the task's own promise (resolves/rejects
 * with its result), while the internal chain swallows outcomes so one failure can't
 * poison the queue. Idle keys are dropped so the map doesn't grow unbounded.
 */
export function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Chain after the previous task regardless of whether it resolved or rejected.
  const run = prev.then(task, task);
  // The chain pointer must never reject (else the next .then would skip its task),
  // so link on a result-swallowing tail.
  const link: Promise<unknown> = run.then(() => undefined, () => undefined);
  chains.set(key, link);
  void link.then(() => {
    // Only the tail of an idle queue clears the entry; a newer task will have
    // already replaced the pointer.
    if (chains.get(key) === link) chains.delete(key);
  });
  return run;
}
