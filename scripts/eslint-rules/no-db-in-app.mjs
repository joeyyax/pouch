/**
 * Flags a database import in a server action, page or component. A capability defined in the
 * action has no surface but the dashboard; a query in a page skips the loader (#393).
 * `@/lib/db/clock` is allowed — `dbNow()` is a timestamp, not data access — and so is
 * `@/lib/db/enums`, which is constants with no imports.
 */
const DB_IMPORT = /^(@\/lib\/db|@\/lib\/db\/.*)$/;
const ALLOWED = new Set(["@/lib/db/clock", "@/lib/db/enums"]);

const MESSAGE =
  "app/ can't reach the database. Put the capability in lib/<resource>/ or the read in a lib/dashboard/ loader and call it from here, so a route and an MCP tool can call it too (docs/engineering.md, Rules).";

const rule = {
  meta: { type: "problem", schema: [] },
  create(context) {
    function check(node, source) {
      if (typeof source !== "string") return;
      if (ALLOWED.has(source) || !DB_IMPORT.test(source)) return;
      context.report({ node, message: MESSAGE });
    }

    return {
      ImportDeclaration(node) {
        // A type carries no query. Only a value import reaches the database.
        if (node.importKind === "type") return;
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node, node.source.value);
      },
    };
  },
};

export default rule;
