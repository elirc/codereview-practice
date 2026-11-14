import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { UUID_SOURCE } from "./media-references";

const MEDIA_ATTRIBUTE = new RegExp(`(\\s(?:src|href)=")media:(${UUID_SOURCE})"`, "gi");
const MEDIA_PATH = new RegExp(`^/media/${UUID_SOURCE}$`, "i");

const marked = new Marked({ gfm: true });

/** The complete allow-list for rendered post bodies. */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "del",
    "a",
    "img",
    "code",
    "pre",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel"],
    img: ["src", "alt", "title"],
    th: ["align"],
    td: ["align"],
    ol: ["start"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: [] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
  },
  exclusiveFilter: (frame) => frame.tag === "img" && !MEDIA_PATH.test(frame.attribs.src ?? ""),
};

/** Renders post markdown to sanitised HTML. Used for both the public site and previews. */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  return sanitizeHtml(html.replace(MEDIA_ATTRIBUTE, '$1/media/$2"'), SANITIZE_OPTIONS);
}
