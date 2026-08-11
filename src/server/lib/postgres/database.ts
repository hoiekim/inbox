/**
 * Generic database query helpers for PostgreSQL.
 */

import { Pool, QueryResult, QueryResultRow } from "pg";
import { Schema, Constraints } from "./models/base";

export const SOFT_DELETE_CONDITION = "(is_deleted IS NULL OR is_deleted = FALSE)";

export type ParamValue = string | number | boolean | Date | null | undefined | string[];

export type QueryData = Record<string, ParamValue | unknown>;

export interface PreparedQuery {
  sql: string;
  values: ParamValue[];
}

export interface WhereOptions {
  conditions?: string[];
  startIndex?: number;
  excludeDeleted?: boolean;
}

/**
 * Set `stampUpdated: false` for a table whose DDL declares no `updated` column —
 * Postgres rejects the whole statement otherwise. `Table` derives it from its own
 * schema; the default `true` keeps the SQL of callers that predate the option.
 */
export interface StampUpdatedOption {
  stampUpdated?: boolean;
}

export interface UpdateOptions extends StampUpdatedOption {
  additionalWhere?: { column: string; value: ParamValue };
  returning?: string[];
}

export interface UpsertOptions extends StampUpdatedOption {
  /** Columns to carry onto the conflict path; those the INSERT omitted are dropped. */
  updateColumns?: string[];
  returning?: string[];
}

export interface SoftDeleteOptions extends StampUpdatedOption {
  additionalWhere?: { column: string; value: ParamValue };
}

// Type guards
const isNull = (v: unknown): v is null => v === null;
const isUndefined = (v: unknown): v is undefined => v === undefined;
const isDate = (v: unknown): v is Date => v instanceof Date;
const _isNumber = (v: unknown): v is number => typeof v === "number";
const _isString = (v: unknown): v is string => typeof v === "string";

