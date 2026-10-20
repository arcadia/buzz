import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderCachedMarkdown } from "../../../shared/ui/markdown/nodeCache.ts";
import { normalizeReadmeMarkdown } from "./readmeMarkdown.ts";

test("README formatting decodes entities once and retains supported presentation", () => {
  const cases = [
    [
      "<h2>A &amp; B</h2><p><strong>Bold</strong><br>next</p>",
      "## A & B\n\n**Bold**\nnext",
    ],
    [
      "<p>&amp;lt;b&amp;gt;literal&amp;lt;/b&amp;gt;</p>",
      "&lt;b&gt;literal&lt;/b&gt;",
    ],
    [
      '<p><a href="https://example.com/docs">Docs</a></p>',
      "[Docs](https://example.com/docs)",
    ],
    [
      '<p><a href="https://example.com">&amp;lt;b&amp;gt;literal&amp;lt;/b&amp;gt;</a></p>',
      "[&lt;b&gt;literal&lt;/b&gt;](https://example.com)",
    ],
    [
      "<div><p>&amp;lt;b&amp;gt;literal&amp;lt;/b&amp;gt;</p></div>",
      "&lt;b&gt;literal&lt;/b&gt;",
    ],
    [
      "<div><div><center><p>&amp;lt;b&amp;gt;literal&amp;lt;/b&amp;gt;</p></center></div></div>",
      "&lt;b&gt;literal&lt;/b&gt;",
    ],
    [
      "<div><h2>Title</h2><p>First</p><p>Second</p></div>",
      "## Title\n\nFirst\n\nSecond",
    ],
  ];
  for (const [content, expected] of cases) {
    assert.equal(normalizeReadmeMarkdown(content), expected);
  }
});

test("README normalization preserves Markdown entities and code verbatim", () => {
  const content = [
    "Plain &amp;lt;b&amp;gt; text",
    "",
    "`<p>&amp;lt;b&amp;gt;</p>`",
    "",
    "```html",
    "<div><p>&amp;lt;b&amp;gt;literal&amp;lt;/b&amp;gt;</p></div>",
    "",
    "",
    "```",
    "",
    "<div><p>&amp;lt;b&amp;gt;converted&amp;lt;/b&amp;gt;</p></div>",
  ].join("\n");
  assert.equal(
    normalizeReadmeMarkdown(content),
    content.replace(
      "<div><p>&amp;lt;b&amp;gt;converted&amp;lt;/b&amp;gt;</p></div>",
      "&lt;b&gt;converted&lt;/b&gt;",
    ),
  );
});

test("README normalization remains behind the Markdown HTML and URL safety boundary", () => {
  const attacks = [
    '<p><a href="javascript:alert(1)">click</a></p>',
    '<p><img src="javascript:alert(1)" alt="image"></p>',
    "<p><scr<script>ipt>alert(1)</scr</script>ipt></p>",
    "<p>&amp;lt;img src=x onerror=alert(1)&amp;gt;</p>",
    "<script>alert(1)</script>",
  ];
  for (const content of attacks) {
    const html = renderToStaticMarkup(
      renderCachedMarkdown({
        content: normalizeReadmeMarkdown(content),
        components: {},
        hardLineBreaks: false,
        variant: "readme-security",
      }),
    );
    assert.doesNotMatch(
      html,
      /<script|<img[^>]*\bonerror=|(?:href|src)="javascript:/i,
    );
  }
});
