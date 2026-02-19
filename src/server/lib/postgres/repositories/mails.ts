import crypto from "crypto";
import { pool } from "../client";
import { ParamValue } from "../database";
import {
  MailModel,
  MailJSON,
  mailsTable,
  MAIL_ID,
  USER_ID,
  MESSAGE_ID,
  SENT,
  READ,
  SAVED,
  DATE,
  UID_DOMAIN,
  UID_ACCOUNT,
  TO_ADDRESS,
  FROM_ADDRESS,
} from "../models";

export interface SaveMailInput {
  user_id: string;
  message_id: string;
  subject?: string;
  date?: string;
  html?: string;
  text?: string;
  from_address?: object | null;
  from_text?: string | null;
  to_address?: object | null;
  to_text?: string | null;
  cc_address?: object | null;
  cc_text?: string | null;
  bcc_address?: object | null;
  bcc_text?: string | null;
  reply_to_address?: object | null;
  reply_to_text?: string | null;
  envelope_from?: object | null;
  envelope_to?: object | null;
  attachments?: object | null;
  read?: boolean;
  saved?: boolean;
  sent?: boolean;
  deleted?: boolean;
  draft?: boolean;
  insight?: object | null;
  uid_domain?: number;
  uid_account?: number;
}

export const saveMail = async (
  input: SaveMailInput
): Promise<{ _id: string } | undefined> => {
  try {
    const mail_id = crypto.randomUUID();
    const data: Record<string, ParamValue | object | null> = {
      mail_id,
      user_id: input.user_id,
      message_id: input.message_id,
      subject: input.subject ?? "",
      date: input.date ?? new Date().toISOString(),
      html: input.html ?? "",
      text: input.text ?? "",
      from_address: input.from_address ? JSON.stringify(input.from_address) : null,
      from_text: input.from_text ?? null,
      to_address: input.to_address ? JSON.stringify(input.to_address) : null,
      to_text: input.to_text ?? null,
      cc_address: input.cc_address ? JSON.stringify(input.cc_address) : null,
      cc_text: input.cc_text ?? null,
      bcc_address: input.bcc_address ? JSON.stringify(input.bcc_address) : null,
      bcc_text: input.bcc_text ?? null,
      reply_to_address: input.reply_to_address
        ? JSON.stringify(input.reply_to_address)
        : null,
      reply_to_text: input.reply_to_text ?? null,
      envelope_from: input.envelope_from
        ? JSON.stringify(input.envelope_from)
        : null,
      envelope_to: input.envelope_to ? JSON.stringify(input.envelope_to) : null,
      attachments: input.attachments ? JSON.stringify(input.attachments) : null,
      read: input.read ?? false,
      saved: input.saved ?? false,
      sent: input.sent ?? false,
      deleted: input.deleted ?? false,
      draft: input.draft ?? false,
      insight: input.insight ? JSON.stringify(input.insight) : null,
      uid_domain: input.uid_domain ?? 0,
      uid_account: input.uid_account ?? 0,
    };

    const result = await mailsTable.insert(data as Record<string, ParamValue>, [
      MAIL_ID,
    ]);
    if (result) return { _id: result.mail_id as string };
    return undefined;
  } catch (error) {
    console.error("Failed to save mail:", error);
    return undefined;
  }
};

export const getMailById = async (
  user_id: string,
  mail_id: string
): Promise<MailModel | null> => {
  try {
    return await mailsTable.queryOne({ [MAIL_ID]: mail_id, [USER_ID]: user_id });
  } catch (error) {
    console.error("Failed to get mail by ID:", error);
    return null;
  }
};

export const markMailRead = async (mail_id: string): Promise<boolean> => {
  try {
    const result = await mailsTable.update(mail_id, { [READ]: true });
    return result !== null;
  } catch (error) {
    console.error("Failed to mark mail as read:", error);
    return false;
  }
};

export const markMailSaved = async (
  mail_id: string,
  saved: boolean
): Promise<boolean> => {
  try {
    const result = await mailsTable.update(mail_id, { [SAVED]: saved });
    return result !== null;
  } catch (error) {
    console.error("Failed to mark mail as saved:", error);
    return false;
  }
};

