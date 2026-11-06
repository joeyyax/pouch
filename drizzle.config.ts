import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "./.env", quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
