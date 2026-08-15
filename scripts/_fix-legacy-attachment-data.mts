// One-off legacy-attachment fixup.
//
// Two 2021-era mails on prod store the raw attachment bytes as an integer
// array inside `attachments[i].content.data` (Buffer.toJSON()'s shape),
// where every other mail stores just a UUID string that names a file on
// disk at `./attachments/<uuid>`. The current runtime path tries to
// `fs.open(getAttachmentFilePath(content.data))` with the int array
// coerced to a string, which produces `./attachments/255,216,255,...`
// and crashes with ENAMETOOLONG. session-utils.ts falls back to a
// missing-attachment notice; IMAP wire framing survives; but the mail's
// original image is unreadable.
//
// Fix: for each attachment where `content.data` is an array, materialise
// the bytes to `./attachments/<uuid>` and rewrite the JSON to the
// UUID-string shape.
//
// Idempotent: attachments already in the UUID-string shape are left
// alone. Safe to re-run.
//
// Run inside the prod inbox container:
//   docker cp fix-legacy-attachment-data.js hoie-inbox-1:/tmp/
//   docker exec -e DRY_RUN=1 hoie-inbox-1 node /tmp/fix-legacy-attachment-data.js
//   # inspect the JSON output; then live:
//   docker exec hoie-inbox-1 node /tmp/fix-legacy-attachment-data.js

import pg from "pg";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const DRY_RUN = process.env.DRY_RUN === "1";
const ATTACHMENT_FOLDER = process.env.ATTACHMENT_FOLDER || "./attachments";

// The two known-broken mails (uid_domain 172 + 173).
const TARGET_MAIL_IDS = [
  "898c53e9-fb58-4e00-8d49-6dbec70955c2",
  "5a0fa9d4-0207-472e-a9ac-744190cf012a",
];

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  user: process.env.POSTGRES_USER || "postgres",
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DATABASE || "inbox",
});

// Collision-free UUID for the file name (mirrors inbox's `getAttachmentId`).
function newAttachmentUuid(): string {
  for (let i = 0; i < 32; i++) {
    const id = crypto.randomUUID();
    if (!fs.existsSync(path.join(ATTACHMENT_FOLDER, id))) return id;
  }
  throw new Error("gave up finding a non-colliding attachment uuid");
}

type AttachmentIn = {
  filename?: string;
  contentType?: string;
  size?: number;
  content?: { data?: unknown; type?: string };
  [k: string]: unknown;
};

async function main() {
  if (!fs.existsSync(ATTACHMENT_FOLDER)) {
    throw new Error(`attachment folder ${ATTACHMENT_FOLDER} missing — running outside the container?`);
  }

  const { rows } = await pool.query(
    `SELECT mail_id, LEFT(subject, 60) AS subject_head, attachments
       FROM mails
       WHERE mail_id = ANY($1::uuid[])`,
    [TARGET_MAIL_IDS]
  );

  const summary: unknown[] = [];

  for (const row of rows) {
    const mailId: string = row.mail_id;
    const subjectHead: string = row.subject_head ?? "";
    const attachmentsIn: AttachmentIn[] = Array.isArray(row.attachments) ? row.attachments : [];

    const perAttachment: unknown[] = [];
    const rewritten: AttachmentIn[] = [];
    let anyChanged = false;

    for (let idx = 0; idx < attachmentsIn.length; idx++) {
      const att = attachmentsIn[idx];
      const data = att.content?.data;

      if (Array.isArray(data)) {
        // Fix: materialise to a file.
        const buf = Buffer.from(data as number[]);
        const uuid = newAttachmentUuid();
        const filePath = path.join(ATTACHMENT_FOLDER, uuid);

        if (DRY_RUN) {
          perAttachment.push({
            idx,
            action: "would_write",
            filename: att.filename ?? null,
            content_type: att.contentType ?? null,
            declared_size: att.size ?? null,
            actual_bytes: buf.byteLength,
            would_write_to: filePath,
            would_replace_content_with: { data: uuid },
          });
        } else {
          fs.writeFileSync(filePath, buf, { flag: "wx" });
          const written = fs.statSync(filePath).size;
          if (written !== buf.byteLength) {
            throw new Error(
              `write size mismatch for ${mailId}[${idx}]: wrote ${written} vs buf.byteLength ${buf.byteLength}`
            );
          }
          perAttachment.push({
            idx,
            action: "wrote",
            filename: att.filename ?? null,
            content_type: att.contentType ?? null,
            declared_size: att.size ?? null,
            actual_bytes: buf.byteLength,
            file_path: filePath,
            uuid,
          });
        }

        // Rewrite the content shape — only the `data` key, no `type`, to
        // match the modern schema (`{"data": "<uuid>"}`).
        rewritten.push({ ...att, content: { data: DRY_RUN ? "<pending-uuid>" : path.basename(filePath) } });
        anyChanged = true;
      } else if (typeof data === "string") {
        perAttachment.push({ idx, action: "already_uuid_string", uuid: data });
        rewritten.push(att);
      } else {
        perAttachment.push({
          idx,
          action: "skipped_unknown_shape",
          data_type: data === null ? "null" : typeof data,
        });
        rewritten.push(att);
      }
    }

    if (anyChanged && !DRY_RUN) {
      await pool.query(`UPDATE mails SET attachments = $1::jsonb WHERE mail_id = $2::uuid`, [
        JSON.stringify(rewritten),
        mailId,
      ]);
    }

    summary.push({
      mail_id: mailId,
      subject_head: subjectHead,
      changed: anyChanged,
      attachments: perAttachment,
    });
  }

  console.log(JSON.stringify({ dry_run: DRY_RUN, results: summary }, null, 2));
}

main()
  .catch((e) => {
    console.error(JSON.stringify({ error: e?.message ?? String(e), stack: e?.stack }));
    process.exit(1);
  })
  .finally(() => pool.end());
