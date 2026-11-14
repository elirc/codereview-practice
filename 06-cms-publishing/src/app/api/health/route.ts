import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { errorResponse } from "@/http/errors";
import { getRequestId } from "@/http/request-id";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = await getRequestId();
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, requestId, { route: "GET /api/health" });
  }
}
