import { runMigrations } from "../server/db.mjs";

await runMigrations();
console.log("Cloud database schema is ready.");
