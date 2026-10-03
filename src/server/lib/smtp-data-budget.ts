import { createFifoSemaphore } from "./fifo-semaphore";
import { parseConcurrencyValue } from "./concurrency-env";
import { logger } from "./logger";

/**
 * Two, not one: the slot spans the whole transaction, and the save behind it
 * makes network calls — DNSBL lookups with a 2s timeout each, then push
 * notifications. At capacity 1 a single stalled lookup would hold the only
 * slot and serialize every other inbound message behind it.
 */
const DEFAULT_CONCURRENCY = 2;

/**
 * How long a transaction will wait for a slot before being refused.
 *
 * Under `smtp-server`'s 60s socket timeout, which is what the peer would hit
 * instead: a timeout drops the connection with nothing said, where the refusal
 * below names a transient condition the sending MTA knows to retry.
 */
const WAIT_CEILING_MS = 20 * 1000;

const CAPACITY = parseConcurrencyValue(
  process.env.SMTP_DATA_CONCURRENCY,
  "SMTP_DATA_CONCURRENCY",
  DEFAULT_CONCURRENCY,
  "smtp-data-budget"
);

const semaphore = createFifoSemaphore(CAPACITY);

/**
 * RFC 5321 §3.8 gives 421 to a service that is not available and is closing
 * the channel — the code a sending MTA queues and retries on, rather than
 * bouncing. Permanent codes are wrong here: the message is fine and the host
 * is only momentarily full.
 */
export class DataBudgetUnavailableError extends Error {
  responseCode = 421;

  constructor() {
    super("4.3.2 Error: too many concurrent deliveries, try again later");
  }
}

/**
 * Runs `fn` holding one of {@link smtpDataBudgetCapacity} slots, so the number
 * of messages materializing at once is bounded independently of `maxClients`.
 *
 * Acquire before the DATA stream is read, not after. `smtp-server` writes the
 * stream through a `PassThrough` and stalls its own socket pipe when that
 * stream is not drained, so a transaction waiting here holds one stream buffer
 * rather than a whole decoded message — which is the entire bound. Reading
 * first and gating the save afterwards would leave every byte already resident.
 *
 * The slot is released when the transaction settles rather than when the parse
 * returns, because the decoded attachment buffers stay reachable through the
 * save.
 *
 * @throws DataBudgetUnavailableError when no slot frees up within the wait
 * ceiling. The caller must drain the DATA stream before answering, or
 * `smtp-server` waits for an `end` that a never-read stream cannot emit.
 */
export const withSmtpDataBudget = async <T>(fn: () => Promise<T>): Promise<T> => {
  const waitedMs = await semaphore.acquireWithin(WAIT_CEILING_MS);
  if (waitedMs === null) {
    logger.warn("SMTP: DATA budget exhausted, refusing transaction", {
      capacity: CAPACITY,
      waitCeilingMs: WAIT_CEILING_MS
    });
    throw new DataBudgetUnavailableError();
  }
  try {
    return await fn();
  } finally {
    semaphore.release();
  }
};

export const smtpDataBudgetCapacity = (): number => CAPACITY;

export const smtpDataBudgetInFlight = (): number => semaphore.inFlight();

export const smtpDataBudgetWaitCeilingMs = (): number => WAIT_CEILING_MS;

/** Exposed for tests. */
export const _resetSmtpDataBudget = (): void => semaphore.reset();
