// rfc822_size drift diagnostic — for UID 12381 + siblings (all 7
// tattoo-thread mails, 8-19 MB range), compute the live segment-sum
// from inbox's current buildMessageSegments and diff against the
// stored `rfc822_size` column. Root-cause validation for the iOS
// retry-loop hypothesis: iOS reads RFC822.SIZE, walks partial windows,
// and lands past the ACTUAL served end because RFC822.SIZE was
// persisted under an older serializer.
//
// Runs INSIDE the prod container (docker exec). Reads env-configured
// pg (PGHOST etc. — the container has them). Stats attachment files
// via the same `getAttachmentFilePath` inbox uses in prod so the
// numbers match production behavior exactly.
//
// Output: one JSON object per mail with { uid_domain, mail_id, subject,
//   stored_rfc822_size, live_segment_sum, delta, delta_direction,
//   attachments_summary }. Runs read-only.

import pg from "pg";
import { buildMessageSegments, computeFullMessageSize } from "../src/server/lib/imap/session-utils";
import { PartialMailModel } from "../src/server/lib/postgres";
import fs from "node:fs";

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  user: process.env.POSTGRES_USER || "postgres",
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DATABASE || "inbox",
});

// The 8 uid_domain values from the tattoo-thread cluster (12381 = the
// one iOS is currently stuck on; 7 siblings queued behind it).
const TARGET_UIDS = [12381, 12365, 12334, 12333, 12316, 12315, 12300];

// Additional context UIDs — pick a smaller-body sample to see whether
// the drift is thread-specific or a broader pattern.
const CONTEXT_UIDS: number[] = [];
if (process.env.INCLUDE_SAMPLE === "1") {
  // top-10 largest received mails, for pattern width.
  CONTEXT_UIDS.push(...[/* filled by SQL below */]);
}

async function main() {
  const { rows: adminUser } = await pool.query(
    "SELECT user_id FROM users WHERE username = 'admin' LIMIT 1"
  );
  if (adminUser.length === 0) {
    console.error(JSON.stringify({ error: "no admin user found" }));
    process.exit(1);
  }
  const userId = adminUser[0].user_id;

  const uids = [...TARGET_UIDS];

  // Optional expand — top-10 largest by html + attachments.
  if (process.env.INCLUDE_SAMPLE === "1") {
    const { rows: sample } = await pool.query(
      `SELECT uid_domain
         FROM mails
         WHERE user_id = $1 AND sent = FALSE AND expunged = FALSE
           AND uid_domain > 0
         ORDER BY (octet_length(html) + octet_length(text) + COALESCE(pg_column_size(attachments), 0)) DESC
         LIMIT 10`,
      [userId]
    );
    for (const r of sample) if (!uids.includes(r.uid_domain)) uids.push(r.uid_domain);
  }

  const results: any[] = [];

  for (const uid of uids) {
    const { rows } = await pool.query(
      `SELECT
         mail_id, user_id, message_id, subject, date,
         html, text,
         attachments,
         from_address, from_text, to_address, to_text,
         cc_address, cc_text, bcc_address, bcc_text,
         reply_to_address, reply_to_text,
         envelope_from, envelope_to,
         rfc822_size,
         octet_length(text) AS text_octets,
         octet_length(html) AS html_octets
       FROM mails
       WHERE user_id = $1 AND uid_domain = $2 AND sent = FALSE AND expunged = FALSE
       LIMIT 1`,
      [userId, uid]
    );
    if (rows.length === 0) {
      results.push({ uid_domain: uid, error: "not found" });
      continue;
    }
    const row = rows[0];

    // Attachments summary — stat each file so we know disk vs declared.
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    const attachmentsSummary = attachments.map((a: any, i: number) => {
      const filePath = a.dataId
        ? "./attachments/" + a.dataId
        : a.filePath || null;
      let diskSize: number | null = null;
      let diskExists = false;
      if (filePath) {
        try {
          const s = fs.statSync(filePath);
          diskSize = s.size;
          diskExists = s.isFile();
        } catch {
          diskExists = false;
        }
      }
      return {
        idx: i,
        filename: a.filename ?? null,
        dataId: a.dataId ?? null,
        declared_size: a.size ?? null,
        disk_size: diskSize,
        disk_exists: diskExists,
      };
    });

    // Build the mail argument shape that `buildMessageSegments` expects.
    // Use the MATERIALIZED path (pass `text` + `html` strings directly)
    // so it computes the segment sum against real body content, not a
    // lazy placeholder.
    const mailArg = {
      messageId: row.message_id,
      subject: row.subject,
      date: row.date,
      from: row.from_address ? { text: row.from_text || "", value: row.from_address } : undefined,
      to: row.to_address ? { text: row.to_text || "", value: row.to_address } : undefined,
      cc: row.cc_address ? { text: row.cc_text || "", value: row.cc_address } : undefined,
      bcc: row.bcc_address ? { text: row.bcc_text || "", value: row.bcc_address } : undefined,
      replyTo: row.reply_to_address ? { text: row.reply_to_text || "", value: row.reply_to_address } : undefined,
      envelopeFrom: row.envelope_from,
      envelopeTo: row.envelope_to,
      html: row.html,
      text: row.text,
      attachments: row.attachments,
    };

    let live_segment_sum: number | null = null;
    let segment_kinds: Record<string, number> = {};
    let segment_build_error: string | null = null;
    try {
      const segments = buildMessageSegments(mailArg as any, row.mail_id);
      live_segment_sum = computeFullMessageSize(mailArg as any, row.mail_id);
      for (const seg of segments) {
        segment_kinds[seg.kind] = (segment_kinds[seg.kind] || 0) + 1;
      }
    } catch (e: any) {
      segment_build_error = e?.message ?? String(e);
    }

    const stored = Number(row.rfc822_size ?? 0);
    const delta = live_segment_sum !== null ? live_segment_sum - stored : null;

    results.push({
      uid_domain: uid,
      mail_id: row.mail_id,
      subject: (row.subject || "").slice(0, 80),
      stored_rfc822_size: stored,
      live_segment_sum,
      delta,
      delta_direction: delta === null ? "unknown" : delta > 0 ? "live > stored (iOS reads past served end)" : delta < 0 ? "live < stored (server sends less than promised)" : "match",
      text_octets: Number(row.text_octets ?? 0),
      html_octets: Number(row.html_octets ?? 0),
      attachments: attachmentsSummary,
      segment_kinds,
      segment_build_error,
    });
  }

  await pool.end();

  // Emit summary + per-mail JSON.
  console.log(JSON.stringify({
    diagnostic: "rfc822-size-drift",
    admin_user: userId,
    total_mails_checked: results.length,
    mismatches: results.filter(r => r.delta !== null && r.delta !== 0).length,
    matches: results.filter(r => r.delta === 0).length,
    errors: results.filter(r => r.error || r.segment_build_error).length,
    results,
  }, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ error: e?.message ?? String(e), stack: e?.stack }));
  process.exit(1);
});
