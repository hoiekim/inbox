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

/**
 * `subject` / `from_text` / `to_text` are plain text, so angle brackets are
 * blanked before tokenizing — otherwise a subject like `<alert>` tokenizes
 * as an HTML tag and the word is silently dropped. `text` (the HTML body) is
 * passed through untouched, where tag stripping IS the desired behavior.
 *
 * `prefix` is `"NEW."` inside the trigger function and `""` for a bare
 * UPDATE against the table.
 */
export const searchVectorExpression = (prefix: "" | "NEW."): string =>
  `to_tsvector('english',
        coalesce(replace(replace(${prefix}subject,   '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(${prefix}text, '') || ' ' ||
        coalesce(replace(replace(${prefix}from_text, '<', ' '), '>', ' '), '') || ' ' ||
        coalesce(replace(replace(${prefix}to_text,   '<', ' '), '>', ' '), '')
      )`;

/**
 * Idempotent DDL for the trigger function and the INSERT/UPDATE trigger
 * pair, in execution order.
 *
 * The pair is split so the UPDATE side can carry `UPDATE OF <cols>` and skip
 * retokenizing metadata-only writes (`updateRfc822Size` per #731, flag and
 * spam updates). INSERT has no `OF` equivalent and always fires — a new row
 * needs its `search_vector` no matter which columns the INSERT enumerates.
 *
 * The DROPs also retire the older combined `BEFORE INSERT OR UPDATE`
 * definition that used the `mails_search_update` name.
 */
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
