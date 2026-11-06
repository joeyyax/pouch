import { config } from "dotenv";

// Next.js loads .env itself. The worker and scripts import this first so they see the same values.
config({ path: "./.env", quiet: true });
