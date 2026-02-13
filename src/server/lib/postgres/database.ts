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

export interface UpdateOptions {
  additionalWhere?: { column: string; value: ParamValue };
  returning?: string[];
}

export interface UpsertOptions {
  updateColumns?: string[];
  returning?: string[];
}

// Type guards
const isNull = (v: unknown): v is null => v === null;
const isUndefined = (v: unknown): v is undefined => v === undefined;
const isDate = (v: unknown): v is Date => v instanceof Date;
const isNumber = (v: unknown): v is number => typeof v === "number";
const isString = (v: unknown): v is string => typeof v === "string";

export function buildCreateTable(
  tableName: string,
  schema: Schema<Record<string, unknown>>,
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

export function buildCreateIndex(
  tableName: string,
  column: string,
  indexName?: string
): string {
  const name = indexName || `idx_${tableName}_${column}`;
  return `CREATE INDEX IF NOT EXISTS ${name} ON ${tableName}(${column})`;
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

export function buildInsert(
  tableName: string,
  data: Record<string, ParamValue>,
  returning?: string[]
): PreparedQuery {
  const columns: string[] = ["updated"];
  const placeholders: string[] = ["CURRENT_TIMESTAMP"];
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
  const setClauses: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (key === "raw") continue;
    if (isUndefined(value)) continue;
    setClauses.push(`${key} = $${paramIndex}`);
    values.push(prepareParamValue(value as ParamValue));
    paramIndex++;
  }

  if (setClauses.length === 1) {
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
  const { updateColumns = [], returning = [primaryKey] } = options;

  const columns: string[] = ["updated"];
  const placeholders: string[] = ["CURRENT_TIMESTAMP"];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;
    columns.push(key);
    placeholders.push(`$${paramIndex}`);
    values.push(prepareParamValue(value as ParamValue));
    paramIndex++;
  }

  let sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

  if (updateColumns.length > 0) {
    const updateClauses = updateColumns
      .filter((col) => col !== primaryKey)
      .map((col) => `${col} = EXCLUDED.${col}`);
    updateClauses.push("updated = CURRENT_TIMESTAMP");
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
  additionalWhere?: { column: string; value: ParamValue }
): PreparedQuery {
  const values: ParamValue[] = [primaryKeyValue];
  let sql = `UPDATE ${tableName} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${primaryKey} = $1`;

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
