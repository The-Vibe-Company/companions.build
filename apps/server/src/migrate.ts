import { db, migrate } from "./store";

try {
  const result = await migrate();
  console.log(result.applied ? "Database migration applied" : "Database schema already current");
} finally {
  await db.close();
}
