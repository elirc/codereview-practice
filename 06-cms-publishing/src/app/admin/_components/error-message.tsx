import type { ErrorBody } from "@/http/errors";

type FieldError = { path: string; message: string };

export function ErrorMessage({ error }: { error: ErrorBody | null }) {
  if (!error) return null;
  const rawFields = error.details?.fields;
  const fields = Array.isArray(rawFields) ? (rawFields as FieldError[]) : [];
  const savedBy = error.details?.savedBy as { name: string } | null | undefined;

  return (
    <div role="alert" className="error">
      <p>
        {error.message}
        {error.code === "version_conflict" && savedBy && (
          <> Latest revision {String(error.details?.latestRevisionNumber)} by {savedBy.name}.</>
        )}
      </p>
      {fields.length > 0 && (
        <ul>
          {fields.map((field) => (
            <li key={field.path}>
              {field.path || "input"}: {field.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
