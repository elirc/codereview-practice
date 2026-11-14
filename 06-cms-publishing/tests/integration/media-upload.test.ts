import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/media/route";
import { db } from "@/db/client";
import { media } from "@/db/schema";
import { MAX_UPLOAD_BYTES, ingestUpload } from "@/media/upload";
import { UUID_SOURCE } from "@/services/media-references";
import * as files from "../fixtures/files";
import { FIXED_NOW, createTestUser, signInAs } from "./support/fixtures";
import { memoryStorage, streamedUploadRequest, uploadRequest } from "./support/media";

const KEY_SHAPE = new RegExp(`^media/2030/01/${UUID_SOURCE}\\.(jpg|png|webp|gif|pdf)$`);

async function signedIn() {
  const author = await createTestUser("author");
  await signInAs(author);
  return author;
}

async function json(response: Response) {
  return (await response.json()) as {
    data?: { id: string; contentType: string; originalFilename: string; width: number | null };
    error?: { code: string };
  };
}

describe("POST /api/media", () => {
  it("stores an image under a generated key with sniffed metadata", async () => {
    const author = await signedIn();

    const response = await POST(uploadRequest(files.png(3, 2), "holiday.png"));

    expect(response.status).toBe(201);
    const { data } = await json(response);
    const [row] = await db.select().from(media);
    expect(row).toMatchObject({
      id: data?.id,
      contentType: "image/png",
      originalFilename: "holiday.png",
      width: 3,
      height: 2,
      uploadedBy: author.id,
      sizeBytes: files.png().length,
    });
    expect(row.storageKey).toMatch(KEY_SHAPE);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(memoryStorage().objects.get(row.storageKey)?.contentType).toBe("image/png");
  });

  it("trusts the bytes, not the filename: a PNG named x.pdf is stored as PNG", async () => {
    await signedIn();
    const response = await POST(uploadRequest(files.png(), "x.pdf"));

    expect(response.status).toBe(201);
    const [row] = await db.select().from(media);
    expect(row.contentType).toBe("image/png");
    expect(row.storageKey.endsWith(".png")).toBe(true);
    expect(row.originalFilename).toBe("x.pdf");
  });

  it.each([
    ["HTML disguised as photo.jpg", files.html(), "photo.jpg"],
    ["SVG", files.svg(), "logo.svg"],
    ["XML SVG", files.xmlSvg(), "logo.png"],
    ["plain text", new TextEncoder().encode("hello"), "notes.gif"],
  ])("rejects %s with 415", async (_label, bytes, filename) => {
    await signedIn();
    const response = await POST(uploadRequest(bytes, filename));

    expect(response.status).toBe(415);
    expect((await json(response)).error?.code).toBe("unsupported_media_type");
    expect(await db.select().from(media)).toEqual([]);
    expect(memoryStorage().objects.size).toBe(0);
  });

  it("accepts exactly 10 MiB sent as a chunked stream", async () => {
    await signedIn();
    const exact = files.padTo(files.png(), MAX_UPLOAD_BYTES);

    const response = await POST(streamedUploadRequest(exact, "big.png"));

    expect(response.status).toBe(201);
    const [row] = await db.select().from(media);
    expect(row.sizeBytes).toBe(MAX_UPLOAD_BYTES);
  });

  it("rejects one byte over 10 MiB sent as a chunked stream", async () => {
    await signedIn();
    const tooBig = files.padTo(files.png(), MAX_UPLOAD_BYTES + 1);

    const response = await POST(streamedUploadRequest(tooBig, "big.png"));

    expect(response.status).toBe(413);
    expect((await json(response)).error?.code).toBe("file_too_large");
    expect(memoryStorage().objects.size).toBe(0);
  });

  it("stops reading a much larger stream at the limit", async () => {
    await signedIn();
    const huge = files.padTo(files.png(), MAX_UPLOAD_BYTES * 2);

    const response = await POST(streamedUploadRequest(huge, "huge.png"));

    expect(response.status).toBe(413);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    await signedIn();
    const request = uploadRequest(files.png(), "small.png", {
      "content-length": String(MAX_UPLOAD_BYTES * 3),
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
  });

  it("keeps hostile filenames out of the storage key", async () => {
    await signedIn();
    for (const name of ["../../../etc/passwd", "..\\..\\x.png"]) {
      const response = await POST(uploadRequest(files.gif(), name));
      expect(response.status).toBe(201);
    }

    const rows = await db.select().from(media);
    expect(rows.map((row) => row.originalFilename).sort()).toEqual(["passwd", "x.png"]);
    for (const row of rows) expect(row.storageKey).toMatch(KEY_SHAPE);
  });

  it("requires a session", async () => {
    const response = await POST(uploadRequest(files.png(), "a.png"));
    expect(response.status).toBe(401);
    expect(memoryStorage().calls).toEqual([]);
  });

  it("refuses cross-site requests", async () => {
    await signedIn();
    const response = await POST(
      uploadRequest(files.png(), "a.png", { origin: "https://evil.example", host: "localhost" }),
    );
    expect(response.status).toBe(403);
  });

  it("requires a file field", async () => {
    await signedIn();
    const form = new FormData();
    form.append("other", "value");
    const response = await POST(
      new Request("http://localhost/api/media", { method: "POST", body: form }),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error?.code).toBe("validation_failed");
  });
});

describe("ingestUpload", () => {
  it("removes the stored object when the database insert fails", async () => {
    const missingUser = randomUUID();

    await expect(
      ingestUpload({ filename: "a.png", bytes: files.png() }, missingUser, {
        storage: memoryStorage(),
        now: new Date(FIXED_NOW),
        newId: randomUUID,
      }),
    ).rejects.toMatchObject({ code: "23503" });

    expect(memoryStorage().calls.map((call) => call.op)).toEqual(["put", "delete"]);
    expect(memoryStorage().objects.size).toBe(0);
    expect(await db.select().from(media)).toEqual([]);
  });
});
