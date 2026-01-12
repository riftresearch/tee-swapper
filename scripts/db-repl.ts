#!/usr/bin/env bun
/**
 * PGlite REPL - Interactive SQL shell for the test database
 *
 * Usage:
 *   bun scripts/db-repl.ts
 *   bun scripts/db-repl.ts "SELECT * FROM swaps"
 *
 * Data is stored in ./test-data/pglite
 */

import { PGlite } from "@electric-sql/pglite";
import * as readline from "readline";

const DATA_DIR = "./test-data/pglite";

async function main() {
  console.log(`Connecting to PGlite database at ${DATA_DIR}...`);

  const client = new PGlite(DATA_DIR);

  // Check if we have a one-off query
  const query = process.argv[2];
  if (query) {
    try {
      const result = await client.query(query);
      if (result.rows.length === 0) {
        console.log("(no rows)");
      } else {
        console.table(result.rows);
      }
    } catch (e) {
      console.error("Error:", (e as Error).message);
      process.exit(1);
    }
    await client.close();
    process.exit(0);
  }

  // Interactive REPL mode
  console.log("PGlite REPL (type SQL queries, \\dt for tables, \\q to quit)\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("pglite> ", async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        return prompt();
      }

      // Handle special commands
      if (trimmed === "\\q" || trimmed === "exit" || trimmed === "quit") {
        console.log("Bye!");
        await client.close();
        rl.close();
        process.exit(0);
      }

      if (trimmed === "\\dt") {
        // List tables
        try {
          const result = await client.query(`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
          `);
          console.table(result.rows);
        } catch (e) {
          console.error("Error:", (e as Error).message);
        }
        return prompt();
      }

      if (trimmed === "\\d" || trimmed.startsWith("\\d ")) {
        // Describe table
        const tableName = trimmed.slice(3).trim();
        if (!tableName) {
          console.log("Usage: \\d <table_name>");
          return prompt();
        }
        try {
          const result = await client.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = $1
            ORDER BY ordinal_position
          `, [tableName]);
          if (result.rows.length === 0) {
            console.log(`Table "${tableName}" not found`);
          } else {
            console.table(result.rows);
          }
        } catch (e) {
          console.error("Error:", (e as Error).message);
        }
        return prompt();
      }

      if (trimmed === "\\?" || trimmed === "help") {
        console.log(`
Commands:
  \\dt          List tables
  \\d <table>   Describe table columns
  \\q           Quit
  help          Show this help

Or enter any SQL query.
        `.trim());
        return prompt();
      }

      // Execute SQL query
      try {
        const result = await client.query(trimmed);
        if (result.rows.length === 0) {
          console.log("(no rows)");
        } else {
          console.table(result.rows);
        }
        console.log(`(${result.rows.length} row${result.rows.length === 1 ? "" : "s"})`);
      } catch (e) {
        console.error("Error:", (e as Error).message);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
