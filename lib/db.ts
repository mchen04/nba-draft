import { Pool } from "pg";

const globalDatabase = globalThis as unknown as { nbaPool?: Pool };
export function database() {
  if (!process.env.DATABASE_URL) throw new Error("Database is not configured.");
  const connection = new URL(process.env.DATABASE_URL);
  if (connection.searchParams.get("sslmode") === "require")
    connection.searchParams.set("sslmode", "verify-full");
  if (!globalDatabase.nbaPool)
    globalDatabase.nbaPool = new Pool({
      connectionString: connection.toString(),
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
      application_name: "nba-draft",
    });
  return globalDatabase.nbaPool;
}
