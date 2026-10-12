// Stopping a run from the keyboard (Esc in the interactive session, see
// session.ts). One run is active at a time, so the signal is held here for
// the whole process rather than threaded through every call: the client's
// chat() is wrapped with raceStop() (so any model call, including triage,
// compaction, sub-agents and specialists, ends the moment Esc is pressed),
// runCommand() kills its shell, and the loops check throwIfStopped()
// between steps. The request a stopped call was waiting on is simply
// ignored when it finishes.

export class Stopped extends Error {
  constructor() {
    super("stopped by the user");
    this.name = "Stopped";
  }
}

let current: AbortSignal | undefined;

/** The signal of the run in progress (undefined: nothing can stop it, e.g. one-shot mode). */
export function setRunSignal(signal: AbortSignal | undefined): void {
  current = signal;
}

export function runSignal(): AbortSignal | undefined {
  return current;
}

export function isStopped(e: unknown): boolean {
  return e instanceof Stopped;
}

export function throwIfStopped(): void {
  if (current?.aborted) throw new Stopped();
}

/** `p`, or a Stopped rejection as soon as the run is stopped, whichever comes first. */
export function raceStop<T>(p: Promise<T>): Promise<T> {
  const signal = current;
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {}); // its eventual result no longer matters
    return Promise.reject(new Stopped());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/** Make every chat() on this client stoppable. */
export function stoppableChat<C extends { chat: (req: any) => Promise<any> }>(client: C): C {
  const inner = client.chat.bind(client);
  (client as any).chat = (req: any) => (current?.aborted ? Promise.reject(new Stopped()) : raceStop(inner(req)));
  return client;
}
