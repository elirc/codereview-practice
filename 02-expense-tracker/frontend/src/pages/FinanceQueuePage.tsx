import { useQuery } from "@tanstack/react-query";

import { apiGet, query } from "../api/client";
import { paginated, reportSummarySchema } from "../api/schemas";
import { ErrorMessage } from "../components/ErrorMessage";
import { ReportTable } from "../components/ReportTable";

export function FinanceQueuePage() {
  const approved = useQuery({
    queryKey: ["reports", "finance-queue"],
    queryFn: () =>
      apiGet(
        `/reports${query({ owner: "all", status: "approved", limit: 200 })}`,
        paginated(reportSummarySchema),
      ),
  });

  return (
    <main>
      <h1>Awaiting reimbursement</h1>
      <p className="muted">Approved reports. Open one to record the payment reference.</p>
      <ErrorMessage error={approved.error} />
      {approved.data && <ReportTable reports={approved.data.items} />}
    </main>
  );
}
