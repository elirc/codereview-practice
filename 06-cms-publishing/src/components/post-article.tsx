type Props = {
  title: string;
  excerpt: string;
  coverMediaId: string | null;
  html: string;
  publishedAt: string | null;
};

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });

/** A rendered post. `html` must come from `renderMarkdown`, which sanitises it. */
export function PostArticle({ title, excerpt, coverMediaId, html, publishedAt }: Props) {
  return (
    <article>
      <h1>{title}</h1>
      {publishedAt && (
        <p className="muted">
          <time dateTime={publishedAt}>{dateFormat.format(new Date(publishedAt))}</time>
        </p>
      )}
      {excerpt && <p>{excerpt}</p>}
      {coverMediaId && <img src={`/media/${coverMediaId}`} alt="" />}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
