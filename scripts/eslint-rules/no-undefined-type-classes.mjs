/**
 * Flags a `type-*` class name that app/styles/typography.css doesn't define.
 * `type-h6` shipped once, rendered as unstyled body text, and nothing caught it.
 */
import fs from "node:fs";
import path from "node:path";

const TYPOGRAPHY_PATH = path.join(process.cwd(), "app/styles/typography.css");
const TOKEN_PATTERN = /\btype-[a-zA-Z0-9-]+\b/g;

function definedClasses() {
  const css = fs.readFileSync(TYPOGRAPHY_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = new Set();
  for (const match of css.matchAll(/\.(type-[a-zA-Z0-9-]+)/g)) classes.add(match[1]);
  return classes;
}

const defined = definedClasses();

const CLASS_MERGE_FNS = new Set(["cn", "clsx", "cva"]);

// Restrict to spots that actually hold class names — className props and cn()/clsx()/cva()
// calls — so a string that merely mentions "type-something" (a rule name, an import path)
// isn't mistaken for a class name.
function inClassNameContext(context, node) {
  for (const ancestor of context.sourceCode.getAncestors(node)) {
    if (ancestor.type === "JSXAttribute" && ancestor.name?.name === "className") return true;
    if (
      ancestor.type === "CallExpression" &&
      ancestor.callee?.type === "Identifier" &&
      CLASS_MERGE_FNS.has(ancestor.callee.name)
    ) {
      return true;
    }
  }
  return false;
}

function checkString(context, node, value) {
  if (!inClassNameContext(context, node)) return;
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    const className = match[0];
    if (!defined.has(className)) {
      context.report({
        node,
        message: `"${className}" isn't defined in app/styles/typography.css.`,
      });
    }
  }
}

const rule = {
  meta: { type: "problem" },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string") checkString(context, node, node.value);
      },
      TemplateElement(node) {
        checkString(context, node, node.value.raw);
      },
    };
  },
};

export default rule;
