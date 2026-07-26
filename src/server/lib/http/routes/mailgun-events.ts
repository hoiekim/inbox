import crypto from "crypto";
import { mailgunEventsTable, MailgunEventModel } from "server";
import { sendAlarm } from "../../alarm";
import { logger } from "../../logger";
import { Route } from "./route";

/**
 * Mailgun events webhook — Mailgun POSTs one event per delivery-lifecycle
 * transition (`accepted`, `delivered`, `failed`, `permanent_fail`,
 * `temporary_fail`, `complained`, `unsubscribed`, `opened`, `clicked`).
 *
 * We insert every event into `mailgun_events` for later correlation
 * with `mails.message_id`, and fire a Discord alarm for
 * `permanent_fail` / `complained` / `failed` — the class that let the
 * Gmail 5.7.1 duplicate-`To:` bug go unnoticed for weeks (see
 * `mailgun.ts`).
 *
 * Signature verification: Mailgun signs each POST with
 * HMAC-SHA256(timestamp + token, MAILGUN_WEBHOOK_SIGNING_KEY). We
 * reject invalid or replayed (>15 min old) events.
 */

const REPLAY_WINDOW_MS = 15 * 60 * 1000;

interface MailgunSignature {
  timestamp: string;
  token: string;
  signature: string;
}

interface MailgunEventData {
  id?: string;
  event?: string;
  timestamp?: number;
  recipient?: string;
  severity?: string;
  reason?: string;
  "delivery-status"?: { message?: string; description?: string; code?: number };
  message?: { headers?: { "message-id"?: string; from?: string; to?: string } };
}

interface MailgunWebhookBody {
  signature?: MailgunSignature;
  "event-data"?: MailgunEventData;
}

const verifySignature = (sig: MailgunSignature | undefined, key: string): boolean => {
  if (!sig?.timestamp || !sig.token || !sig.signature) return false;
  const ageMs = Date.now() - Number(sig.timestamp) * 1000;
  if (!Number.isFinite(ageMs) || ageMs > REPLAY_WINDOW_MS || ageMs < -REPLAY_WINDOW_MS) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", key)
    .update(sig.timestamp + sig.token)
    .digest("hex");
  // Convert to Uint8Array to satisfy timingSafeEqual's ArrayBufferView bound.
  const provided = new Uint8Array(Buffer.from(sig.signature, "hex"));
  const derived = new Uint8Array(Buffer.from(expected, "hex"));
  return provided.length === derived.length && crypto.timingSafeEqual(provided, derived);
};

/**
 * Alarm gate. Mailgun's newer schema collapses `permanent_fail` /
 * `temporary_fail` into `failed` + a `severity` field; keep the legacy
 * event names on the allowlist so both schemas alarm correctly. Bare
 * `failed` with `severity === "temporary"` is greylist / DNS retry /
 * IP-rep throttling — noise for a signal-first webhook, so it's
 * excluded (Mailgun retries those internally without our intervention).
 */
const shouldAlarm = (data: MailgunEventData): boolean => {
  if (data.event === "complained") return true;
  if (data.event === "permanent_fail") return true;
  if (data.event === "failed") return data.severity === "permanent";
  return false;
};

/**
 * Convert Mailgun's Unix-seconds timestamp to ISO, falling back to
 * now on missing / non-finite / out-of-range values. `event-data` is
 * NOT covered by Mailgun's HMAC (only `signature.{timestamp, token}`
 * is), so any value here — including `Infinity` or `1e300` — comes
 * from an unauthenticated attacker within the 15-min replay window
 * of a captured signature. `new Date(Infinity * 1000).toISOString()`
 * throws `RangeError: Invalid time value`, which would bubble past
 * the DB try/catch and 500 the handler; that would push Mailgun into
 * hours-long retries.
 */
const MAX_TIMESTAMP_SECONDS = 4102444800; // 2100-01-01
const safeOccurredAt = (rawTs: unknown): string => {
  if (
    typeof rawTs === "number" &&
    Number.isFinite(rawTs) &&
    rawTs > 0 &&
    rawTs < MAX_TIMESTAMP_SECONDS
  ) {
    return new Date(rawTs * 1000).toISOString();
  }
  return new Date().toISOString();
};

const extractReason = (data: MailgunEventData): string | null => {
  const ds = data["delivery-status"];
  if (!ds) return null;
  const parts = [
    ds.code != null ? String(ds.code) : null,
    ds.message ?? null,
    ds.description ?? null,
  ].filter((p): p is string => !!p && p.trim().length > 0);
  return parts.length ? parts.join(" · ") : null;
};

export const postMailgunEventsRoute = new Route<undefined>(
  "POST",
  "/mailgun-events",
  async (req) => {
    const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    if (!key) {
      // Fail closed if the server isn't configured for webhooks — we
      // don't want to accept unsigned events, but we shouldn't 500
      // either (Mailgun retries for hours on 5xx). Return HTTP 200
      // with `status: "failed"` in the body — Mailgun's retry policy
      // is HTTP-status driven, so this is delivered-and-dropped.
      return { status: "failed", message: "Webhook not configured" };
    }

    const body = req.body as MailgunWebhookBody;
    if (!verifySignature(body.signature, key)) {
      return { status: "failed", message: "Invalid signature" };
    }

    const data = body["event-data"];
    if (!data?.id || !data.event) {
      return { status: "failed", message: "Malformed event payload" };
    }

    const messageId = data.message?.headers?.["message-id"] ?? null;
    const occurredAt = safeOccurredAt(data.timestamp);
    const recipient = data.recipient ?? null;
    const severity = data.severity ?? null;
    const reason = extractReason(data);

    const model = new MailgunEventModel({
      event_id: data.id,
      event: data.event,
      message_id: messageId,
      recipient,
      severity,
      reason,
      occurred_at: occurredAt,
      received_at: new Date().toISOString(),
      raw: data as unknown as Record<string, unknown>,
    });

    // Mailgun retries the same event_id on our 5xx, so a duplicate
    // primary-key on a retry is the expected no-op path. `upsert` with
    // an empty updateColumns array = `ON CONFLICT (event_id) DO
    // NOTHING`.
    try {
      await mailgunEventsTable.upsert(
        model.toJSON() as unknown as Record<string, unknown>,
        [],
      );
    } catch (err) {
      logger.error("Failed to persist Mailgun event", { event_id: data.id }, err);
      // Return 200 anyway — we've already extracted what we need for
      // alarming, and a 5xx here would trigger unbounded retries for
      // an issue that isn't the sender's fault.
    }

    logger.info("Mailgun event", {
      event: data.event,
      message_id: messageId,
      recipient,
      severity,
    });

    if (shouldAlarm(data)) {
      const detail = [
        `**Event:** ${data.event}`,
        recipient ? `**Recipient:** ${recipient}` : null,
        severity ? `**Severity:** ${severity}` : null,
        reason ? `**Reason:** ${reason}` : null,
        messageId ? `**Message-Id:** ${messageId}` : null,
      ]
        .filter((p): p is string => !!p)
        .join("\n");
      // Cooldown per event type so a spam burst doesn't drown out
      // signal from other event types.
      sendAlarm(`Mailgun: ${data.event}`, detail, `mailgun-${data.event}`).catch(
        () => undefined,
      );
    }

    return { status: "success" };
  },
);
