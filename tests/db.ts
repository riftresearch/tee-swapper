/**
 * Test database setup using PGlite (in-memory PostgreSQL via WASM).
 *
 * No Docker or external database required!
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { setDb, resetDb, type Database } from "../src/db/client";

let pgliteClient: PGlite | null = null;
let testDb: PgliteDatabase<typeof schema> | null = null;

/**
 * Initialize an in-memory PostgreSQL database and run migrations.
 * Also injects the test db into the app's db client.
 * Call this in beforeAll.
 */
export async function setupTestDatabase(): Promise<PgliteDatabase<typeof schema>> {
  // Create in-memory PostgreSQL instance
  pgliteClient = new PGlite();
  testDb = drizzle(pgliteClient, { schema });

  // Run migrations
  await migrate(testDb, {
    migrationsFolder: "./drizzle",
  });

  // Inject the test db into the app
  setDb(testDb as unknown as Database);

  return testDb;
}

/**
 * Get the current test database instance.
 * Throws if not initialized.
 */
export function getTestDb(): PgliteDatabase<typeof schema> {
  if (!testDb) {
    throw new Error("Test database not initialized. Call setupTestDatabase() first.");
  }
  return testDb;
}

/**
 * Clean up all data from the swaps table.
 * Call this in beforeEach or afterEach for test isolation.
 */
export async function cleanupSwaps(): Promise<void> {
  if (!testDb) return;

  await testDb.execute(sql`DELETE FROM swaps`);
}

/**
 * Close the test database connection.
 * Call this in afterAll.
 */
export async function teardownTestDatabase(): Promise<void> {
  resetDb();
  
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
    testDb = null;
  }
}
