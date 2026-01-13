import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";
import { join } from "path";

// Type for any Drizzle database instance that works with our schema
export type Database = ReturnType<typeof drizzle<typeof schema>>;

// The active database instance
let _db: Database | null = null;
let _migrated = false;

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
 * Run database migrations.
 * Safe to call multiple times - only runs once.
 * Call this at app startup before any database operations.
 */
export async function runMigrations(): Promise<void> {
  if (_migrated) {
    return;
  }

  const db = getDb();
  const migrationsFolder = join(import.meta.dir, "../../drizzle");

  console.log("[DB] Running migrations...");
  await migrate(db, { migrationsFolder });
  console.log("[DB] Migrations complete");

  _migrated = true;
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
