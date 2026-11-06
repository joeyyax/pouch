/**
 * Flags DDL in a test outside `withSchema`. A dropped constraint that a failing test never put
 * back leaves the database wrong for every later run in that checkout (#397).
 */
const DDL = /\b(ALTER\s+TABLE|DROP\s+(TABLE|CONSTRAINT|INDEX|COLUMN)|CREATE\s+(TABLE|INDEX|UNIQUE))\b/i;

const MESSAGE =
  "DDL in a test outlives the test when it throws. Run it through withSchema (tests/integration/migration-replay.ts), which rolls it back.";

function insideWithSchema(context, node) {
  return context.sourceCode.getAncestors(node).some((ancestor) => {
    return (
      ancestor.type === "CallExpression" &&
      ancestor.callee?.type === "Identifier" &&
      ancestor.callee.name === "withSchema"
    );
  });
}

function check(context, node, value) {
  if (typeof value !== "string" || !DDL.test(value)) return;
  if (insideWithSchema(context, node)) return;
  context.report({ node, message: MESSAGE });
}

const rule = {
  meta: { type: "problem", schema: [] },
  create(context) {
    return {
      Literal(node) {
        check(context, node, node.value);
      },
      TemplateElement(node) {
        check(context, node, node.value.cooked);
      },
    };
  },
};

export default rule;
