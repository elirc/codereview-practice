import { invalidatePost } from "@/cache/invalidate";
import { getEnv } from "@/env";
import { isValidBearer } from "@/http/cron-auth";
import { errorResponse } from "@/http/errors";
import { getRequestId } from "@/http/request-id";
import { logger } from "@/logger";
import { clock } from "@/services/clock";
import { DomainError } from "@/services/errors";
import { publishDuePosts } from "@/services/scheduled-publishing";

export const dynamic = "force-dynamic";

const JOB = "publish-scheduled";

export async function POST(request: Request) {
  const requestId = await getRequestId();
  if (!isValidBearer(request.headers.get("authorization"), getEnv().CRON_SECRET)) {
    return errorResponse(
      new DomainError("unauthenticated", "Missing or invalid cron credentials."),
      requestId,
    );
  }

  const log = logger.child({ job: JOB, jobId: requestId });
  log.info("job started");
  try {
    let batch = 0;
    const published = await publishDuePosts({
      now: clock.now(),
      onBatchCommitted: (changes) => {
        batch += 1;
        for (const change of changes) invalidatePost(change);
        log.info({ batch, postIds: changes.map((change) => change.id) }, "batch published");
      },
    });
    log.info({ published: published.length }, "job finished");
    return Response.json({ published }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, requestId, { job: JOB, jobId: requestId, event: "job failed" });
  }
}
