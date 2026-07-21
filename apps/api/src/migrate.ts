// Versioned migration runner.
//
// Applies every .sql file in ../migrations that hasn't been recorded in the
// schema_migrations table yet, each in its own transaction, in filename order.
// Add a new numbered file (e.g. 002_add_foo.sql) to evolve the schema — never
// edit an already-applied file.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from './db.js';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

// DDL-only files: strip line comments, then split on statement terminators.
function splitStatements(content: string): string[] {
  return content
    .replace(/^\s*--.*$/gm, '') // drop full-line comments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runMigrations(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    ((await sql`SELECT version FROM schema_migrations`) as { version: string }[]).map((r) => r.version),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const statements = splitStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await sql.begin(async (tx) => {
      for (const stmt of statements) await tx.unsafe(stmt);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
    });
    console.log(`[api] applied migration ${version}`);
    count++;
  }

  console.log(count === 0 ? '[api] migrations up to date' : `[api] applied ${count} migration(s)`);
}