export const deleteMail = async (mail_id: string): Promise<boolean> => {
  try {
    return await mailsTable.hardDelete(mail_id);
  } catch (error) {
    console.error("Failed to delete mail:", error);
    return false;
  }
};

export interface GetMailHeadersOptions {
  sent: boolean;
  new: boolean;
  saved: boolean;
  from?: number;
  size?: number;
}

export const getMailHeaders = async (
  user_id: string,
  address: string,
  options: GetMailHeadersOptions
): Promise<MailModel[]> => {
  try {
    const addressJson = JSON.stringify([{ address }]);
    // For sent mails, check from_address only
    // For received mails, check to_address, cc_address, and bcc_address
    const addressCondition = options.sent
      ? `${FROM_ADDRESS} @> $3::jsonb`
      : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
    let sql = `
      SELECT * FROM mails 
      WHERE user_id = $1 
        AND sent = $2
        AND ${addressCondition}
    `;
    const values: ParamValue[] = [user_id, options.sent, addressJson];
    let paramIdx = 4;

    if (options.new) {
      sql += ` AND read = FALSE`;
    } else if (options.saved) {
      sql += ` AND saved = TRUE`;
    }

    sql += ` ORDER BY date DESC`;

    if (options.size !== undefined) {
      sql += ` LIMIT $${paramIdx++}`;
      values.push(options.size);
    }

    if (options.from !== undefined) {
      sql += ` OFFSET $${paramIdx}`;
      values.push(options.from);
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: unknown) => new MailModel(row));
  } catch (error) {
    console.error("Failed to get mail headers:", error);
    return [];
  }
};

export interface SearchMailModel extends MailModel {
  highlight?: {
    subject?: string[];
    text?: string[];
  };
  rank?: number;
}

export const searchMails = async (
  user_id: string,
  searchTerm: string,
  field?: string
): Promise<SearchMailModel[]> => {
  try {
    // Use PostgreSQL full-text search with ranking and highlights
    const sql = `
      SELECT 
        *,
        ts_rank(search_vector, plainto_tsquery('english', $2)) as rank,
        ts_headline('english', subject, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as subject_highlight,
        ts_headline('english', text, plainto_tsquery('english', $2), 
          'StartSel=<em>, StopSel=</em>, MaxWords=50, MinWords=10') as text_highlight
      FROM mails 
      WHERE user_id = $1 
        AND search_vector @@ plainto_tsquery('english', $2)
      ORDER BY rank DESC, date DESC
      LIMIT 1000
    `;

    const result = await pool.query(sql, [user_id, searchTerm]);
    return result.rows.map((row: any) => {
      const model = new MailModel(row) as SearchMailModel;
      model.rank = row.rank;
      model.highlight = {};
      if (row.subject_highlight && row.subject_highlight.includes("<em>")) {
        model.highlight.subject = [row.subject_highlight];
      }
      if (row.text_highlight && row.text_highlight.includes("<em>")) {
        model.highlight.text = [row.text_highlight];
      }
      return model;
    });
  } catch (error) {
    console.error("Failed to search mails:", error);
    return [];
  }
};

export const getDomainUidNext = async (
  user_id: string,
  sent: boolean = false
): Promise<number> => {
  try {
    const sql = `
      SELECT COUNT(*) as count FROM mails 
      WHERE user_id = $1 AND sent = $2
    `;
    const result = await pool.query(sql, [user_id, sent]);
    return parseInt(result.rows[0]?.count || "0", 10) + 1;
  } catch (error) {
    console.error("Error getting next UID:", error);
    return 1;
  }
};

