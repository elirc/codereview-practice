import { useState } from "react";

import { postReport, useReportAction } from "../api/reports";
import type { ReportDetail } from "../api/schemas";
import { ActionError } from "./ActionError";

type Verb = "approve" | "reject";

export function ReportActions({ report }: { report: ReportDetail }) {
  const action = useReportAction(report.id);
  const [comment, setComment] = useState("");
  const [reference, setReference] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const { can } = report;
  const base = `/reports/${report.id}`;
  const version = { expected_version: report.version };

  if (!can.decide && !can.withdraw && !can.reopen && !can.reimburse) {
    return null;
  }

  const run = (path: string, body: object) => {
    setProblem(null);
    action.mutate(() => postReport(path, { ...version, ...body }), {
      onSuccess: () => {
        setComment("");
        setReference("");
      },
    });
  };

  const decide = (verb: Verb) => {
    const text = comment.trim();
    if (verb === "reject" && !text) {
      setProblem("Add a comment explaining the rejection.");
      return;
    }
    run(`${base}/steps/${report.current_step_id}/${verb}`, text ? { comment: text } : {});
  };

  const withdraw = () => run(`${base}/withdraw`, {});
  const reopen = () => run(`${base}/reopen`, {});

  const reimburse = () => {
    if (!reference.trim()) {
      setProblem("Enter the payment reference.");
      return;
    }
    run(`${base}/reimburse`, { payment_reference: reference.trim() });
  };

  return (
    <section>
      <h2>Actions</h2>
      {can.decide && (
        <div>
          <label>
            Comment (required to reject)
            <textarea
              value={comment}
              maxLength={1000}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <button type="button" disabled={action.isPending} onClick={() => decide("approve")}>
            Approve
          </button>
          <button type="button" disabled={action.isPending} onClick={() => decide("reject")}>
            Reject
          </button>
        </div>
      )}
      {can.withdraw && (
        <button type="button" disabled={action.isPending} onClick={withdraw}>
          Withdraw to draft
        </button>
      )}
      {can.reopen && (
        <button type="button" disabled={action.isPending} onClick={reopen}>
          Reopen as draft
        </button>
      )}
      {can.reimburse && (
        <div>
          <label>
            Payment reference
            <input
              value={reference}
              maxLength={64}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <button type="button" disabled={action.isPending} onClick={reimburse}>
            Mark reimbursed
          </button>
        </div>
      )}
      {problem && <p className="error">{problem}</p>}
      <ActionError error={action.error} />
    </section>
  );
}
