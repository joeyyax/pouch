import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("http", http);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("json", json);
hljs.registerLanguage("typescript", typescript);

export type CodeLanguage = "bash" | "http" | "ini" | "json" | "typescript";

/** Highlighted code for the caller's `<pre>`. `http` reads `Name: value` header lines; `ini` reads `NAME=value` env lines. Colors live in app/code.css. */
export function Code({ code, language }: { code: string; language: CodeLanguage }) {
  // highlight.js escapes the source; its output is spans around escaped text.
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: hljs.highlight(code, { language }).value }} />;
}
