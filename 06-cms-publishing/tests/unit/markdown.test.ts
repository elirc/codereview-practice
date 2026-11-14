import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/services/markdown";

const MEDIA_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("renderMarkdown", () => {
  it("renders ordinary markdown", () => {
    const html = renderMarkdown("# Title\n\nSome *emphasis* and `code`.\n\n- one\n- two");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("renders tables and blockquotes", () => {
    const html = renderMarkdown("> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("removes script elements and their content", () => {
    const html = renderMarkdown("Hello\n\n<script>alert('x')</script>\n\nWorld");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("alert(");
    expect(html).toContain("World");
  });

  it("strips event handler attributes", () => {
    const html = renderMarkdown(
      `<p onclick="steal()">hi</p>\n\n<img src="/media/${MEDIA_ID}" onerror="steal()">`,
    );
    expect(html).not.toMatch(/onclick|onerror|steal/);
  });

  it("drops javascript: and data: links", () => {
    const html = renderMarkdown(
      "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(2)) <a href='data:text/html,x'>c</a>",
    );
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain("data:");
  });

  it("keeps http, https and mailto links with a safe rel", () => {
    const html = renderMarkdown("[site](https://example.com) [mail](mailto:hi@example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:hi@example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("removes external, protocol-relative and data images", () => {
    const html = renderMarkdown(
      "![x](https://evil.example/x.png) ![y](//evil.example/y.png) ![z](data:image/png;base64,AAAA)",
    );
    expect(html).not.toContain("<img");
  });

  it("rewrites media references to the media route", () => {
    const html = renderMarkdown(`![diagram](media:${MEDIA_ID})\n\n[download](media:${MEDIA_ID})`);
    expect(html).toContain(`src="/media/${MEDIA_ID}"`);
    expect(html).toContain(`href="/media/${MEDIA_ID}"`);
    expect(html).not.toContain("media:");
  });

  it("does not allow other relative image paths", () => {
    const html = renderMarkdown(`![x](/media/${MEDIA_ID}/../../admin) ![y](/uploads/a.png)`);
    expect(html).not.toContain("<img");
  });

  it("strips iframes, styles and forms", () => {
    const html = renderMarkdown(
      '<iframe src="https://evil.example"></iframe><style>body{}</style><form><input></form>',
    );
    expect(html).not.toMatch(/<iframe|<style|<form|<input/);
  });
});
