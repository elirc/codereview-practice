import { deleteMedia } from "@/actions/media";
import { requirePageUser } from "@/auth/page-guards";
import { mediaDeleteRefusal } from "@/auth/policy";
import { listMediaLibrary } from "@/services/media";
import { ActionButton } from "../_components/action-button";
import { MediaUpload } from "../_components/media-upload";
import { formatBytes, formatInstant } from "../format";

export const metadata = { title: "Media" };

export default async function MediaPage() {
  const user = await requirePageUser();
  const items = await listMediaLibrary();

  return (
    <>
      <h1>Media</h1>
      <p className="muted">
        JPEG, PNG, WebP, GIF or PDF up to 10 MiB. Reference a file in a post body as
        <code> ![alt](media:&lt;id&gt;)</code>.
      </p>
      <MediaUpload />
      <div className="media-grid">
        {items.map((item) => {
          const refusal = mediaDeleteRefusal(user, item);
          return (
            <figure key={item.id}>
              {item.contentType.startsWith("image/") ? (
                <img src={`/media/${item.id}`} alt={item.originalFilename} loading="lazy" />
              ) : (
                <a href={`/media/${item.id}`}>Download PDF</a>
              )}
              <figcaption>
                <div>{item.originalFilename}</div>
                <div className="muted">
                  {formatBytes(item.sizeBytes)}
                  {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
                </div>
                <div className="muted">
                  {item.uploaderName}, {formatInstant(item.createdAt)}
                </div>
                <code>media:{item.id}</code>
                <div>
                  {item.referencedByLiveRevision
                    ? "Used by a live or scheduled post"
                    : item.referencedByAnyRevision
                      ? "Used by a draft revision"
                      : "Not used"}
                </div>
                {refusal === null && (
                  <ActionButton
                    label="Delete"
                    action={deleteMedia}
                    input={{ mediaId: item.id }}
                    confirmMessage={`Delete ${item.originalFilename}?`}
                  />
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {items.length === 0 && <p className="muted">No media yet.</p>}
    </>
  );
}
