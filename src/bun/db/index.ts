import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqlite } from "./connection";

// Main Drizzle ORM instance — import this for all DB operations.
// DB errors are globally caught by the sqlite Proxy in connection.ts
// (logs to error.log + console.error, then re-throws).
export const db = drizzle(sqlite);

// Re-export closeDatabase for graceful shutdown
export { closeDatabase } from "./connection";
