const IDENTIFIER = /^([A-Za-z]{2,6})-(\d+)$/;
const MAX_ISSUE_NUMBER = 2_147_483_647;

export interface IssueIdentifier {
  key: string;
  number: number;
}

export function formatIdentifier(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}

/**
 * Parses `KEY-n` case-insensitively. Returns null for anything else; numbers beyond the
 * column range parse but can never match a row.
 */
export function parseIdentifier(input: string): IssueIdentifier | null {
  const match = IDENTIFIER.exec(input);
  if (!match) return null;
  const number = Number(match[2]);
  return { key: match[1].toUpperCase(), number: Number.isSafeInteger(number) ? number : Infinity };
}

export function isStorableIssueNumber(number: number): boolean {
  return Number.isInteger(number) && number >= 1 && number <= MAX_ISSUE_NUMBER;
}
