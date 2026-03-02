export type Action = () => Promise<void> | void;

/**
 * Serializes user-initiated actions so async operations (e.g. directory
 * navigation) block subsequent actions until they complete.  Sync actions
 * pass through immediately when the queue is idle.
 *
 * All user input (keyboard, mouse) should be dispatched through this queue
 * to guarantee ordering.  This is also the hook point for a future macro
 * record / replay system.
 */
class ActionQueue {
  private tail = Promise.resolve();

  enqueue(action: Action): void {
    this.tail = this.tail.then(async () => {
      try {
        const result = action();
        if (result && typeof (result as Promise<void>).then === 'function') {
          await result;
          // Yield after async actions so React can commit state updates
          // before the next queued action reads them via refs.
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      } catch {
        // Action errors must not block the queue
      }
    });
  }
}

export const actionQueue = new ActionQueue();
