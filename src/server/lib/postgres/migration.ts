/**
 * Automatic schema migration for PostgreSQL.
 * Compares TypeScript schema definitions with actual database columns
 * and automatically adds missing columns on startup.
 */

import { pool } from "./client";
import { Schema } from "./models/base";

// Mapping from TypeScript schema definitions to PostgreSQL types
interface ColumnInfo {
  name: string;
  pgType: string;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue: string | null;
}

interface DbColumn {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

/**
 * Parse a TypeScript schema column definition into normalized components.
 */
export function parseColumnDefinition(definition: string): ColumnInfo | null {
  // Extract the type part (before any constraints)
  const parts = definition.trim().toUpperCase().split(/\s+/);
  if (parts.length === 0) return null;

  const hasDefault = /DEFAULT\s+/i.test(definition);
  const defaultMatch = definition.match(/DEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|NULL|PRIMARY|REFERENCES|CHECK|UNIQUE)|$)/i);
  const defaultValue = defaultMatch ? defaultMatch[1].trim() : null;

  // Normalize the type
  let pgType = parts[0];
  
  // Handle common type variations
  if (pgType.startsWith("VARCHAR")) pgType = "VARCHAR";
  if (pgType.startsWith("CHAR")) pgType = "CHAR";
  if (pgType === "TIMESTAMPTZ" || pgType === "TIMESTAMP") pgType = "TIMESTAMP";
  if (pgType === "INTEGER" || pgType === "INT") pgType = "INTEGER";
  if (pgType === "BIGINT") pgType = "BIGINT";
  if (pgType === "SERIAL") pgType = "INTEGER"; // SERIAL is INTEGER with sequence
  if (pgType === "BIGSERIAL") pgType = "BIGINT";

  // Check nullable
  const notNull = /NOT\s+NULL/i.test(definition);
  const nullable = !notNull;

  return {
    name: "",
    pgType,
    nullable,
    hasDefault,
    defaultValue,
  };
}

/**
 * Map PostgreSQL data_type and udt_name to normalized type for comparison.
 */
function normalizeDbType(dataType: string, udtName: string): string {
  const type = dataType.toUpperCase();
  const udt = udtName.toUpperCase();

  // Handle user-defined types (like JSONB)
  if (type === "USER-DEFINED") {
    if (udt === "TSVECTOR") return "TSVECTOR";
    return udt;
  }

  // Normalize timestamp types
  if (type.includes("TIMESTAMP")) return "TIMESTAMP";
  
  // Normalize character types
  if (type.includes("CHARACTER VARYING")) return "VARCHAR";
  if (type.includes("CHARACTER")) return "CHAR";
  
  // Normalize text
  if (type === "TEXT") return "TEXT";
  
  // Normalize numeric types
  if (type === "INTEGER") return "INTEGER";
  if (type === "BIGINT") return "BIGINT";
  if (type === "SMALLINT") return "SMALLINT";
  if (type === "BOOLEAN") return "BOOLEAN";
  if (type === "NUMERIC" || type === "DECIMAL") return "NUMERIC";
  if (type === "REAL" || type === "DOUBLE PRECISION") return "FLOAT";
  
  // UUID
  if (type === "UUID") return "UUID";
  
  // JSON types
  if (type === "JSONB" || udt === "JSONB") return "JSONB";
  if (type === "JSON" || udt === "JSON") return "JSON";

  // Array types
  if (type === "ARRAY") return `${normalizeDbType(udtName.replace(/^_/, ""), udtName)}[]`;

  return type;
}

/**
 * Check if two types are compatible.
 * Returns true if they're the same or one is a compatible variation.
 */
function typesCompatible(schemaType: string, dbType: string): boolean {
  // Direct match
  if (schemaType === dbType) return true;
  
  // VARCHAR/TEXT are often interchangeable
  if ((schemaType === "VARCHAR" || schemaType === "TEXT") && 
      (dbType === "VARCHAR" || dbType === "TEXT")) return true;
  
  // JSON and JSONB
  if ((schemaType === "JSON" || schemaType === "JSONB") && 
      (dbType === "JSON" || dbType === "JSONB")) return true;

  // INTEGER variations
  if ((schemaType === "INTEGER" || schemaType === "INT4" || schemaType === "SERIAL") &&
      (dbType === "INTEGER" || dbType === "INT4")) return true;

  return false;
}

/**
 * Query existing columns for a table from PostgreSQL information_schema.
 */
async function getExistingColumns(tableName: string): Promise<Map<string, DbColumn>> {
  const result = await pool.query<DbColumn>(`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `, [tableName]);

  const columns = new Map<string, DbColumn>();
  for (const row of result.rows) {
    columns.set(row.column_name, row);
  }
  return columns;
}

