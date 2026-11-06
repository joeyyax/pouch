/**
 * Brings a local install up to date before `pnpm dev:all` starts anything: migrations every
 * time, seed and development data only on an empty database.
 *
 *   pnpm bootstrap
 *
 * The seed guard is the admin user. Once it exists the install is somebody's working copy, and
 * a reseed would clear the messages they sent by hand.
 */
import "@/lib/env";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { main as migrate } from "./migrate";

function run(script: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tsx", [script], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`))));
  });
}

async function adminExists(): Promise<boolean> {
  const email = process.env.ADMIN_EMAIL;
  if (!email) return false;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return Boolean(row);
}

async function main(): Promise<void> {
  await migrate();

  if (await adminExists()) {
    console.log("bootstrap: install already seeded, leaving its data alone");
    await closeDb();
    return;
  }

  await closeDb();
  await run("scripts/seed.ts", "seed");
  await run("scripts/dev-data.ts", "dev:data");
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
