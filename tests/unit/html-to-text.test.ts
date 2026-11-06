import { describe, expect, it } from "vitest";
import { htmlToText } from "@/lib/messages/html-to-text";

describe("htmlToText", () => {
  it("unwraps paragraphs to blank-line-separated text", () => {
    expect(htmlToText("<p>Hello</p><p>World</p>")).toBe("Hello\n\nWorld");
  });

  it("converts a heading and a paragraph the way a transactional email actually looks", () => {
    const html = "<h1>Receipt</h1><p>Thanks for your order.</p><p>See you soon.</p>";
    expect(htmlToText(html)).toBe("Receipt\n\nThanks for your order.\n\nSee you soon.");
  });

  it("converts <br> to a single line break, not a paragraph break", () => {
    expect(htmlToText("Line one<br>Line two")).toBe("Line one\nLine two");
  });

  it("renders a link as its text followed by its URL", () => {
    expect(htmlToText('<a href="https://example.com/path">Visit the site</a>')).toBe(
      "Visit the site https://example.com/path",
    );
  });

  it("falls back to the bare URL when the link has no text", () => {
    expect(htmlToText('<a href="https://example.com"><img src="btn.png"></a>')).toBe("https://example.com");
  });

  it("does not duplicate the URL when the link text is the URL itself", () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe("https://example.com");
  });

  it("turns list items into bullets", () => {
    const html = "<ul><li>First</li><li>Second</li></ul>";
    expect(htmlToText(html)).toBe("- First\n- Second");
  });

  it("separates table cells with a space, not a paragraph break, since email layout is table-based", () => {
    const html = "<table><tr><td>Widget</td><td>$5.00</td></tr><tr><td>Ship</td><td>$2.00</td></tr></table>";
    expect(htmlToText(html)).toBe("Widget $5.00\n\nShip $2.00");
  });

  it("decodes named HTML entities", () => {
    expect(htmlToText("<p>Ben &amp; Jerry&#39;s &mdash; est. 1978</p>")).toBe("Ben & Jerry's — est. 1978");
  });

  it("decodes numeric and hex entities", () => {
    expect(htmlToText("<p>&#65;&#x42;&#x43;</p>")).toBe("ABC");
  });

  it("decodes named entities that carry a digit, like sup1 and frac34", () => {
    expect(htmlToText("<p>&frac34; and &sup1; and &there4;</p>")).toBe("¾ and ¹ and ∴");
  });

  it("decodes entities outside the old hand-picked table, like a receipt actually carries", () => {
    const html = "<ul><li>Widget &times; 2</li><li>Shipping &amp; handling</li></ul><p>Sent by Pouch &bull; Unsubscribe</p>";
    expect(htmlToText(html)).toBe("- Widget × 2\n- Shipping & handling\n\nSent by Pouch • Unsubscribe");
  });

  it("decodes Greek letters and arrows, case-sensitively", () => {
    expect(htmlToText("<p>&Alpha; vs &alpha;, &rarr; here</p>")).toBe("Α vs α, → here");
  });

  it("leaves an unrecognized entity exactly as written, matching what the html part renders", () => {
    expect(htmlToText("<p>Weird &zzzznotarealentity; case</p>")).toBe("Weird &zzzznotarealentity; case");
  });

  it("does not drop characters from an unescaped ampersand followed by a semicolon", () => {
    expect(htmlToText("<p>Deal with AT&T; call them today</p>")).toBe("Deal with AT&T; call them today");
    expect(htmlToText("<p>Tom &amp; Jerry, R&D; and Q&A;</p>")).toBe("Tom & Jerry, R&D; and Q&A;");
  });

  it.each([
    ["a code point above the Unicode range", "<p>&#x110000;</p>", "&#x110000;"],
    ["a decimal code point above the Unicode range", "<p>&#1114112;</p>", "&#1114112;"],
    ["a lone high surrogate", "<p>&#xD800;</p>", "&#xD800;"],
    ["a lone low surrogate", "<p>&#xDFFF;</p>", "&#xDFFF;"],
    ["an empty numeric reference", "<p>&#;</p>", "&#;"],
    ["a non-hex numeric reference", "<p>&#xZZ;</p>", "&#xZZ;"],
    ["a bare ampersand", "<p>Fish & chips</p>", "Fish & chips"],
  ])("leaves %s as literal text", (_name, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it("does not double-decode an already-escaped ampersand", () => {
    expect(htmlToText("<p>Terms &amp;amp; Conditions</p>")).toBe("Terms &amp; Conditions");
  });

  it("drops a style block entirely", () => {
    expect(htmlToText("<style>p { color: red; }</style><p>Hello</p>")).toBe("Hello");
  });

  it("drops a script block entirely", () => {
    expect(htmlToText("<script>alert('hi')</script><p>Hello</p>")).toBe("Hello");
  });

  it("drops head content entirely, keeping only the body", () => {
    const html = "<html><head><title>Ignored</title><style>body{color:red}</style></head><body><p>Hi</p></body></html>";
    expect(htmlToText(html)).toBe("Hi");
  });

  it("collapses runs of whitespace within a line", () => {
    expect(htmlToText("<p>Too     much   space</p>")).toBe("Too much space");
  });

  it("collapses runs of blank lines to one", () => {
    expect(htmlToText("<div></div><div></div><div></div><p>Hello</p>")).toBe("Hello");
  });

  it("trims leading and trailing whitespace", () => {
    expect(htmlToText("  <p>  Hello  </p>  ")).toBe("Hello");
  });

  it("returns an empty string for html with no text content", () => {
    expect(htmlToText("<style>p{color:red}</style>")).toBe("");
  });

  it("handles a realistic transactional email body", () => {
    const html = `
      <html>
        <head><style>.btn { color: blue; }</style></head>
        <body>
          <h1>Your order shipped</h1>
          <p>Hi Ada, your order <strong>#1042</strong> is on its way.</p>
          <p><a href="https://example.com/track/1042">Track your package</a></p>
          <ul>
            <li>Ships from Portland</li>
            <li>Arrives in 3-5 days</li>
          </ul>
          <p>Thanks,<br>The Team</p>
        </body>
      </html>
    `;
    expect(htmlToText(html)).toBe(
      "Your order shipped\n\n" +
        "Hi Ada, your order #1042 is on its way.\n\n" +
        "Track your package https://example.com/track/1042\n\n" +
        "- Ships from Portland\n- Arrives in 3-5 days\n\n" +
        "Thanks,\nThe Team",
    );
  });
});
