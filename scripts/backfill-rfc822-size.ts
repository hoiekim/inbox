/**
 * One-off backfill: compute + persist mails.rfc822_size for every row
 * where rfc822_size IS NULL. Run inside the hoie-inbox-1 container so it
 * has access to the attachments volume + the running app's DB pool.
 *
 * Runs the SAME derivation the FETCH RFC822.SIZE handler uses
 * (buildFullMessage → Buffer.byteLength), so backfilled sizes are
 * byte-identical to what BODY[] would emit.
 *
 * IMPORTANT: run this ONLY AFTER hoiekim/inbox#732 is deployed. #732
 * scopes the search_vector trigger to fire only on subject/text/from_text/
 * to_text UPDATEs; without it, every rfc822_size UPDATE also runs
 * `to_tsvector('english', …)` on every row — pointless CPU + write amp.
 *
 * Usage (on the prod host):
 *   docker cp /path/to/backfill-rfc822-size.ts hoie-inbox-1:/tmp/backfill.ts
 *   docker exec hoie-inbox-1 bun /tmp/backfill.ts
 *
 * Idempotent: re-runs skip rows already populated. Safe to interrupt +
 * resume (Ctrl-C at any point, re-run picks up where it left off).
 */
import { pool } from "server/lib/postgres/client";
import { mailsTable } from "server/lib/postgres/models";
import { buildFullMessage } from "server/lib/imap/session-utils";

const BATCH_SIZE = 50;

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`[backfill] starting — BATCH_SIZE=${BATCH_SIZE}`);

  // Total unfilled count for progress.
  const {
    rows: [{ count: totalStr }],
  } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM mails WHERE rfc822_size IS NULL AND expunged = FALSE`
  );
  const total = Number(totalStr);
  console.log(`[backfill] ${total} rows need rfc822_size`);

  if (total === 0) {
    console.log("[backfill] nothing to do");
    process.exit(0);
  }

  let done = 0;
  let errors = 0;

  // Loop by fetching a batch, processing, updating. Keyset by mail_id
  // ordering — new NULL rows (unlikely mid-run) still get picked up on
  // the next batch fetch since we always query fresh IS NULL.
  while (true) {
    const { rows } = await pool.query<{ mail_id: string; user_id: string }>(
      `SELECT mail_id, user_id FROM mails
       WHERE rfc822_size IS NULL AND expunged = FALSE
       ORDER BY mail_id
       LIMIT $1`,
      [BATCH_SIZE]
    );
    if (rows.length === 0) break;

    for (const { mail_id, user_id } of rows) {
      try {
        const mail = await mailsTable.queryOne({ mail_id, user_id });
        if (!mail) {
          console.warn(`[backfill] mail ${mail_id} vanished mid-run — skip`);
          continue;
        }
        // Same derivation as fetch-helpers RFC822.SIZE case.
        const full = buildFullMessage(
          {
            messageId: mail.message_id,
            subject: mail.subject,
            date: mail.date,
            html: mail.html,
            text: mail.text,
            from: mail.from_address
              ? { value: mail.from_address as never, text: mail.from_text ?? "" }
              : undefined,
            to: mail.to_address
              ? { value: mail.to_address as never, text: mail.to_text ?? "" }
              : undefined,
            cc: mail.cc_address
              ? { value: mail.cc_address as never, text: mail.cc_text ?? "" }
              : undefined,
            bcc: mail.bcc_address
              ? { value: mail.bcc_address as never, text: mail.bcc_text ?? "" }
              : undefined,
            replyTo: mail.reply_to_address
              ? {
                  value: mail.reply_to_address as never,
                  text: mail.reply_to_text ?? "",
                }
              : undefined,
            attachments: (mail.attachments as never) ?? [],
          } as never,
          mail_id
        );
        // buildBodyResponsePart appends "\r\n" before caching (see
        // fetch-helpers `getBodyContent` closure); RFC822.SIZE derives
        // from that appended form. Match here so backfilled + lazy-fill
        // values agree.
        const size = Buffer.byteLength(full + "\r\n", "utf8");
        await pool.query(
          `UPDATE mails SET rfc822_size = $1 WHERE mail_id = $2 AND user_id = $3 AND rfc822_size IS NULL`,
          [size, mail_id, user_id]
        );
        done += 1;
      } catch (err) {
        errors += 1;
        console.error(
          `[backfill] mail ${mail_id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      // Periodic progress line.
      if (done % 50 === 0 || done === total) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
          `[backfill] ${done}/${total} (${errors} err) in ${elapsed}s`
        );
      }
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[backfill] done — ${done} written / ${errors} failed / ${elapsed}s total`
  );
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal", err);
  process.exit(1);
});
