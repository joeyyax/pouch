import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { ReferenceAnchors } from "./reference-anchors";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ReferenceAnchors,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
