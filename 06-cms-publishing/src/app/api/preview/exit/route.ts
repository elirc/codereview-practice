import { draftMode } from "next/headers";
import { exitPreviewQuerySchema } from "@/actions/schemas";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = exitPreviewQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  (await draftMode()).disable();
  return new Response(null, {
    status: 307,
    headers: {
      Location: query.success && query.data.slug ? `/posts/${query.data.slug}` : "/",
      "Cache-Control": "no-store",
    },
  });
}