/**
 * Build an ALTER TABLE statement to add a missing column.
 */
function buildAddColumnSql(tableName: string, columnName: string, definition: string): string {
  // Clean the definition for ALTER TABLE context
  // Remove PRIMARY KEY (can't add via ALTER TABLE easily)
  let cleanDef = definition.replace(/PRIMARY\s+KEY/gi, "");
  
  // For NOT NULL columns without defaults, we need to add a default
  const hasNotNull = /NOT\s+NULL/i.test(definition);
  const hasDefault = /DEFAULT\s+/i.test(definition);
  
  if (hasNotNull && !hasDefault) {
    // Infer a sensible default based on type
    const type = definition.split(/\s+/)[0].toUpperCase();
    let defaultValue = "''"; // Default to empty string
    
    if (type === "BOOLEAN") defaultValue = "FALSE";
    else if (type === "INTEGER" || type === "BIGINT" || type === "SMALLINT") defaultValue = "0";
    else if (type === "UUID") defaultValue = "gen_random_uuid()";
    else if (type.includes("TIMESTAMP")) defaultValue = "CURRENT_TIMESTAMP";
    else if (type === "JSONB" || type === "JSON") defaultValue = "'{}'::jsonb";
    else if (type === "TEXT" || type.startsWith("VARCHAR")) defaultValue = "''";
    
    cleanDef = cleanDef.replace(/NOT\s+NULL/i, `DEFAULT ${defaultValue} NOT NULL`);
  }

  return `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${cleanDef.trim()}`;
}

export interface MigrationResult {
  table: string;
  added: string[];
  warnings: string[];
  errors: string[];
}

/**
 * Migrate a single table to match its schema definition.
 */
export async function migrateTable(
  tableName: string,
  schema: Schema
): Promise<MigrationResult> {
  const result: MigrationResult = {
    table: tableName,
    added: [],
    warnings: [],
    errors: [],
  };

  // Get existing columns from database
  const existingColumns = await getExistingColumns(tableName);
  
  // If table doesn't exist yet, nothing to migrate (CREATE TABLE will handle it)
  if (existingColumns.size === 0) {
    return result;
  }

  // Check each column in the schema
  for (const [columnName, definition] of Object.entries(schema)) {
    const existingCol = existingColumns.get(columnName);
    
    if (!existingCol) {
      // Column is missing - add it
      try {
        const sql = buildAddColumnSql(tableName, columnName, definition);
        await pool.query(sql);
        result.added.push(columnName);
        console.info(`[Migration] Added column ${tableName}.${columnName}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to add ${columnName}: ${msg}`);
      }
    } else {
      // Column exists - check for type compatibility
      const parsed = parseColumnDefinition(definition);
      if (parsed) {
        const dbType = normalizeDbType(existingCol.data_type, existingCol.udt_name);
        if (!typesCompatible(parsed.pgType, dbType)) {
          result.errors.push(
            `Type mismatch for ${columnName}: schema expects ${parsed.pgType}, database has ${dbType}`
          );
        }
      }
    }
  }

  // Check for extra columns in DB that aren't in schema
  for (const [columnName] of existingColumns) {
    if (!schema[columnName]) {
      result.warnings.push(
        `Extra column in database: ${columnName} (not in schema)`
      );
    }
  }

  return result;
}

/**
 * Run migrations for all provided tables.
 * Returns true if successful, throws on fatal errors.
 */
export async function runMigrations(
  tables: Array<{ name: string; schema: Schema }>
): Promise<void> {
  console.info("[Migration] Starting schema migration check...");
  
  const allResults: MigrationResult[] = [];
  const fatalErrors: string[] = [];

  for (const table of tables) {
    const result = await migrateTable(table.name, table.schema);
    allResults.push(result);
    
    // Type mismatches are fatal
    if (result.errors.length > 0) {
      fatalErrors.push(...result.errors.map(e => `${table.name}: ${e}`));
    }
  }

  // Log summary
  const totalAdded = allResults.reduce((sum, r) => sum + r.added.length, 0);
  const totalWarnings = allResults.reduce((sum, r) => sum + r.warnings.length, 0);

  if (totalAdded > 0) {
    console.info(`[Migration] Added ${totalAdded} column(s) across ${allResults.filter(r => r.added.length > 0).length} table(s)`);
  }

  if (totalWarnings > 0) {
    for (const result of allResults) {
      for (const warning of result.warnings) {
        console.warn(`[Migration] Warning: ${result.table}.${warning}`);
      }
    }
  }

  // Fatal errors stop startup
  if (fatalErrors.length > 0) {
    const errorMsg = `Schema migration failed:\n${fatalErrors.join("\n")}`;
    console.error(`[Migration] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  console.info("[Migration] Schema migration check complete.");
}
