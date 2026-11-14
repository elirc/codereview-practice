import { Link } from "react-router-dom";

import { useMoney } from "../api/currencies";
import type { ReportSummary } from "../api/schemas";

export function reportPath(report: ReportSummary, ownerView: boolean): string {
  return ownerView && report.status === "draft"
    ? `/reports/${report.id}/edit`
    : `/reports/${report.id}`;
}

export function ReportTable({
  reports,
  ownerView = false,
}: {
  reports: ReportSummary[];
  ownerView?: boolean;
}) {
  const money = useMoney();
  if (reports.length === 0) {
    return <p>No reports.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Owner</th>
          <th>Status</th>
          <th>Round</th>
          <th>Total</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((report) => (
          <tr key={report.id}>
            <td>
              <Link to={reportPath(report, ownerView)}>{report.title}</Link>
            </td>
            <td>{report.owner.full_name}</td>
            <td>{report.status}</td>
            <td>{report.round}</td>
            <td>{money.format(report.total_base_minor, report.base_currency)}</td>
            <td>{new Date(report.updated_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
