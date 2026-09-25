import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { loadLocalEnv, requireEnv } from "./env";

// Applies every supabase/migrations/*.sql file in order, each inside a transaction,
// and records it in public.schema_migrations. Migrations are themselves idempotent,
// so re-running is safe.
//
// Needs SUPABASE_DB_URL (Supabase dashboard > Connect > Session pooler URI). This is
// only used from your machine and is not needed by the deployed app.
async function main() {
  loadLocalEnv();
  const sql = postgres(requireEnv("SUPABASE_DB_URL"), {
    ssl: "require",
    max: 1,
    onnotice: () => {},
  });
  try {
    await sql`create table if not exists public.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    await sql`alter table public.schema_migrations enable row level security`;

    const dir = path.join("supabase", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const body = readFileSync(path.join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into public.schema_migrations (name) values (${file})
                 on conflict (name) do update set applied_at = now()`;
      });
      console.log(`applied ${file}`);
    }

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    console.log(JSON.stringify({ ok: true, tables: tables.map((t) => t.table_name) }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error: Error) => {
  // postgres errors do not include the connection string.
  console.error(`Migration failed: ${error.message}`);
  process.exit(1);
});
