import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/preview/route";
import { loadPreview } from "@/services/preview";
import { createTestUser, signInAs, signOut } from "./support/fixtures";
import { requestContext } from "./support/request-context";
import { addRevision, makePost } from "./support/records";

function previewRequest(postId: string, revisionId: string): Request {
  return new Request(`http://localhost/api/preview?postId=${postId}&revisionId=${revisionId}`);
}

async function scene() {
  const owner = await createTestUser("author");
  const otherAuthor = await createTestUser("author");
  const editor = await createTestUser("editor");
  const post = await makePost(owner, "draft-preview");
  const { revision } = await addRevision(owner, post.id, {
    title: "Unpublished",
    body: "Draft <script>alert(1)</script> **text**",
  });
  return { owner, otherAuthor, editor, post, revision };
}

describe("GET /api/preview", () => {
  it("returns 404 without a session and leaves draft mode off", async () => {
    const { post, revision } = await scene();
    signOut();

    const response = await GET(previewRequest(post.id, revision.id));

    expect(response.status).toBe(404);
    expect(requestContext.draftMode.isEnabled).toBe(false);
  });

  it("returns 404 to an author who does not own the post", async () => {
    const { otherAuthor, post, revision } = await scene();
    await signInAs(otherAuthor);

    const response = await GET(previewRequest(post.id, revision.id));

    expect(response.status).toBe(404);
    expect(requestContext.draftMode.isEnabled).toBe(false);
  });

  it("returns 404 for a revision of a different post", async () => {
    const { owner, post } = await scene();
    const other = await makePost(owner, "another");
    await signInAs(owner);

    const response = await GET(previewRequest(post.id, other.latestRevisionId!));

    expect(response.status).toBe(404);
  });

  it("rejects malformed ids", async () => {
    const { owner } = await scene();
    await signInAs(owner);
    const response = await GET(previewRequest("not-a-uuid", "also-not"));
    expect(response.status).toBe(400);
  });

  it.each(["owner", "editor"] as const)(
    "enables draft mode and redirects for the %s",
    async (who) => {
      const actors = await scene();
      await signInAs(actors[who]);

      const response = await GET(previewRequest(actors.post.id, actors.revision.id));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `/preview/${actors.post.id}/${actors.revision.id}`,
      );
      expect(requestContext.draftMode.isEnabled).toBe(true);
    },
  );
});

describe("preview page loader", () => {
  it("renders the requested revision with the public sanitiser", async () => {
    const { owner, post, revision } = await scene();

    const preview = await loadPreview(owner, post.id, revision.id);

    expect(preview.revision.title).toBe("Unpublished");
    expect(preview.html).toContain("<strong>text</strong>");
    expect(preview.html).not.toContain("<script");
  });

  it("refuses an author who does not own the post", async () => {
    const { otherAuthor, post, revision } = await scene();
    await expect(loadPreview(otherAuthor, post.id, revision.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
