/**
 * Flags `timeLabel` in a client component. The server renders one label and the client another
 * a few seconds later, which React reports as a hydration mismatch (#386). `<Time>` handles it.
 */
const MESSAGE = "timeLabel in a client component mismatches on hydration. Render <Time date={...} /> instead.";

function isClientComponent(context) {
  const body = context.sourceCode.ast.body;
  for (const node of body) {
    if (node.type !== "ExpressionStatement" || node.expression?.type !== "Literal") break;
    if (node.expression.value === "use client") return true;
  }
  return false;
}

const rule = {
  meta: { type: "problem", schema: [] },
  create(context) {
    if (!isClientComponent(context)) return {};
    return {
      CallExpression(node) {
        if (node.callee?.type === "Identifier" && node.callee.name === "timeLabel") {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
};

export default rule;
