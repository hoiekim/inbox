/**
 * Single source for the `mails.search_vector` tokenization.
 *
 * Two sites must produce byte-identical tsvectors: the BEFORE INSERT /
 * BEFORE UPDATE trigger function, and the boot reindex that repairs
 * existing rows. Because the UPDATE trigger is scoped with `UPDATE OF
 * <content columns>`, a direct `UPDATE mails SET search_vector = …` is NOT
 * overridden by the trigger — the reindex's expression is authoritative for
 * the rows it touches. Deriving both from `searchVectorExpression` is what
 * keeps "authoritative" and "what the trigger would have written" the same
 * value.
 */

/**
 * Columns the tokenization reads, and therefore the `UPDATE OF` list.
 * Postgres fires an `UPDATE OF` trigger whenever a listed column appears in
 * the SET list — regardless of whether the value actually changes — so a
 * content column cannot be written without a retokenization.
 */
export const SEARCH_VECTOR_COLUMNS = [
  "subject",
  "text",
  "from_text",
  "to_text",
] as const;

export const searchVectorExpression = (prefix: "" | "NEW."): string =>
  `to_tsvector('english',
        coalesce(replace(replace(${prefix}subject,   '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(${prefix}text, '') || ' ' ||
        coalesce(replace(replace(${prefix}from_text, '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(replace(replace(${prefix}to_text,   '<', ' '), '>', ' '), '')
      )`;

export const searchVectorDdl = (): string[] => [
  `CREATE OR REPLACE FUNCTION mails_search_vector_trigger() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := ${searchVectorExpression("NEW.")};
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS mails_search_update ON mails`,
  `DROP TRIGGER IF EXISTS mails_search_insert ON mails`,
  `CREATE TRIGGER mails_search_insert
        BEFORE INSERT ON mails
        FOR EACH ROW EXECUTE FUNCTION mails_search_vector_trigger()`,
  `CREATE TRIGGER mails_search_update
        BEFORE UPDATE OF ${SEARCH_VECTOR_COLUMNS.join(", ")} ON mails
        FOR EACH ROW EXECUTE FUNCTION mails_search_vector_trigger()`,
];

/**
 * Reindex rows whose stored vector disagrees with the current expression —
 * a no-op once every row is up to date, so it is safe on every boot.
 */
export const searchVectorReindexSql = (): string => `
      UPDATE mails
      SET search_vector = ${searchVectorExpression("")}
      WHERE search_vector IS DISTINCT FROM ${searchVectorExpression("")}
    `;
