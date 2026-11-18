// A throwaway SQLite database for one test file, built from the real migrations.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

export async function makeTestDb(): Promise<PrismaClient> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pricepilot-test-"));
  const client = new PrismaClient({
    datasources: { db: { url: `file:${path.join(dir, "test.sqlite")}` } },
  });
  const migrations = path.resolve(process.cwd(), "prisma", "migrations");
  for (const name of readdirSync(migrations).sort()) {
    const file = path.join(migrations, name, "migration.sql");
    let sql: string;
    try {
      sql = readFileSync(file, "utf8");
    } catch {
      continue; // migration_lock.toml
    }
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await client.$executeRawUnsafe(statement);
  }
  return client;
}
