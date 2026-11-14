import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { apiGet } from "../api/client";
import { useMoney } from "../api/currencies";
import { paginated, pendingApprovalSchema } from "../api/schemas";
import { ErrorMessage } from "../components/ErrorMessage";

export function ApprovalsPage() {
  const money = useMoney();
  const pending = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => apiGet("/approvals/pending", paginated(pendingApprovalSchema)),
  });

  return (
    <main>
      <h1>Awaiting my decision</h1>
      <ErrorMessage error={pending.error} />
      {pending.data && pending.data.items.length === 0 && <p>Nothing is waiting for you.</p>}
      {pending.data && pending.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Report</th>
              <th>Owner</th>
              <th>Step</th>
              <th>Total</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {pending.data.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to={`/reports/${item.id}`}>{item.title}</Link>
                </td>
                <td>{item.owner.full_name}</td>
                <td>
                  {item.current_step_position}. {item.current_step_kind}
                </td>
                <td>{money.format(item.total_base_minor, item.base_currency)}</td>
                <td>{item.submitted_at ? new Date(item.submitted_at).toLocaleString() : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
