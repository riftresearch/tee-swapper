/**
 * Persistent test database setup using PGlite.
 *
 * Data is stored in ./test-data/pglite so you can inspect it after tests.
 *
 * To view the database after tests:
 *   - Data is in ./test-data/pglite/
 *   - Or connect using any PostgreSQL tool to the file
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema";
import { setDb, type Database } from "../../src/db/client";
import { KeyDerivationService, setKeyDerivationService } from "../../src/services/key-derivation";
import { mkdirSync, writeFileSync, existsSync } from "fs";

const DATA_DIR = "./test-data/pglite";
const TEST_KEY_PATH = "./test-data/test-server-key.txt";

// Deterministic test key for reproducible tests
const TEST_SERVER_KEY = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

let pgliteClient: PGlite | null = null;
let testDb: PgliteDatabase<typeof schema> | null = null;

/**
 * Initialize a persistent PostgreSQL database and run migrations.
 * Data persists in ./test-data/pglite/ for inspection after tests.
 */
export async function setupPersistentTestDatabase(): Promise<PgliteDatabase<typeof schema>> {
  // Ensure data directory exists
  mkdirSync(DATA_DIR, { recursive: true });

  // Create test server key file
  writeFileSync(TEST_KEY_PATH, TEST_SERVER_KEY);

  // Initialize the key derivation service with the test key
  const keyService = new KeyDerivationService(TEST_KEY_PATH);
  setKeyDerivationService(keyService);

  // Create persistent PostgreSQL instance
  pgliteClient = new PGlite(DATA_DIR);
  testDb = drizzle(pgliteClient, { schema });

  // Run migrations
  await migrate(testDb, {
    migrationsFolder: "./drizzle",
  });

  // Inject the test db into the app
  setDb(testDb as unknown as Database);

  console.log(`[DB] Persistent database initialized at ${DATA_DIR}`);
  console.log(`[DB] Data will be retained after tests for inspection`);

  return testDb;
}

/**
 * Get the current test database instance.
 */
export function getTestDb(): PgliteDatabase<typeof schema> {
  if (!testDb) {
    throw new Error("Test database not initialized. Call setupPersistentTestDatabase() first.");
  }
  return testDb;
}
