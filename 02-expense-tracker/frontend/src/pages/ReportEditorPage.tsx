import { useMutation } from "@tanstack/react-query";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import { ApiError, apiSend, apiSendNoContent, query } from "../api/client";
import { useMoney } from "../api/currencies";
import {
  lineReceiptUrl,
  postReport,
  uploadReceipt,
  useReport,
  useReportAction,
} from "../api/reports";
import { reportDetailSchema, type Line, type ReportDetail } from "../api/schemas";
import { useMe } from "../auth/AuthProvider";
import { ActionError } from "../components/ActionError";
import { ErrorMessage } from "../components/ErrorMessage";
import { LineForm, type LineInput } from "../components/LineForm";

function flaggedLineIds(error: unknown): Set<string> {
  if (error instanceof ApiError && Array.isArray(error.details.line_ids)) {
    return new Set(error.details.line_ids as string[]);
  }
  return new Set();
}

function lineBody(report: ReportDetail, input: LineInput, receiptId: string | undefined) {
  return {
    expected_version: report.version,
    expense_date: input.expense_date,
    category: input.category,
    description: input.description,
    amount_minor: input.amount_minor,
    currency: input.currency,
    ...(receiptId ? { receipt_id: receiptId } : {}),
  };
}

export function ReportEditorPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const money = useMoney();
  const report = useReport(id);
  const action = useReportAction(id);
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => apiSendNoContent("DELETE", `/reports/${id}`),
    onSuccess: () => navigate("/"),
  });

  if (report.isPending || money.currencies.length === 0) {
    return <p>Loading…</p>;
  }
  if (report.error) {
    return <ErrorMessage error={report.error} />;
  }
  const current = report.data;
  if (!current.can.edit) {
    return <Navigate to={`/reports/${id}`} replace />;
  }
  const flagged = flaggedLineIds(action.error);
  const editing = current.lines.find((line) => line.id === editingLine);
  const linePath = (line: Line) => `/reports/${id}/lines/${line.id}`;

  const saveLine = (input: LineInput, line?: Line) => {
    action.mutate(
      async () => {
        const receiptId = input.file ? (await uploadReceipt(input.file)).id : undefined;
        const body = lineBody(current, input, receiptId);
        return line
          ? apiSend("PATCH", linePath(line), reportDetailSchema, body)
          : postReport(`/reports/${id}/lines`, body);
      },
      { onSuccess: () => setEditingLine(null) },
    );
  };

  const removeLine = (line: Line) => {
    const path = `${linePath(line)}${query({ expected_version: current.version })}`;
    action.mutate(() => apiSend("DELETE", path, reportDetailSchema));
  };

  const setReceipt = (line: Line, receiptId: string | null) =>
    apiSend("PUT", `${linePath(line)}/receipt`, reportDetailSchema, {
      expected_version: current.version,
      receipt_id: receiptId,
    });

  const attachReceipt = (line: Line, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    action.mutate(async () => setReceipt(line, (await uploadReceipt(file)).id));
  };

  const detachReceipt = (line: Line) => {
    action.mutate(() => setReceipt(line, null));
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    const body = { expected_version: current.version, title: (title ?? current.title).trim() };
    action.mutate(() => apiSend("PATCH", `/reports/${id}`, reportDetailSchema, body), {
      onSuccess: () => setTitle(null),
    });
  };

  const submit = () => {
    const body = { expected_version: current.version };
    action.mutate(() => postReport(`/reports/${id}/submit`, body), {
      onSuccess: () => navigate(`/reports/${id}`),
    });
  };

  return (
    <main>
      <h1>Edit report</h1>
      <p>
        <Link to={`/reports/${id}`}>View details and history</Link>
      </p>
      <form className="inline" onSubmit={rename}>
        <label>
          Title
          <input
            value={title ?? current.title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <button type="submit" disabled={action.isPending}>
          Rename
        </button>
      </form>
      <ActionError error={action.error} />

      <h2>Lines</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Category</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Estimated ({current.base_currency})</th>
            <th>Receipt</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {current.lines.map((line) => (
            <tr key={line.id} className={flagged.has(line.id) ? "flagged" : undefined}>
              <td>{line.expense_date}</td>
              <td>{line.category}</td>
              <td>{line.description}</td>
              <td>{money.format(line.amount_minor, line.currency)}</td>
              <td>{money.format(line.estimated_base_minor, current.base_currency)}</td>
              <td>
                {line.receipt ? (
                  <>
                    <a href={lineReceiptUrl(id, line.id)}>
                      {line.receipt.original_filename || "receipt"}
                    </a>
                    <button
                      type="button"
                      disabled={action.isPending}
                      onClick={() => detachReceipt(line)}
                    >
                      Remove receipt
                    </button>
                  </>
                ) : (
                  <label>
                    {line.needs_receipt ? "Required" : "Optional"}
                    <input
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      onChange={(e) => attachReceipt(line, e)}
                    />
                  </label>
                )}
              </td>
              <td>
                <button type="button" onClick={() => setEditingLine(line.id)}>
                  Edit
                </button>
                <button type="button" onClick={() => removeLine(line)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Estimated total: {money.format(current.estimated_total_base_minor, current.base_currency)}
      </p>

      {editing && (
        <section>
          <h3>Edit line</h3>
          <LineForm
            key={editing.id}
            initial={editing}
            defaultCurrency={me.base_currency}
            submitLabel="Save line"
            busy={action.isPending}
            onSubmit={(input) => saveLine(input, editing)}
            onCancel={() => setEditingLine(null)}
          />
        </section>
      )}

      <h3>Add a line</h3>
      <LineForm
        key={current.lines.length}
        defaultCurrency={me.base_currency}
        submitLabel="Add line"
        busy={action.isPending}
        onSubmit={(input) => saveLine(input)}
      />

      <h2>Submit</h2>
      <button type="button" disabled={action.isPending} onClick={submit}>
        Submit for approval
      </button>
      {current.round === 0 && (
        <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Delete draft
        </button>
      )}
      <ErrorMessage error={remove.error} />
    </main>
  );
}