export const getAccountUidNext = async (
  user_id: string,
  account: string,
  sent: boolean = false
): Promise<number> => {
  try {
    const addressJson = JSON.stringify([{ address: account }]);
    // For sent mails, check from_address only
    // For received mails, check to_address, cc_address, and bcc_address
    const addressCondition = sent
      ? `${FROM_ADDRESS} @> $2::jsonb`
      : `(${TO_ADDRESS} @> $2::jsonb OR cc_address @> $2::jsonb OR bcc_address @> $2::jsonb)`;
    const sql = `
      SELECT COUNT(*) as count FROM mails 
      WHERE user_id = $1 
        AND ${addressCondition}
        AND sent = $3
    `;
    const result = await pool.query(sql, [user_id, addressJson, sent]);
    return parseInt(result.rows[0]?.count || "0", 10) + 1;
  } catch (error) {
    console.error("Error getting account UID next:", error);
    return 1;
  }
};

export const getAccountStats = async (
  user_id: string,
  sent: boolean,
  domainFilter?: string
): Promise<
  {
    address: string;
    count: number;
    unread: number;
    saved: number;
    latest: Date;
  }[]
> => {
  try {
    // For sent mails, only look at from_address
    // For received mails, look at to_address, cc_address, and bcc_address
    const addressExpansion = sent
      ? `jsonb_array_elements(from_address)->>'address' as address`
      : `jsonb_array_elements(
          COALESCE(to_address, '[]'::jsonb) || 
          COALESCE(cc_address, '[]'::jsonb) || 
          COALESCE(bcc_address, '[]'::jsonb)
        )->>'address' as address`;

    const addressNotNull = sent
      ? `from_address IS NOT NULL`
      : `(to_address IS NOT NULL OR cc_address IS NOT NULL OR bcc_address IS NOT NULL)`;

    const domainCondition = domainFilter
      ? `AND address ILIKE '%@' || $3`
      : "";

    const sql = `
      WITH expanded_mails AS (
        SELECT 
          mail_id, read, saved, date,
          ${addressExpansion}
        FROM mails 
        WHERE user_id = $1 AND sent = $2 
          AND ${addressNotNull}
      )
      SELECT 
        address,
        COUNT(*) as count,
        SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN saved = TRUE THEN 1 ELSE 0 END) as saved_count,
        MAX(date) as latest
      FROM expanded_mails
      WHERE address IS NOT NULL
      ${domainCondition}
      GROUP BY address
      ORDER BY latest DESC
    `;
    const values: ParamValue[] = domainFilter
      ? [user_id, sent, domainFilter]
      : [user_id, sent];
    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => ({
      address: row.address as string,
      count: parseInt(row.count as string, 10),
      unread: parseInt(row.unread as string, 10),
      saved: parseInt(row.saved_count as string, 10),
      latest: new Date(row.latest as string),
    }));
  } catch (error) {
    console.error("Failed to get account stats:", error);
    return [];
  }
};

export const countMessages = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<{ total: number; unread: number }> => {
  try {
    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      // Domain-wide count
      sql = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread
        FROM mails 
        WHERE user_id = $1 AND sent = $2
      `;
      values = [user_id, sent];
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      sql = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN read = FALSE THEN 1 ELSE 0 END) as unread
        FROM mails 
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
      `;
      values = [user_id, sent, addressJson];
    }

    const result = await pool.query(sql, values);
    return {
      total: parseInt(result.rows[0]?.total || "0", 10),
      unread: parseInt(result.rows[0]?.unread || "0", 10),
    };
  } catch (error) {
    console.error("Failed to count messages:", error);
    return { total: 0, unread: 0 };
  }
};

