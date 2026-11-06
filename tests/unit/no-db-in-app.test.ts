import { RuleTester } from "eslint";
import { it } from "vitest";
import rule from "../../scripts/eslint-rules/no-db-in-app.mjs";

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } });

it("refuses a database import in app/ and allows the clock and the enums", () => {
  tester.run("no-db-in-app", rule as never, {
    valid: [
      { code: 'import { dbNow } from "@/lib/db/clock";' },
      { code: 'import { MESSAGE_STATUSES } from "@/lib/db/enums";' },
      { code: 'import { addSuppression } from "@/lib/messages/suppression-manage";' },
    ],
    invalid: [
      { code: 'import { db } from "@/lib/db";', errors: 1 },
      { code: 'import { users } from "@/lib/db/schema";', errors: 1 },
      { code: 'import { MESSAGE_STATUSES } from "@/lib/db/schema/messages";', errors: 1 },
      { code: 'const { db } = await import("@/lib/db");', errors: 1 },
    ],
  });
});
