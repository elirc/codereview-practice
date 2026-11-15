import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { apiGet, apiSend } from "../api/client";
import { useMoney } from "../api/currencies";
import {
  bulkApproveResultSchema,
  paginated,
  pendingApprovalSchema,
  type PendingApproval,
} from "../api/schemas";
import { useMe } from "../auth/AuthProvider";
import { ActionError } from "../components/ActionError";
import { ErrorMessage } from "../components/ErrorMessage";

function approvalItem(item: PendingApproval) {
  return {
    report_id: item.id,
    step_id: item.current_step_id,
    expected_version: item.version,
  };
}

export function ApprovalsPage() {
  const me = useMe();
  const money = useMoney();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pending = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => apiGet("/approvals/pending", paginated(pendingApprovalSchema)),
  });
  const approve = useMutation({
    mutationFn: (items: PendingApproval[]) =>
      apiSend("POST", "/approvals/approve", bulkApproveResultSchema, {
        items: items.map(approvalItem),
      }),
    onSuccess: () => setSelected(new Set()),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
  });

  const items = pending.data?.items ?? [];
  const chosen = items.filter((item) => selected.has(item.id));
  const chosenTotal = chosen.reduce((sum, item) => sum + (item.total_base_minor ?? 0), 0);

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <main>
      <h1>Awaiting my decision</h1>
      <ErrorMessage error={pending.error} />
      {pending.data && items.length === 0 && <p>Nothing is waiting for you.</p>}
      {items.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th />
                <th>Report</th>
                <th>Owner</th>
                <th>Step</th>
                <th>Total</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.title}`}
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                  </td>
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
          <p>
            {chosen.length} selected, {(chosenTotal / 100).toFixed(2)} {me.base_currency}
          </p>
          <button
            type="button"
            disabled={chosen.length === 0 || approve.isPending}
            onClick={() => approve.mutate(chosen)}
          >
            Approve selected
          </button>
          <ActionError error={approve.error} />
        </>
      )}
    </main>
  );
}
