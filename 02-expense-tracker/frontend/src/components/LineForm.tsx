import { useState, type FormEvent } from "react";
import { z } from "zod";

import { useMoney } from "../api/currencies";
import { categorySchema, type Category, type Line } from "../api/schemas";
import { formatMinor, parseMinor } from "../lib/money";

export type LineInput = {
  expense_date: string;
  category: Category;
  description: string;
  amount_minor: number;
  currency: string;
  file: File | null;
};

const fieldsSchema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the expense date."),
  category: categorySchema,
  description: z.string().trim().min(1, "Describe the expense.").max(300),
  currency: z.string().length(3, "Choose a currency."),
});

type Props = {
  initial?: Line;
  defaultCurrency: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (input: LineInput) => void;
  onCancel?: () => void;
};

export function LineForm({
  initial,
  defaultCurrency,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: Props) {
  const money = useMoney();
  const [expenseDate, setExpenseDate] = useState(initial?.expense_date ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "travel");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? defaultCurrency);
  const [amount, setAmount] = useState(() => {
    const exponent = initial ? money.exponentOf(initial.currency) : undefined;
    return initial && exponent !== undefined ? formatMinor(initial.amount_minor, exponent) : "";
  });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const fields = fieldsSchema.safeParse({
      expense_date: expenseDate,
      category,
      description,
      currency,
    });
    if (!fields.success) {
      setError(fields.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    const exponent = money.exponentOf(currency);
    if (exponent === undefined) {
      setError("Unknown currency.");
      return;
    }
    const parsed = parseMinor(amount, exponent);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (parsed.minor <= 0) {
      setError("The amount must be greater than zero.");
      return;
    }
    setError(null);
    onSubmit({ ...fields.data, amount_minor: parsed.minor, file });
  };

  return (
    <form className="inline" onSubmit={handleSubmit}>
      <label>
        Date
        <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
      </label>
      <label>
        Category
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {categorySchema.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
      <label>
        Description
        <input
          value={description}
          maxLength={300}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        Amount
        <input
          inputMode="decimal"
          placeholder="1,234.56"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        Currency
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {money.currencies.map((c) => (
            <option key={c.code}>{c.code}</option>
          ))}
        </select>
      </label>
      <label>
        Receipt (PDF, JPEG or PNG)
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <button type="submit" disabled={busy}>
        {submitLabel}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
