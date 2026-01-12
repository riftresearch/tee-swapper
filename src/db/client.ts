import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Type for any Drizzle database instance that works with our schema
export type Database = ReturnType<typeof drizzle<typeof schema>>;

// The active database instance
let _db: Database | null = null;

/**
 * Get the database instance.
 * In production, lazily creates a postgres-js connection.
 * In tests, uses whatever was set via setDb().
 */
export function getDb(): Database {
  if (!_db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set and no test database was configured");
    }
    const client = postgres(connectionString);
    _db = drizzle(client, { schema });
  }
  return _db;
}

/**
 * Set the database instance (for testing).
 * Call this before any database operations in tests.
 */
export function setDb(db: Database): void {
  _db = db;
}

/**
 * Reset the database instance (for testing cleanup).
 */
export function resetDb(): void {
  _db = null;
}

// For backwards compatibility, export db as a getter
// This allows `import { db } from "./client"` to still work
export const db = new Proxy({} as Database, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
