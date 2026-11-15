import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";

import { apiGet, apiSend, query } from "../api/client";
import { useCurrencies } from "../api/currencies";
import { paginated, rateSchema, type Rate } from "../api/schemas";
import { useMe } from "../auth/AuthProvider";
import { ErrorMessage } from "../components/ErrorMessage";

const rateText = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,10})?$/, "Enter a rate such as 1.0825 (up to 10 decimals).")
  .refine((value) => /[1-9]/.test(value), "The rate must be greater than zero.");
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the effective date.");
const rateForm = z.object({ rate: rateText, effective_date: dateText });
const newRateForm = rateForm.extend({ from_currency: z.string().length(3, "Choose a currency.") });

function RateRow({ rate, onSaved }: { rate: Rate; onSaved: () => void }) {
  const [value, setValue] = useState(rate.rate);
  const [effective, setEffective] = useState(rate.effective_date);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { rate: string; effective_date: string }) =>
      apiSend("PATCH", `/exchange-rates/${rate.id}`, rateSchema, body),
    onSuccess: onSaved,
  });

  const submit = () => {
    const parsed = rateForm.safeParse({ rate: value, effective_date: effective });
    if (!parsed.success) {
      setProblem(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setProblem(null);
    save.mutate(parsed.data);
  };

  return (
    <tr>
      <td>{rate.from_currency}</td>
      <td>
        <input
          type="date"
          value={effective}
          disabled={rate.in_use}
          onChange={(e) => setEffective(e.target.value)}
        />
      </td>
      <td>
        <input value={value} disabled={rate.in_use} onChange={(e) => setValue(e.target.value)} />
      </td>
      <td>{rate.in_use ? "Used by a submitted report" : "Editable"}</td>
      <td>
        {!rate.in_use && (
          <button type="button" disabled={save.isPending} onClick={submit}>
            Save
          </button>
        )}
        {problem && <p className="error">{problem}</p>}
        <ErrorMessage error={save.error} />
      </td>
    </tr>
  );
}

export function RatesPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const currencies = useCurrencies();
  const [filter, setFilter] = useState("");
  const [currency, setCurrency] = useState("");
  const [effective, setEffective] = useState("");
  const [value, setValue] = useState("");
  const [inverse, setInverse] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const rates = useQuery({
    queryKey: ["rates", filter],
    queryFn: () =>
      apiGet(
        `/exchange-rates${query({ from_currency: filter, limit: 200 })}`,
        paginated(rateSchema),
      ),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["rates"] });
  const create = useMutation({
    mutationFn: (body: {
      from_currency: string;
      effective_date: string;
      rate: string;
      inverse: boolean;
    }) => apiSend("POST", "/exchange-rates", rateSchema, body),
    onSuccess: () => {
      setValue("");
      refresh();
    },
  });

  const foreign = (currencies.data ?? []).filter((c) => c.code !== me.base_currency);

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    const parsed = newRateForm.safeParse({
      from_currency: currency,
      effective_date: effective,
      rate: value,
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setProblem(null);
    create.mutate({ ...parsed.data, inverse });
  };

  return (
    <main>
      <h1>Exchange rates</h1>
      <p className="muted">
        One unit of the currency equals the rate in {me.base_currency}, from the effective date.
      </p>
      <form className="inline" onSubmit={onCreate}>
        <label>
          Currency
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">Choose</option>
            {foreign.map((c) => (
              <option key={c.code}>{c.code}</option>
            ))}
          </select>
        </label>
        <label>
          Effective date
          <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
        </label>
        <label>
          Rate
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={inverse} onChange={(e) => setInverse(e.target.checked)} />
          Quoted per 1 {me.base_currency}
        </label>
        <button type="submit" disabled={create.isPending}>
          Add rate
        </button>
      </form>
      {problem && <p className="error">{problem}</p>}
      <ErrorMessage error={create.error} />

      <label>
        Show
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All currencies</option>
          {foreign.map((c) => (
            <option key={c.code}>{c.code}</option>
          ))}
        </select>
      </label>
      <ErrorMessage error={rates.error} />
      <table>
        <thead>
          <tr>
            <th>Currency</th>
            <th>Effective date</th>
            <th>Rate</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rates.data?.items.map((rate) => (
            <RateRow key={`${rate.id}-${rate.updated_at}`} rate={rate} onSaved={refresh} />
          ))}
        </tbody>
      </table>
    </main>
  );
}
