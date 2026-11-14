import { useQuery } from "@tanstack/react-query";

import { apiGet, query } from "../api/client";
import { auditEventSchema, paginated } from "../api/schemas";
import { ErrorMessage } from "./ErrorMessage";

function describeChange(change: Record<string, unknown> | null): string {
  return change ? JSON.stringify(change) : "";
}

export function AuditTrail({ reportId }: { reportId: string }) {
  const events = useQuery({
    queryKey: ["audit", reportId],
    queryFn: () =>
      apiGet(
        `/audit${query({ entity_type: "report", entity_id: reportId, limit: 200 })}`,
        paginated(auditEventSchema),
      ),
  });

  if (events.error) {
    return <ErrorMessage error={events.error} />;
  }
  if (!events.data) {
    return <p>Loading…</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Who</th>
          <th>Action</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {events.data.items.map((event) => (
          <tr key={event.id}>
            <td>{new Date(event.at).toLocaleString()}</td>
            <td>{event.actor?.full_name ?? "system"}</td>
            <td>{event.action}</td>
            <td>
              <code>{describeChange(event.before)}</code>
            </td>
            <td>
              <code>{describeChange(event.after)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
