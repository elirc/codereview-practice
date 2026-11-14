import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { apiGet, apiSend, query } from "../api/client";
import { paginated, reportDetailSchema, reportSummarySchema } from "../api/schemas";
import { ErrorMessage } from "../components/ErrorMessage";
import { ReportTable } from "../components/ReportTable";

const STATUSES = ["", "draft", "submitted", "approved", "rejected", "reimbursed"];

export function MyReportsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [title, setTitle] = useState("");

  const reports = useQuery({
    queryKey: ["reports", "me", status],
    queryFn: () =>
      apiGet(`/reports${query({ owner: "me", status })}`, paginated(reportSummarySchema)),
  });

  const create = useMutation({
    mutationFn: (newTitle: string) =>
      apiSend("POST", "/reports", reportDetailSchema, { title: newTitle }),
    onSuccess: (report) => navigate(`/reports/${report.id}/edit`),
  });

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) {
      create.mutate(title.trim());
    }
  };

  return (
    <main>
      <h1>My reports</h1>
      <form className="inline" onSubmit={onCreate}>
        <label>
          New report title
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create
        </button>
      </form>
      <ErrorMessage error={create.error} />
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || "any"}
            </option>
          ))}
        </select>
      </label>
      <ErrorMessage error={reports.error} />
      {reports.data && <ReportTable reports={reports.data.items} ownerView />}
    </main>
  );
}
