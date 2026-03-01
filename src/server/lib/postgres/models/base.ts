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

  async insert(
    data: QueryData,
    returning?: string[]
  ): Promise<Record<string, unknown> | null> {
    const { sql, values } = buildInsert(
      this.name,
      data as Record<string, ParamValue>,
      returning ?? [this.primaryKey]
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
    });
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async softDelete(primaryKeyValue: ParamValue): Promise<boolean> {
    const { sql, values } = buildSoftDelete(
      this.name,
      this.primaryKey,
      primaryKeyValue
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
    filters: TypeSafeFilters<TSchema>
  ): Promise<number> {
    const entries = Object.entries(filters).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      throw new Error("deleteWhere requires at least one filter");
    }
    const whereClauses = entries.map(([k], i) => `${k} = $${i + 1}`);
    const values = entries.map(([, v]) => v as ParamValue);
    const sql = `DELETE FROM ${this.name} WHERE ${whereClauses.join(" AND ")} RETURNING ${this.primaryKey}`;
    const result = await pool.query(sql, values);
    return result.rowCount ?? 0;
  }

  async updateWhere(
    filters: TypeSafeFilters<TSchema>,
    data: QueryData,
    returning?: string[]
  ): Promise<Record<string, unknown>[]> {
    const filterEntries = Object.entries(filters).filter(([, v]) => v !== undefined);
    const dataEntries = Object.entries(data).filter(([, v]) => v !== undefined);
    if (filterEntries.length === 0) {
      throw new Error("updateWhere requires at least one filter");
    }
    if (dataEntries.length === 0) {
      return [];
    }
    let paramIdx = 1;
    const setClauses = dataEntries.map(([k]) => `${k} = $${paramIdx++}`);
    const whereClauses = filterEntries.map(([k]) => `${k} = $${paramIdx++}`);
    const values: ParamValue[] = [
      ...dataEntries.map(([, v]) => v as ParamValue),
      ...filterEntries.map(([, v]) => v as ParamValue),
    ];
    const returningClause = returning?.length ? ` RETURNING ${returning.join(", ")}` : "";
    const sql = `UPDATE ${this.name} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}${returningClause}`;
    const result = await pool.query(sql, values);
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
