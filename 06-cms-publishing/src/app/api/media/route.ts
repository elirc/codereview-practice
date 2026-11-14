import { randomUUID } from "node:crypto";
import { requireUser } from "@/auth/current-user";
import { assertCan } from "@/auth/policy";
import { errorResponse } from "@/http/errors";
import { getRequestId } from "@/http/request-id";
import { assertSameOrigin } from "@/http/same-origin";
import { getMediaStorage } from "@/media/storage-provider";
import { ingestUpload, readUploadedFile } from "@/media/upload";
import { clock } from "@/services/clock";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = await getRequestId();
  try {
    const actor = await requireUser();
    assertCan(actor, "uploadMedia");
    assertSameOrigin(request);

    const file = await readUploadedFile(request);
    const record = await ingestUpload(file, actor.id, {
      storage: getMediaStorage(),
      now: clock.now(),
      newId: randomUUID,
    });

    return Response.json(
      {
        data: {
          id: record.id,
          originalFilename: record.originalFilename,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          width: record.width,
          height: record.height,
          sha256: record.sha256,
          createdAt: record.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, requestId, { route: "POST /api/media" });
  }
}
