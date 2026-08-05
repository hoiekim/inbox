import { pool } from "../client";
import {
  buildSelectWithFilters,
  buildInsert,
  buildUpdate,
  buildUpsert,
  buildSoftDelete,
  SearchFilters,
  ParamValue,
  QueryData,
} from "../database";

/**
 * Sentinel for a data-bag value that must be stamped from the DB clock
 * (`CURRENT_TIMESTAMP`) rather than a bound parameter. Keeps every mutation on
 * one timeline: the `?since=` delta cursor reads `as_of` from the DB clock, so
 * an app-clock write (`new Date()`) on a host whose clock lags the DB's could
 * stamp `updated` below a cursor the client already holds and drop the
 * tombstone. Pass in an updateWhere data bag: `updateWhere(f, { updated: DB_NOW })`.
 */
export const DB_NOW: unique symbol = Symbol("DB_NOW");

export class ModelValidationError extends Error {
  public readonly errors: string[];

  constructor(modelName: string, errors: string[]) {
    super(`${modelName} validation failed:\n${errors.join("\n")}`);
    this.name = "ModelValidationError";
    this.errors = errors;
  }
}

export type ColumnDefinition = string;

export type Schema = { [k: string]: ColumnDefinition };

export type Constraints = string[];

export interface IndexDefinition {
  column: string;
  /** Index method. Omit for the btree default. */
  using?: "gin" | "gist";
  /** Operator class, e.g. `jsonb_path_ops` for a `@>` containment filter. */
  opclass?: string;
}

export type PropertyChecker<T> = {
  [K in keyof T]: (value: unknown) => boolean;
};

export function validateObject<T extends Record<string, unknown>>(
  input: unknown,
  checker: PropertyChecker<T>,
  skip: (keyof T)[] = []
): string[] {
  if (typeof input !== "object" || input === null) {
    return [`Input is not a valid object: ${String(input)}`];
  }

  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  for (const [key, check] of Object.entries(checker)) {
    if (skip.includes(key as keyof T)) continue;
    if (!check) continue;
    const value = obj[key];
    if (!check(value)) {
      errors.push(`${key}: ${JSON.stringify(value)} (${typeof value})`);
    }
  }

  return errors;
}

export abstract class Model<TJSON, TSchema extends Schema> {
  abstract toJSON(): TJSON;

  constructor(data: unknown, typeChecker: PropertyChecker<TSchema>) {
    // asserts type
    const errors = validateObject(data, typeChecker);
    if (errors.length > 0) throw new ModelValidationError(this.constructor.name, errors);
    // assigns value
    const self = this as unknown as Record<string, unknown>;
    Object.keys(typeChecker).forEach((k) => {
      self[k] = (data as TSchema)[k];
    });
  }
}

export interface ModelClass<TJSON, TModel extends Model<TJSON, Schema>> {
  new (data: unknown): TModel;
}

export interface TableSearchFilters extends Omit<SearchFilters, "filters"> {
  filters?: Record<string, ParamValue>;
}

/**
 * Type-safe filter keys: restricts filters to valid column names from the schema.
 * This provides compile-time typo prevention and IDE autocomplete for filter keys.
 */
export type SchemaFilterKey<TSchema extends Schema> = keyof TSchema & string;

/**
 * Type-safe filters: maps schema keys to ParamValue.
 * Restricts filter keys to valid column names defined in the schema.
 */
export type TypeSafeFilters<TSchema extends Schema> = {
  [K in SchemaFilterKey<TSchema>]?: ParamValue | unknown;
};

/**
 * A filter condition with an explicit comparison operator.
 * Supports range comparisons (<, <=, >, >=), equality (=), and IN-list (value: ParamValue[]).
 * If notNull is true, an extra "col IS NOT NULL" clause is prepended.
 *
 * Example: deleteWhere({ cookie_expires: { op: '<=', value: now, notNull: true } })
 * Example: updateWhere({ mail_id: { op: 'IN', value: ids } }, { expunged: true, updated: DB_NOW })
 */
export interface FilterCondition {
  op: "=" | "<" | "<=" | ">" | ">=" | "IN";
  value: ParamValue | ParamValue[];
  notNull?: boolean;
}

/** Accepts either a plain equality value or a FilterCondition for deleteWhere()/updateWhere(). */
export type WhereFilter = ParamValue | FilterCondition;

export type WhereFilters<TSchema extends Schema> = {
  [K in SchemaFilterKey<TSchema>]?: WhereFilter | unknown;
};

/** @deprecated Use WhereFilter / WhereFilters — kept for backwards compat. */
export type DeleteWhereFilter = WhereFilter;
export type DeleteWhereFilters<TSchema extends Schema> = WhereFilters<TSchema>;

