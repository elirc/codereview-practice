import { isVersionConflict } from "../api/reports";
import { ErrorMessage } from "./ErrorMessage";

export function ActionError({ error }: { error: unknown }) {
  if (isVersionConflict(error)) {
    return (
      <p className="notice" role="alert">
        This report was changed by someone else. The latest version is shown; please try again.
      </p>
    );
  }
  return <ErrorMessage error={error} />;
}
