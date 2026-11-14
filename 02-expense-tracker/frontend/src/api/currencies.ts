import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { formatMoney } from "../lib/money";
import { apiGet } from "./client";
import { currencySchema, type Currency } from "./schemas";

export function useCurrencies() {
  return useQuery({
    queryKey: ["currencies"],
    queryFn: () => apiGet("/currencies", z.array(currencySchema)),
    staleTime: Infinity,
  });
}

export type MoneyFormatter = {
  currencies: Currency[];
  exponentOf: (code: string) => number | undefined;
  format: (minor: number | null | undefined, code: string) => string;
};

export function useMoney(): MoneyFormatter {
  const { data } = useCurrencies();
  const currencies = data ?? [];
  const exponentOf = (code: string) => currencies.find((c) => c.code === code)?.exponent;
  const format = (minor: number | null | undefined, code: string) => {
    const exponent = exponentOf(code);
    if (minor === null || minor === undefined || exponent === undefined) {
      return "—";
    }
    return formatMoney(minor, code, exponent);
  };
  return { currencies, exponentOf, format };
}