export const getMailsByRange = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  start: number,
  end: number,
  useUid: boolean,
  fields: string[] = ["*"]
): Promise<Map<string, MailModel>> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    let sql: string;
    let values: ParamValue[];

    const fieldList = fields.includes("*") ? "*" : fields.join(", ");

    if (account === null) {
      // Domain-wide query
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${uidField} >= $3 AND ${uidField} <= $4
          ORDER BY ${uidField} ASC
        `;
        values = [user_id, sent, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2
          ORDER BY ${uidField} ASC
          OFFSET $3 LIMIT $4
        `;
        values = [user_id, sent, start - 1, end - start + 1];
      }
    } else {
      // Account-specific query
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      if (useUid) {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
            AND ${uidField} >= $4 AND ${uidField} <= $5
          ORDER BY ${uidField} ASC
        `;
        values = [user_id, sent, addressJson, start, Math.min(end, 999999999)];
      } else {
        sql = `
          SELECT ${fieldList} FROM mails 
          WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
          ORDER BY ${uidField} ASC
          OFFSET $4 LIMIT $5
        `;
        values = [user_id, sent, addressJson, start - 1, end - start + 1];
      }
    }

    const result = await pool.query(sql, values);
    const mails = new Map<string, MailModel>();
    for (const row of result.rows) {
      mails.set(row.mail_id, new MailModel(row));
    }
    return mails;
  } catch (error) {
    console.error("Failed to get mails by range:", error);
    return new Map();
  }
};

export const setMailFlags = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  start: number,
  end: number,
  flags: string[],
  useUid: boolean
): Promise<boolean> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    const read = flags.includes("\\Seen");
    const saved = flags.includes("\\Flagged");
    const deleted = flags.includes("\\Deleted");
    const draft = flags.includes("\\Draft");

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      if (useUid) {
        sql = `
          UPDATE mails 
          SET read = $1, saved = $2, deleted = $3, draft = $4, updated = CURRENT_TIMESTAMP
          WHERE user_id = $5 AND sent = $6 AND ${uidField} >= $7 AND ${uidField} <= $8
          RETURNING mail_id
        `;
        values = [read, saved, deleted, draft, user_id, sent, start, end];
      } else {
        sql = `
          UPDATE mails 
          SET read = $1, saved = $2, deleted = $3, draft = $4, updated = CURRENT_TIMESTAMP
          WHERE mail_id IN (
            SELECT mail_id FROM mails
            WHERE user_id = $5 AND sent = $6
            ORDER BY ${uidField} ASC
            OFFSET $7 LIMIT 1
          )
          RETURNING mail_id
        `;
        values = [read, saved, deleted, draft, user_id, sent, start];
      }
    } else {
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $7::jsonb`
        : `(${TO_ADDRESS} @> $7::jsonb OR cc_address @> $7::jsonb OR bcc_address @> $7::jsonb)`;
      if (useUid) {
        sql = `
          UPDATE mails 
          SET read = $1, saved = $2, deleted = $3, draft = $4, updated = CURRENT_TIMESTAMP
          WHERE user_id = $5 AND sent = $6 AND ${addressCondition}
            AND ${uidField} >= $8 AND ${uidField} <= $9
          RETURNING mail_id
        `;
        values = [read, saved, deleted, draft, user_id, sent, addressJson, start, end];
      } else {
        sql = `
          UPDATE mails 
          SET read = $1, saved = $2, deleted = $3, draft = $4, updated = CURRENT_TIMESTAMP
          WHERE mail_id IN (
            SELECT mail_id FROM mails
            WHERE user_id = $5 AND sent = $6 AND ${addressCondition}
            ORDER BY ${uidField} ASC
            OFFSET $8 LIMIT 1
          )
          RETURNING mail_id
        `;
        values = [read, saved, deleted, draft, user_id, sent, addressJson, start];
      }
    }

    const result = await pool.query(sql, values);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    console.error("Failed to set mail flags:", error);
    return false;
  }
};