/**
 * Mutation filters must name every predicate they intend to apply. A key that
 * is present with an `undefined` value means the caller meant to scope the
 * statement by that column and had nothing to scope it with. Dropping it —
 * the right default for optional *search* filters — silently widens an UPDATE
 * or DELETE to every row the surviving predicates match, which is how a single
 * missing request field turns into a whole-table mutation.
 *
 * A key that was never passed does not appear in `Object.entries`, so the
 * `...(condition ? { column: value } : {})` spread idiom is unaffected.
 */
function assertNoUndefinedFilters(
  method: string,
  filters: Record<string, unknown>
): void {
  const undefinedColumns = Object.entries(filters)
    .filter(([, value]) => value === undefined)
    .map(([column]) => column);
  if (undefinedColumns.length > 0) {
    throw new Error(
      `${method} received undefined for ${undefinedColumns.join(", ")} — ` +
        `refusing to run a mutation without the intended predicate`
    );
  }
}

/**
 * Builds a WHERE clause from filter entries, handling both plain-equality and
 * FilterCondition entries (including IN-list). Returns the clause string plus
 * the parameter values, with placeholders numbered starting at startParamIdx.
 * Throws if an IN-list value is empty (postgres rejects `col IN ()`).
 */
function buildFilterClauses(
  entries: [string, unknown][],
  startParamIdx: number
): { whereSql: string; values: ParamValue[] } {
  const whereClauses: string[] = [];
  const values: ParamValue[] = [];
  let paramIdx = startParamIdx;
  for (const [col, filter] of entries) {
    if (filter !== null && typeof filter === "object" && "op" in (filter as object)) {
      const cond = filter as FilterCondition;
      if (cond.notNull) whereClauses.push(`${col} IS NOT NULL`);
      if (cond.op === "IN") {
        const arr = cond.value as ParamValue[];
        if (!Array.isArray(arr) || arr.length === 0) {
          throw new Error(`IN filter for ${col} requires a non-empty array`);
        }
        const placeholders = arr.map(() => `$${paramIdx++}`).join(", ");
        whereClauses.push(`${col} IN (${placeholders})`);
        values.push(...arr);
      } else {
        whereClauses.push(`${col} ${cond.op} $${paramIdx++}`);
        values.push(cond.value as ParamValue);
      }
    } else {
      whereClauses.push(`${col} = $${paramIdx++}`);
      values.push(filter as ParamValue);
    }
  }
  return { whereSql: whereClauses.join(" AND "), values };
}

export abstract class Table<
  TJSON,
  TSchema extends Schema,
  TModel extends Model<TJSON, TSchema> = Model<TJSON, TSchema>
