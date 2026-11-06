import { describe, expect, it } from "vitest";
import { renderHtmlTemplate, renderTemplate } from "@/lib/bulk/template";

describe("renderTemplate", () => {
  it.each([
    ["substitutes a known placeholder", "Hi {{name}}", "Hi Ada"],
    ["substitutes the same placeholder more than once", "{{name}} {{name}}", "Ada Ada"],
    ["tolerates surrounding whitespace inside the braces", "Hi {{ name }}", "Hi Ada"],
    ["leaves an unknown placeholder untouched", "Hi {{missing}}", "Hi {{missing}}"],
    ["leaves plain text with no placeholders untouched", "Hello there", "Hello there"],
  ])("%s", (_name, template, expected) => {
    expect(renderTemplate(template, { name: "Ada" })).toBe(expected);
  });
});

describe("renderHtmlTemplate", () => {
  it("escapes a value so it reads as text, not markup", () => {
    expect(renderHtmlTemplate("<p>Hi {{name}}</p>", { name: '<b>Ada</b> & "co"' })).toBe("<p>Hi &lt;b&gt;Ada&lt;/b&gt; &amp; &quot;co&quot;</p>");
  });

  it("keeps the template's own markup and an unknown placeholder", () => {
    expect(renderHtmlTemplate('<a href="{{url}}">{{missing}}</a>', { url: 'x" onclick="y' })).toBe('<a href="x&quot; onclick=&quot;y">{{missing}}</a>');
  });

  it("leaves the plain variant unescaped, for the subject and text", () => {
    expect(renderTemplate("Hi {{name}}", { name: "A & B" })).toBe("Hi A & B");
  });
});
