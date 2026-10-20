import { fromMarkdown } from "mdast-util-from-markdown";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

function decodeHtmlEntities(value: string) {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };
  // A decoded ampersand must not turn a second entity into active markup.
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => entities[entity],
  );
}

function htmlInlineToMarkdown(value: string): string {
  return convertInlineHtml(decodeHtmlEntities(value));
}

function convertInlineHtml(value: string): string {
  return value
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, depth: string, text: string) =>
        `${"#".repeat(Number(depth))} ${convertInlineHtml(text)}\n\n`,
    )
    .replace(/<\/?(?:p|div|center)\b[^>]*>/gi, "\n\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<img\b([^>]*)>/gi, (_match: string, attrs: string) => {
      const src = attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1];
      const alt = attrs.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
      return src ? `![${alt}](${src})` : "";
    })
    .replace(
      /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_match: string, href: string, label: string) =>
        `[${convertInlineHtml(label).trim()}](${href})`,
    )
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, "$1")
    .replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function normalizeHtmlBlock(content: string): string {
  if (!/^\s*<(?:h[1-6]|p|div|center)\b/i.test(content)) return content;
  return htmlInlineToMarkdown(content)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert supported README presentation HTML, leaving Markdown code untouched.
 * This produces Markdown, not sanitized HTML: the shared renderer still owns
 * escaping raw HTML and validating link protocols.
 */
export function normalizeReadmeMarkdown(content: string): string {
  const parts: string[] = [];
  let offset = 0;
  function visit(node: MarkdownNode) {
    if (node.type === "html" && typeof node.value === "string") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        parts.push(
          content.slice(offset, start),
          normalizeHtmlBlock(content.slice(start, end)),
        );
        offset = end;
      }
    } else {
      node.children?.forEach(visit);
    }
  }
  visit(fromMarkdown(content));
  parts.push(content.slice(offset));
  return parts.join("").trim();
}
