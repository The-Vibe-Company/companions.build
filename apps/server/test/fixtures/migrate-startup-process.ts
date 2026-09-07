import { db, migrate } from "../../src/store";

try {
  const result = await migrate();
  // A service may begin ordinary work as soon as its migration call returns. Keeping these
  // relation locks briefly makes the formerly unsafe overlap with a later DDL replay observable.
  await db.begin(async sql => {
    await sql`SELECT count(*) FROM companions`;
    await sql`SELECT pg_sleep(0.1)`;
    await sql`SELECT count(*) FROM runs`;
  });
  console.log(JSON.stringify(result));
} finally {
  await db.close();
}
