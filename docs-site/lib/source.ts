import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { openapi } from "./openapi";

const docs = defineDocs({
  dir: "content/docs",
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({ baseDir: "reference", groupBy: "tag" }),
  },
  {
    baseUrl: "/",
    plugins: [openapi.loaderPlugin()],
  },
);
