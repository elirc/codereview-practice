import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { apiGet, query } from "../api/client";
import { postReport, useReportAction } from "../api/reports";
import { paginated, userSchema, type ReportDetail, type Step, type User } from "../api/schemas";
import { ActionError } from "./ActionError";

function ReassignRow({ report, step }: { report: ReportDetail; step: Step }) {
  const action = useReportAction(report.id);
  const [approverId, setApproverId] = useState("");
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => apiGet(`/users${query({ limit: 200 })}`, paginated(userSchema)),
  });
  const isCandidate = (user: User) =>
    user.active && user.role !== "employee" && user.id !== report.owner.id;
  const candidates = (users.data?.items ?? []).filter(isCandidate);

  const reassign = () => {
    const path = `/reports/${report.id}/steps/${step.id}/reassign`;
    action.mutate(() => postReport(path, { approver_id: approverId }));
  };

  return (
    <li>
      Step {step.position} (currently {step.approver?.full_name ?? "unassigned"})
      <select value={approverId} onChange={(e) => setApproverId(e.target.value)}>
        <option value="">Choose a new approver</option>
        {candidates.map((user) => (
          <option key={user.id} value={user.id}>
            {user.full_name} ({user.role})
          </option>
        ))}
      </select>
      <button type="button" disabled={!approverId || action.isPending} onClick={reassign}>
        Reassign
      </button>
      <ActionError error={action.error} />
    </li>
  );
}

/** Admin tool for pending manager steps whose approver can no longer act. */
export function ReassignPanel({ report }: { report: ReportDetail }) {
  if (report.status !== "submitted") {
    return null;
  }
  const isOpenManagerStep = (step: Step) =>
    step.round === report.round && step.kind === "manager" && step.status === "pending";
  const pending = report.steps.filter(isOpenManagerStep);
  if (pending.length === 0) {
    return null;
  }
  return (
    <section>
      <h2>Reassign approver</h2>
      <ul>
        {pending.map((step) => (
          <ReassignRow key={step.id} report={report} step={step} />
        ))}
      </ul>
    </section>
  );
}