export function buildCreateTable(
  tableName: string,
  schema: Schema,
  constraints: Constraints = []
): string {
  const columnDefs = Object.entries(schema).map(
    ([column, definition]) => `${column} ${definition}`
  );

  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      ${[...columnDefs, ...constraints].join(",\n      ")}
    )
  `.trim();
}

export interface CreateIndexOptions {
  indexName?: string;
  using?: string;
  opclass?: string;
  /**
   * Emit `CREATE INDEX CONCURRENTLY`, which builds without taking a write
   * lock on the table. The trade-offs — cannot run inside a transaction, and
   * a failed build leaves an invalid index behind that has to be dropped
   * before the next attempt — are handled by `indexes.ts`.
   */
  concurrently?: boolean;
}

/**
 * The name `buildCreateIndex` embeds. Exposed separately because the
 * invalid-leftover sweep in `indexes.ts` has to name the same index the
 * create statement would.
 */
export function buildIndexName(
  tableName: string,
  column: string,
  options: Pick<CreateIndexOptions, "indexName" | "using"> = {}
): string {
  const { indexName, using } = options;
  // Non-btree indexes take a method suffix so they can't collide with the
  // btree name for the same column — `CREATE INDEX IF NOT EXISTS` would
  // silently no-op the second one, reverting the optimization with no error.
  const suffix = using ? `_${using}` : "";
  return indexName || `idx_${tableName}_${column}${suffix}`;
}

export function buildCreateIndex(
  tableName: string,
  column: string,
  options: CreateIndexOptions = {}
): string {
  const { using, opclass, concurrently } = options;
  const name = buildIndexName(tableName, column, options);
  const target = opclass ? `${column} ${opclass}` : column;
  const method = using ? ` USING ${using}` : "";
  const modifier = concurrently ? " CONCURRENTLY" : "";
  return `CREATE INDEX${modifier} IF NOT EXISTS ${name} ON ${tableName}${method} (${target})`;
}

export function prepareParamValue(value: ParamValue): ParamValue {
  if (isDate(value)) return value.toISOString();
  return value;
}

export function prepareQuery(
  data: QueryData,
  options: WhereOptions = {}
): PreparedQuery {
  const {
    conditions: additionalConditions = [],
    startIndex = 1,
    excludeDeleted = true,
  } = options;

  const conditions: string[] = [...additionalConditions];
  const values: ParamValue[] = [];
  let paramIndex = startIndex;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;

    if (isNull(value)) {
      conditions.push(`${key} IS NULL`);
    } else {
      conditions.push(`${key} = $${paramIndex}`);
      values.push(prepareParamValue(value as ParamValue));
      paramIndex++;
    }
  }

  if (excludeDeleted) {
    conditions.push(SOFT_DELETE_CONDITION);
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { sql, values };
}

const autoColumns = (stampUpdated: boolean) =>
  stampUpdated
    ? { columns: ["updated"], placeholders: ["CURRENT_TIMESTAMP"] }
    : { columns: [] as string[], placeholders: [] as string[] };

export function buildInsert(
  tableName: string,
  data: Record<string, ParamValue>,
  returning?: string[],
  options: StampUpdatedOption = {}
): PreparedQuery {
  const { columns, placeholders } = autoColumns(options.stampUpdated !== false);
  const values: ParamValue[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;
    columns.push(key);
    placeholders.push(`$${paramIndex}`);
    values.push(prepareParamValue(value));
    paramIndex++;
  }

  let sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

  if (returning && returning.length > 0) {
    sql += ` RETURNING ${returning.join(", ")}`;
  }

  return { sql, values };
}

export function buildUpdate(
  tableName: string,
  primaryKey: string,
  primaryKeyValue: ParamValue,
  data: QueryData,
  options: UpdateOptions = {}
): PreparedQuery | null {
  const stampUpdated = options.stampUpdated !== false;
  const setClauses: string[] = stampUpdated ? ["updated = CURRENT_TIMESTAMP"] : [];
  const values: ParamValue[] = [];
  let paramIndex = 1;
  let dataColumns = 0;

  for (const [key, value] of Object.entries(data)) {
    if (key === "raw") continue;
    if (isUndefined(value)) continue;
    setClauses.push(`${key} = $${paramIndex}`);
    values.push(prepareParamValue(value as ParamValue));
    paramIndex++;
    dataColumns++;
  }

  // Nothing the caller asked to write: a no-op update. Without the count an
  // unstamped table would emit an empty SET list, which is a syntax error.
  if (dataColumns === 0) {
    return null;
  }

  values.push(primaryKeyValue);
  const pkParam = paramIndex;
  paramIndex++;

  let sql = `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${primaryKey} = $${pkParam}`;

  if (options.additionalWhere) {
    values.push(options.additionalWhere.value);
    sql += ` AND ${options.additionalWhere.column} = $${paramIndex}`;
    paramIndex++;
  }

  if (options.returning && options.returning.length > 0) {
    sql += ` RETURNING ${options.returning.join(", ")}`;
  }

  return { sql, values };
}

export function buildUpsert(
  tableName: string,
  primaryKey: string,
  data: QueryData,
  options: UpsertOptions = {}
): PreparedQuery {
  const { updateColumns = [], returning = [primaryKey], stampUpdated = true } = options;

  const { columns, placeholders } = autoColumns(stampUpdated);
  const values: ParamValue[] = [];
  const insertedColumns = new Set<string>();
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;
    columns.push(key);
    insertedColumns.add(key);
    placeholders.push(`$${paramIndex}`);
    values.push(prepareParamValue(value as ParamValue));
    paramIndex++;
  }

  let sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

  if (updateColumns.length > 0) {
    // `EXCLUDED.col` for a column the INSERT omitted is that column's DEFAULT,
    // so assigning it overwrites the stored value with that default — NULL where
    // none is declared, otherwise a silent reset to the default. Only columns
    // this statement actually wrote can be carried onto the conflict path.
    const updateClauses = updateColumns
      .filter((col) => col !== primaryKey && insertedColumns.has(col))
      .map((col) => `${col} = EXCLUDED.${col}`);
    if (stampUpdated) updateClauses.push("updated = CURRENT_TIMESTAMP");
    // Every requested column was the conflict key or absent from the INSERT,
    // and there is no `updated` to stamp, so nothing is left to write. An empty
    // SET list is a syntax error; re-assigning the conflict key is the no-op
    // that keeps `DO UPDATE` — and therefore `RETURNING` — so the caller still
    // gets the conflicting row.
    if (updateClauses.length === 0) {
      updateClauses.push(`${primaryKey} = EXCLUDED.${primaryKey}`);
    }
    sql += ` ON CONFLICT (${primaryKey}) DO UPDATE SET ${updateClauses.join(", ")}`;
  } else {
    sql += ` ON CONFLICT (${primaryKey}) DO NOTHING`;
  }

  if (returning.length > 0) {
    sql += ` RETURNING ${returning.join(", ")}`;
  }

  return { sql, values };
}

export function buildSoftDelete(
  tableName: string,
  primaryKey: string,
  primaryKeyValue: ParamValue,
  options: SoftDeleteOptions = {}
): PreparedQuery {
  const { additionalWhere, stampUpdated = true } = options;
  const setClauses = ["is_deleted = TRUE"];
  if (stampUpdated) setClauses.push("updated = CURRENT_TIMESTAMP");

  const values: ParamValue[] = [primaryKeyValue];
  let sql = `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${primaryKey} = $1`;

  if (additionalWhere) {
    values.push(additionalWhere.value);
    sql += ` AND ${additionalWhere.column} = $${values.length}`;
  }

  sql += ` RETURNING ${primaryKey}`;

  return { sql, values };
}

export interface SearchFilters {
  user_id?: string;
  primaryKey?: { column: string; value: ParamValue };
  filters?: QueryData;
  inFilters?: Record<string, ParamValue[]>;
  dateRange?: {
    column: string;
    start?: string | Date;
    end?: string | Date;
  };
  excludeDeleted?: boolean;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export function buildSelectWithFilters(
  tableName: string,
  columns: string[] | "*",
  options: SearchFilters = {}
): PreparedQuery {
  const {
    user_id,
    primaryKey,
    filters = {},
    inFilters = {},
    dateRange,
    excludeDeleted = true,
    orderBy,
    limit,
    offset,
  } = options;

  const conditions: string[] = [];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  if (user_id) {
    conditions.push(`user_id = $${paramIndex++}`);
    values.push(user_id);
  }

  if (primaryKey) {
    conditions.push(`${primaryKey.column} = $${paramIndex++}`);
    values.push(primaryKey.value);
  }

  for (const [key, value] of Object.entries(filters)) {
    if (isUndefined(value)) continue;
    if (isNull(value)) {
      conditions.push(`${key} IS NULL`);
    } else if (typeof value === "object") {
      // JSONB containment: col @> $n::jsonb
      // Handles both array and object JSONB filters generically.
      conditions.push(`${key} @> $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(value));
    } else {
      conditions.push(`${key} = $${paramIndex++}`);
      values.push(prepareParamValue(value as ParamValue));
    }
  }

  for (const [column, valueArray] of Object.entries(inFilters)) {
    if (!valueArray || valueArray.length === 0) continue;
    const placeholders = valueArray
      .map((_, i) => `$${paramIndex + i}`)
      .join(", ");
    conditions.push(`${column} IN (${placeholders})`);
    values.push(...valueArray);
    paramIndex += valueArray.length;
  }

  if (dateRange) {
    if (dateRange.start) {
      conditions.push(`${dateRange.column} >= $${paramIndex++}`);
      values.push(
        isDate(dateRange.start)
          ? dateRange.start.toISOString()
          : dateRange.start
      );
    }
    if (dateRange.end) {
      conditions.push(`${dateRange.column} <= $${paramIndex++}`);
      values.push(
        isDate(dateRange.end) ? dateRange.end.toISOString() : dateRange.end
      );
    }
  }

  if (excludeDeleted) {
    conditions.push(SOFT_DELETE_CONDITION);
  }

  const columnList = columns === "*" ? "*" : columns.join(", ");
  let sql = `SELECT ${columnList} FROM ${tableName}`;

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  if (limit !== undefined) {
    sql += ` LIMIT $${paramIndex++}`;
    values.push(limit);
  }

  if (offset !== undefined) {
    sql += ` OFFSET $${paramIndex}`;
    values.push(offset);
  }

  return { sql, values };
}

export async function query<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  values?: ParamValue[]
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, values);
}

export async function queryOne<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  values?: ParamValue[]
): Promise<T | null> {
  const result = await pool.query<T>(sql, values);
  return result.rows[0] || null;
}

export interface UpsertResult {
  update: { _id: string };
  status: number;
}

export function successResult(id: string, rowCount: number | null): UpsertResult {
  return {
    update: { _id: id },
    status: rowCount ? 200 : 404,
  };
}

export function errorResult(id: string): UpsertResult {
  return {
    update: { _id: id },
    status: 500,
  };
}

export function noChangeResult(id: string): UpsertResult {
  return {
    update: { _id: id },
    status: 304,
  };
}
