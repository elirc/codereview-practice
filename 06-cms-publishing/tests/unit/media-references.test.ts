import { describe, expect, it } from "vitest";
import { extractMediaIds } from "@/services/media-references";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("extractMediaIds", () => {
  it("collects the cover and every body reference once, lower-cased", () => {
    const body = `![one](media:${A})\n\n[file](media:${B.toUpperCase()}) and again media:${A}`;
    expect(extractMediaIds(body, B)).toEqual([B, A]);
  });

  it("ignores malformed references", () => {
    expect(extractMediaIds("media:not-a-uuid and media:1234", null)).toEqual([]);
  });
});
