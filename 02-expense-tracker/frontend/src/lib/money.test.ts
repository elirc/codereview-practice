import { describe, expect, it } from "vitest";

import { formatMinor, formatMoney, parseMinor } from "./money";

describe("parseMinor", () => {
  it("parses whole units for exponent 0", () => {
    expect(parseMinor("1000", 0)).toEqual({ ok: true, minor: 1000 });
    expect(parseMinor(" 42 ", 0)).toEqual({ ok: true, minor: 42 });
  });

  it("rejects any fractional digits for exponent 0", () => {
    expect(parseMinor("1000.5", 0).ok).toBe(false);
    expect(parseMinor("1000.0", 0).ok).toBe(false);
  });

  it("parses cents for exponent 2", () => {
    expect(parseMinor("12.34", 2)).toEqual({ ok: true, minor: 1234 });
    expect(parseMinor("12.3", 2)).toEqual({ ok: true, minor: 1230 });
    expect(parseMinor("12", 2)).toEqual({ ok: true, minor: 1200 });
    expect(parseMinor("0.07", 2)).toEqual({ ok: true, minor: 7 });
    expect(parseMinor("0.1", 2)).toEqual({ ok: true, minor: 10 });
  });

  it("avoids floating point drift", () => {
    expect(parseMinor("0.29", 2)).toEqual({ ok: true, minor: 29 });
    expect(parseMinor("1.15", 2)).toEqual({ ok: true, minor: 115 });
    expect(parseMinor("4.35", 2)).toEqual({ ok: true, minor: 435 });
  });

  it("rejects more than two decimals for exponent 2", () => {
    const result = parseMinor("12.345", 2);
    expect(result.ok).toBe(false);
  });

  it("parses fils for exponent 3", () => {
    expect(parseMinor("1.500", 3)).toEqual({ ok: true, minor: 1500 });
    expect(parseMinor("1.5", 3)).toEqual({ ok: true, minor: 1500 });
    expect(parseMinor("0.001", 3)).toEqual({ ok: true, minor: 1 });
  });

  it("rejects more than three decimals for exponent 3", () => {
    expect(parseMinor("1.5001", 3).ok).toBe(false);
  });

  it("accepts thousands separators", () => {
    expect(parseMinor("1,234.56", 2)).toEqual({ ok: true, minor: 123456 });
    expect(parseMinor("150,000", 0)).toEqual({ ok: true, minor: 150000 });
    expect(parseMinor("2,500.750", 3)).toEqual({ ok: true, minor: 2500750 });
  });

  it("rejects malformed and negative input", () => {
    for (const input of ["", "abc", "-5", "1e3", ".5", "1.2.3"]) {
      expect(parseMinor(input, 2).ok).toBe(false);
    }
  });

  it("rejects amounts beyond safe integer precision", () => {
    expect(parseMinor("99999999999999.99", 2).ok).toBe(false);
  });
});

describe("formatMinor", () => {
  it("formats exponent 0 without a decimal point", () => {
    expect(formatMinor(1000, 0)).toBe("1000");
  });

  it("formats exponent 2 with padding", () => {
    expect(formatMinor(670, 2)).toBe("6.70");
    expect(formatMinor(7, 2)).toBe("0.07");
    expect(formatMinor(0, 2)).toBe("0.00");
  });

  it("formats exponent 3", () => {
    expect(formatMinor(1500, 3)).toBe("1.500");
    expect(formatMinor(1, 3)).toBe("0.001");
  });

  it("formats negative amounts", () => {
    expect(formatMinor(-1234, 2)).toBe("-12.34");
  });

  it("round-trips with parseMinor", () => {
    const cases: Array<[string, number]> = [
      ["6.70", 2],
      ["1.500", 3],
      ["1000", 0],
    ];
    for (const [text, exponent] of cases) {
      const parsed = parseMinor(text, exponent);
      expect(parsed.ok && formatMinor(parsed.minor, exponent)).toBe(text);
    }
  });

  it("refuses non-integer input", () => {
    expect(() => formatMinor(1.5, 2)).toThrow();
  });
});

describe("formatMoney", () => {
  it("appends the currency code", () => {
    expect(formatMoney(488, "USD", 2)).toBe("4.88 USD");
  });
});
