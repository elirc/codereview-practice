import { describe, expect, it } from "vitest";
import { readImageDimensions } from "@/media/dimensions";
import { contentDisposition, sanitizeFilename } from "@/media/filename";
import { mediaResponseHeaders } from "@/media/headers";
import { buildStorageKey } from "@/media/keys";
import { sniffMediaType } from "@/media/sniff";
import * as files from "../fixtures/files";

describe("sanitizeFilename", () => {
  it.each([
    ["../../../etc/passwd", "passwd"],
    ["..\\..\\x.png", "x.png"],
    ["C:\\Users\\me\\Desktop\\photo.jpg", "photo.jpg"],
    ["report\r\nSet-Cookie: x=1.pdf", "reportSet-Cookie: x=1.pdf"],
    ["tab\there.png", "tabhere.png"],
    ["  spaced.png  ", "spaced.png"],
    ["", "file"],
    ["dir/", "file"],
    ["\u0000\u0007", "file"],
    ["Cafe\u0301.png", "Café.png"],
  ])("%j becomes %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("caps the name at 200 characters without splitting surrogate pairs", () => {
    const name = sanitizeFilename("😀".repeat(250));
    expect(Array.from(name)).toHaveLength(200);
    expect(name).toBe("😀".repeat(200));
  });

  it("keeps quotes for display; headers escape them separately", () => {
    expect(sanitizeFilename('my "best" photo.png')).toBe('my "best" photo.png');
  });
});

describe("contentDisposition", () => {
  it("adds an ASCII fallback and an RFC 5987 UTF-8 name", () => {
    expect(contentDisposition("inline", "naïve café.png")).toBe(
      "inline; filename=\"na_ve caf_.png\"; filename*=UTF-8''na%C3%AFve%20caf%C3%A9.png",
    );
  });

  it("neutralises quotes, backslashes, percent signs and line breaks", () => {
    const header = contentDisposition("attachment", 'a"b\\c%41\r\nX-Evil: 1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="')).toBe(true);
    const fallback = /filename="([^"]*)"/.exec(header)?.[1];
    expect(fallback).toBe("c_41X-Evil: 1.pdf");
    expect(header).toContain("filename*=UTF-8''c%2541X-Evil%3A%201.pdf");
  });

  it("encodes the RFC 5987 reserved characters", () => {
    expect(contentDisposition("inline", "it's (1)*.png")).toContain(
      "filename*=UTF-8''it%27s%20%281%29%2A.png",
    );
  });

  it("produces a header value the Headers class accepts for hostile names", () => {
    for (const name of ["../../../etc/passwd", "..\\..\\x.png", 'x"\r\n.png', "\u0000"]) {
      const value = contentDisposition("inline", name);
      expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
    }
  });
});

describe("mediaResponseHeaders", () => {
  it("serves images inline and PDFs as attachments with locked-down headers", () => {
    const image = mediaResponseHeaders(
      { contentType: "image/png", originalFilename: "a.png" },
      true,
    );
    const doc = mediaResponseHeaders(
      { contentType: "application/pdf", originalFilename: "a.pdf" },
      false,
    );
    expect(image.get("content-disposition")?.startsWith("inline;")).toBe(true);
    expect(doc.get("content-disposition")?.startsWith("attachment;")).toBe(true);
    for (const headers of [image, doc]) {
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    }
    expect(doc.get("cache-control")).toBe("private, no-store");
  });
});

describe("buildStorageKey", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("uses the UTC year and month, the id and the extension", () => {
    expect(buildStorageKey(new Date("2030-03-31T23:30:00-02:00"), id, "png")).toBe(
      `media/2030/04/${id}.png`,
    );
  });

  it("refuses anything that is not a server-generated id or a known extension", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(() => buildStorageKey(now, "../../etc/passwd", "png")).toThrow();
    expect(() => buildStorageKey(now, id, "html")).toThrow();
    expect(() => buildStorageKey(now, id, "png/../../x")).toThrow();
  });
});

describe("sniffMediaType", () => {
  it.each([
    ["JPEG", files.jpeg(), { mime: "image/jpeg", ext: "jpg" }],
    ["PNG", files.png(), { mime: "image/png", ext: "png" }],
    ["WebP", files.webp(), { mime: "image/webp", ext: "webp" }],
    ["GIF", files.gif(), { mime: "image/gif", ext: "gif" }],
    ["PDF", files.pdf(), { mime: "application/pdf", ext: "pdf" }],
  ])("detects %s from its bytes", async (_label, bytes, expected) => {
    expect(await sniffMediaType(bytes)).toEqual(expected);
  });

  it.each([
    ["HTML", files.html()],
    ["SVG", files.svg()],
    ["XML-declared SVG", files.xmlSvg()],
    ["empty", new Uint8Array()],
    ["plain text", new TextEncoder().encode("just some words")],
  ])("rejects %s", async (_label, bytes) => {
    expect(await sniffMediaType(bytes)).toBeNull();
  });
});

describe("readImageDimensions", () => {
  it("reads PNG, JPEG, GIF and WebP headers", () => {
    expect(readImageDimensions(files.png(3, 2), "image/png")).toEqual({ width: 3, height: 2 });
    expect(readImageDimensions(files.jpeg(640, 480), "image/jpeg")).toEqual({
      width: 640,
      height: 480,
    });
    expect(readImageDimensions(files.gif(16, 9), "image/gif")).toEqual({ width: 16, height: 9 });
    expect(readImageDimensions(files.webp(800, 600), "image/webp")).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("returns null for truncated or malformed headers", () => {
    expect(readImageDimensions(files.png().subarray(0, 20), "image/png")).toBeNull();
    expect(readImageDimensions(files.jpeg().subarray(0, 12), "image/jpeg")).toBeNull();
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0x00, 0x00]), "image/jpeg")).toBeNull();
    expect(readImageDimensions(files.webp().subarray(0, 16), "image/webp")).toBeNull();
  });
});
