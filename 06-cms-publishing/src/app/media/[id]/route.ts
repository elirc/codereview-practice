import { z } from "zod";
import { getCurrentUser } from "@/auth/current-user";
import { errorResponse } from "@/http/errors";
import { getRequestId } from "@/http/request-id";
import { mediaResponseHeaders } from "@/media/headers";
import { getMediaStorage } from "@/media/storage-provider";
import { notFoundError } from "@/services/errors";
import { findMediaById, isMediaPublic } from "@/services/media";

export const dynamic = "force-dynamic";

const mediaId = z.string().uuid();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = await getRequestId();
  try {
    const parsed = mediaId.safeParse((await params).id);
    if (!parsed.success) throw notFoundError("Media not found.");

    const record = await findMediaById(parsed.data.toLowerCase());
    if (!record) throw notFoundError("Media not found.");

    const isPublic = await isMediaPublic(record.id);
    if (!isPublic && !(await getCurrentUser())) throw notFoundError("Media not found.");

    const body = await getMediaStorage().get(record.storageKey);
    if (!body) throw notFoundError("Media not found.");
    return new Response(body, { status: 200, headers: mediaResponseHeaders(record, isPublic) });
  } catch (err) {
    return errorResponse(err, requestId, { route: "GET /media/[id]" });
  }
}
