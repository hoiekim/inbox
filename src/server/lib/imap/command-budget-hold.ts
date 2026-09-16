import { AsyncLocalStorage } from "node:async_hooks";
import { acquireCommandBudget, releaseCommandBudget } from "./command-budget";

export interface CommandBudgetHold {
  held: boolean;
}

/**
 * Bound in `handler.ts` around a budgeted command's full processing, so
 * `yieldCommandBudgetDuring` below knows whether THIS command currently
 * holds a command-budget slot — and so the handler's own release reads
 * the same flag the yield mutates, rather than a second variable that
 * can drift out of step with it.
 */
const holdStore = new AsyncLocalStorage<CommandBudgetHold>();

export const createCommandBudgetHold = (held: boolean): CommandBudgetHold => ({
  held,
});

export const runInCommandBudgetContext = <T>(
  hold: CommandBudgetHold,
  fn: () => T
): T => holdStore.run(hold, fn);

/**
 * Run `wait` — another resource's blocking `acquire()` — with the calling
 * command's command-budget slot given up, reacquiring it before returning.
 *
 * Without this, a slot acquired in `handler.ts` before dispatch stays held
 * for however long the command then queues behind a DIFFERENT resource's
 * own limit (body-budget's fetch-concurrency cap, stream-mutex's per-key
 * dedupe). That nests two independent budgets instead of partitioning
 * them: a burst of exactly the commands this budget exists to bound
 * (concurrent `UID FETCH ... BODY[]`) saturates it entirely with commands
 * that are themselves just queued elsewhere, starving every other command
 * server-wide behind them.
 *
 * The window is the inner wait and nothing more. Widening it to cover the
 * resulting stream's drain would park a finished body mid-literal while
 * the reacquire sits at the back of the command FIFO, once per message —
 * and a wait longer than `SOCKET_TIMEOUT_MS` writes `* BYE` into the
 * middle of a literal the client is still counting down.
 *
 * Callers must only pass a `wait` that actually blocks: the reacquire
 * costs a full queue rotation under saturation, so an uncontended
 * acquire has to take its own fast path instead of coming through here.
 *
 * Lock order is safe to invert here: the reacquire runs while holding the
 * inner resource, but nothing ever waits on that inner resource while
 * holding a command slot — it gives the slot up first — so there is no
 * cycle to deadlock on.
 */
export const yieldCommandBudgetDuring = async (
  wait: () => Promise<void>
): Promise<void> => {
  const hold = holdStore.getStore();
  if (!hold?.held) {
    await wait();
    return;
  }
  releaseCommandBudget();
  hold.held = false;
  try {
    await wait();
  } finally {
    await acquireCommandBudget();
    hold.held = true;
  }
};