> {
  abstract readonly name: string;
  abstract readonly primaryKey: string;
  abstract readonly schema: TSchema;
  abstract readonly constraints: Constraints;
  abstract readonly indexes: IndexDefinition[];
  abstract readonly ModelClass: ModelClass<TJSON, TModel>;
  abstract readonly supportsSoftDelete: boolean;

  async query(
    filters: TypeSafeFilters<TSchema> = {}
  ): Promise<TModel[]> {
    const { sql, values } = buildSelectWithFilters(this.name, "*", {
      filters,
      excludeDeleted: this.supportsSoftDelete,
    });
    const result = await pool.query(sql, values);
    return result.rows.map((row: unknown) => new this.ModelClass(row));
  }

  async queryOne(
    filters: TypeSafeFilters<TSchema>
  ): Promise<TModel | null> {
    const { sql, values } = buildSelectWithFilters(this.name, "*", {
      filters,
      limit: 1,
      excludeDeleted: this.supportsSoftDelete,
    });
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? new this.ModelClass(result.rows[0]) : null;
  }

  /** The builders stamp `updated` only where the DDL declares the column. */
  private get stampUpdated(): boolean {
    return "updated" in this.schema;
  }

  async insert(
    data: QueryData,
    returning?: string[]
  ): Promise<Record<string, unknown> | null> {
    const { sql, values } = buildInsert(
      this.name,
      data as Record<string, ParamValue>,
      returning ?? [this.primaryKey],
      { stampUpdated: this.stampUpdated }
    );
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async update(
    primaryKeyValue: ParamValue,
    data: QueryData,
    returning?: string[]
  ): Promise<Record<string, unknown> | null> {
    const query = buildUpdate(this.name, this.primaryKey, primaryKeyValue, data, {
      returning: returning ?? [this.primaryKey],
      stampUpdated: this.stampUpdated,
    });
    if (!query) return null;
    const result = await pool.query(query.sql, query.values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async upsert(
    data: QueryData,
    updateColumns?: string[]
  ): Promise<Record<string, unknown> | null> {
    const { sql, values } = buildUpsert(this.name, this.primaryKey, data, {
      updateColumns:
        updateColumns ?? Object.keys(data).filter((k) => k !== this.primaryKey),
      returning: ["*"],
      stampUpdated: this.stampUpdated,
    });
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async softDelete(primaryKeyValue: ParamValue): Promise<boolean> {
    if (!("is_deleted" in this.schema)) {
      throw new Error(
        `${this.name} declares no is_deleted column — use hardDelete or deleteWhere`
      );
    }
    const { sql, values } = buildSoftDelete(
      this.name,
      this.primaryKey,
      primaryKeyValue,
      { stampUpdated: this.stampUpdated }
    );
    const result = await pool.query(sql, values);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async hardDelete(primaryKeyValue: ParamValue): Promise<boolean> {
    const sql = `DELETE FROM ${this.name} WHERE ${this.primaryKey} = $1 RETURNING ${this.primaryKey}`;
    const result = await pool.query(sql, [primaryKeyValue]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async deleteWhere(
    filters: WhereFilters<TSchema>
  ): Promise<number> {
    assertNoUndefinedFilters("deleteWhere", filters);
    const entries = Object.entries(filters);
    if (entries.length === 0) {
      throw new Error("deleteWhere requires at least one filter");
    }
    const { whereSql, values } = buildFilterClauses(entries, 1);
    const sql = `DELETE FROM ${this.name} WHERE ${whereSql} RETURNING ${this.primaryKey}`;
    const result = await pool.query(sql, values);
    return result.rowCount ?? 0;
  }

  async updateWhere(
    filters: WhereFilters<TSchema>,
    data: QueryData,
    returning?: string[]
  ): Promise<Record<string, unknown>[]> {
    assertNoUndefinedFilters("updateWhere", filters);
    const filterEntries = Object.entries(filters);
    const dataEntries = Object.entries(data).filter(([, v]) => v !== undefined);
    if (filterEntries.length === 0) {
      throw new Error("updateWhere requires at least one filter");
    }
    if (dataEntries.length === 0) {
      return [];
    }
    let paramIdx = 1;
    const dataValues: ParamValue[] = [];
    const setClauses = dataEntries.map(([k, v]) => {
      // DB_NOW stamps the column from the DB clock (`CURRENT_TIMESTAMP`) as a
      // SQL literal, consuming no bound parameter — keeps every mutation on one
      // timeline for the delta cursor (see DB_NOW).
      if (v === DB_NOW) return `${k} = CURRENT_TIMESTAMP`;
      dataValues.push(v as ParamValue);
      return `${k} = $${paramIdx++}`;
    });
    const { whereSql, values: whereValues } = buildFilterClauses(filterEntries, paramIdx);
    const returningClause = returning?.length ? ` RETURNING ${returning.join(", ")}` : "";
    const sql = `UPDATE ${this.name} SET ${setClauses.join(", ")} WHERE ${whereSql}${returningClause}`;
    const result = await pool.query(sql, [...dataValues, ...whereValues]);
    return result.rows;
  }

  async queryByIds(
    ids: ParamValue[],
    additionalFilters: TypeSafeFilters<TSchema> = {}
  ): Promise<TModel[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    let sql = `SELECT * FROM ${this.name} WHERE ${this.primaryKey} IN (${placeholders})`;
    if (this.supportsSoftDelete) {
      sql += ` AND (is_deleted IS NULL OR is_deleted = FALSE)`;
    }
    const values: ParamValue[] = [...ids];

    let paramIdx = ids.length + 1;
    for (const [key, value] of Object.entries(additionalFilters)) {
      if (value !== undefined) {
        sql += ` AND ${key} = $${paramIdx++}`;
        values.push(value as ParamValue);
      }
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: unknown) => new this.ModelClass(row));
  }
}

export interface TableConfig<
  TJSON,
  TSchema extends Schema,
  TModel extends Model<TJSON, TSchema>
> {
  name: string;
  primaryKey: string;
  schema: TSchema;
  constraints?: Constraints;
  indexes?: IndexDefinition[];
  ModelClass: ModelClass<TJSON, TModel>;
  supportsSoftDelete?: boolean;
}

export function createTable<
  TJSON,
  TSchema extends Schema,
  TModel extends Model<TJSON, TSchema>
>(config: TableConfig<TJSON, TSchema, TModel>): Table<TJSON, TSchema, TModel> {
  return new (class extends Table<TJSON, TSchema, TModel> {
    readonly name = config.name;
    readonly primaryKey = config.primaryKey;
    readonly schema = config.schema;
    readonly constraints = config.constraints ?? [];
    readonly indexes = config.indexes ?? [];
    readonly ModelClass = config.ModelClass;
    readonly supportsSoftDelete = config.supportsSoftDelete ?? true;
  })();
}
