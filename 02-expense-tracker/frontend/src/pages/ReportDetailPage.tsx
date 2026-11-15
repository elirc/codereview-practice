import { Link, useParams } from "react-router-dom";

import { useMoney } from "../api/currencies";
import { lineReceiptUrl, useReport } from "../api/reports";
import { useMe } from "../auth/AuthProvider";
import { AuditTrail } from "../components/AuditTrail";
import { ErrorMessage } from "../components/ErrorMessage";
import { ReassignPanel } from "../components/ReassignPanel";
import { ReportActions } from "../components/ReportActions";
import { StepTimeline } from "../components/StepTimeline";

export function ReportDetailPage() {
  const { id = "" } = useParams();
  const me = useMe();
  const money = useMoney();
  const report = useReport(id);

  if (report.isPending) {
    return <p>Loading…</p>;
  }
  if (report.error) {
    return <ErrorMessage error={report.error} />;
  }
  const current = report.data;
  const base = current.base_currency;
  const total = current.total_base_minor ?? current.estimated_total_base_minor;

  return (
    <main>
      <h1>{current.title}</h1>
      <dl>
        <dt>Owner</dt>
        <dd>{current.owner.full_name}</dd>
        <dt>Status</dt>
        <dd>{current.status}</dd>
        <dt>Round</dt>
        <dd>{current.round}</dd>
        <dt>Total</dt>
        <dd>{money.format(total, base)}</dd>
        {current.reimbursement && (
          <>
            <dt>Reimbursed</dt>
            <dd>{money.format(current.reimbursement.amount_base_minor, base)}</dd>
            <dt>Payment reference</dt>
            <dd>{current.reimbursement.payment_reference}</dd>
          </>
        )}
      </dl>
      {current.can.edit && <Link to={`/reports/${id}/edit`}>Edit draft</Link>}

      <h2>Lines</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Category</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Rate</th>
            <th>Rate date</th>
            <th>Base amount</th>
            <th>Receipt</th>
          </tr>
        </thead>
        <tbody>
          {current.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.expense_date}</td>
              <td>{line.category}</td>
              <td>{line.description}</td>
              <td>{money.format(line.amount_minor, line.currency)}</td>
              <td>{line.rate_used ?? "—"}</td>
              <td>{line.rate_effective_date ?? "—"}</td>
              <td>{money.format(line.base_amount_minor ?? line.estimated_base_minor, base)}</td>
              <td>
                {line.receipt ? (
                  <a href={lineReceiptUrl(current.id, line.id)}>
                    {line.receipt.original_filename || "receipt"}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ReportActions report={current} />
      {me.user.role === "admin" && <ReassignPanel report={current} />}

      <h2>Approval history</h2>
      <StepTimeline steps={current.steps} currentStepId={current.current_step_id} />

      <h2>Audit trail</h2>
      <AuditTrail reportId={current.id} />
    </main>
  );
}
