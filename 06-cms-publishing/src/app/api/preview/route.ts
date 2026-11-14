import { draftMode } from "next/headers";
import { previewQuerySchema } from "@/actions/schemas";
import { getCurrentUser } from "@/auth/current-user";
import { errorResponse } from "@/http/errors";
import { getRequestId } from "@/http/request-id";
import { notFoundError } from "@/services/errors";
import { getRevisionForActor } from "@/services/revisions";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = await getRequestId();
  try {
    const url = new URL(request.url);
    const query = previewQuerySchema.parse(Object.fromEntries(url.searchParams));
    const actor = await getCurrentUser();
    if (!actor) throw notFoundError("Revision not found.");
    await getRevisionForActor(actor, query.postId, query.revisionId);

    (await draftMode()).enable();
    return new Response(null, {
      status: 307,
      headers: {
        Location: `/preview/${query.postId}/${query.revisionId}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err, requestId, { route: "GET /api/preview" });
  }
}