export const searchMailsByUid = async (
  user_id: string,
  account: string | null,
  sent: boolean,
  criteria: { type: string; value?: unknown }[]
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    const conditions: string[] = ["user_id = $1", "sent = $2"];
    const values: ParamValue[] = [user_id, sent];
    let paramIdx = 3;

    if (account !== null) {
      const addressJson = JSON.stringify([{ address: account }]);
      // For sent mails, check from_address only
      // For received mails, check to_address, cc_address, and bcc_address
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $${paramIdx}::jsonb`
        : `(${TO_ADDRESS} @> $${paramIdx}::jsonb OR cc_address @> $${paramIdx}::jsonb OR bcc_address @> $${paramIdx}::jsonb)`;
      conditions.push(addressCondition);
      values.push(addressJson);
      paramIdx++;
    }

    for (const criterion of criteria) {
      const type = criterion.type.toUpperCase();
      switch (type) {
        case "UNSEEN":
          conditions.push("read = FALSE");
          break;
        case "SEEN":
          conditions.push("read = TRUE");
          break;
        case "FLAGGED":
          conditions.push("saved = TRUE");
          break;
        case "UNFLAGGED":
          conditions.push("saved = FALSE");
          break;
        case "SUBJECT":
          conditions.push(`subject ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
        case "FROM":
          conditions.push(`from_text ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
        case "TO":
          conditions.push(`to_text ILIKE $${paramIdx}`);
          values.push(`%${criterion.value}%`);
          paramIdx++;
          break;
      }
    }

    const sql = `
      SELECT ${uidField} as uid FROM mails 
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${uidField} ASC
      LIMIT 10000
    `;

    const result = await pool.query(sql, values);
    return result.rows
      .map((row: Record<string, unknown>) => row.uid as number)
      .filter((uid: number) => uid > 0);
  } catch (error) {
    console.error("Failed to search mails by UID:", error);
    return [];
  }
};

export const getUnreadNotifications = async (
  user_ids: string[]
): Promise<Map<string, { count: number; latest?: Date }>> => {
  try {
    if (user_ids.length === 0) return new Map();

    const placeholders = user_ids.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `
      SELECT 
        user_id,
        COUNT(*) FILTER (WHERE read = FALSE) as unread_count,
        MAX(date) as latest
      FROM mails 
      WHERE user_id IN (${placeholders}) AND sent = FALSE
      GROUP BY user_id
    `;

    const result = await pool.query(sql, user_ids);
    const notifications = new Map<string, { count: number; latest?: Date }>();

    for (const row of result.rows) {
      const count = parseInt(row.unread_count, 10);
      notifications.set(row.user_id, {
        count,
        latest: row.latest ? new Date(row.latest) : undefined,
      });
    }

    return notifications;
  } catch (error) {
    console.error("Failed to get unread notifications:", error);
    return new Map();
  }
};

/**
 * Get all UIDs in a mailbox, ordered by UID ascending.
 * Used to build sequence number → UID mapping for IMAP sessions.
 */
export const getAllUids = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      // Domain-wide query
      sql = `
        SELECT ${uidField} as uid FROM mails 
        WHERE user_id = $1 AND sent = $2
        ORDER BY ${uidField} ASC
      `;
      values = [user_id, sent];
    } else {
      // Account-specific query
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      sql = `
        SELECT ${uidField} as uid FROM mails 
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition}
        ORDER BY ${uidField} ASC
      `;
      values = [user_id, sent, addressJson];
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    console.error("Failed to get all UIDs:", error);
    return [];
  }
};

/**
 * Permanently delete messages marked with \Deleted flag (EXPUNGE operation)
 * Returns the UIDs of deleted messages for EXPUNGE responses
 */
export const expungeDeletedMails = async (
  user_id: string,
  account: string | null,
  sent: boolean
): Promise<number[]> => {
  try {
    const uidField = account === null ? UID_DOMAIN : UID_ACCOUNT;

    let sql: string;
    let values: ParamValue[];

    if (account === null) {
      // Domain-wide expunge
      sql = `
        DELETE FROM mails 
        WHERE user_id = $1 AND sent = $2 AND deleted = TRUE
        RETURNING ${uidField} as uid
      `;
      values = [user_id, sent];
    } else {
      // Account-specific expunge
      const addressJson = JSON.stringify([{ address: account }]);
      const addressCondition = sent
        ? `${FROM_ADDRESS} @> $3::jsonb`
        : `(${TO_ADDRESS} @> $3::jsonb OR cc_address @> $3::jsonb OR bcc_address @> $3::jsonb)`;
      sql = `
        DELETE FROM mails 
        WHERE user_id = $1 AND sent = $2 AND ${addressCondition} AND deleted = TRUE
        RETURNING ${uidField} as uid
      `;
      values = [user_id, sent, addressJson];
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => row.uid as number);
  } catch (error) {
    console.error("Failed to expunge deleted mails:", error);
    return [];
  }
};
