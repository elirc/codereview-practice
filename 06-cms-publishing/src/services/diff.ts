export type DiffLine = {
  kind: "same" | "added" | "removed";
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
};

// Upper bound on the LCS table (cells, 4 bytes each) before falling back to replace-all.
const MAX_TABLE_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Line diff of two texts using a longest-common-subsequence table. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let endA = a.length;
  let endB = b.length;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) lines.push(same(a[i], i, i));
  lines.push(...diffRange(a, b, prefix, endA, prefix, endB));
  for (let i = endA, j = endB; i < a.length; i++, j++) lines.push(same(a[i], i, j));
  return lines;
}

function diffRange(
  a: string[],
  b: string[],
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): DiffLine[] {
  const n = endA - startA;
  const m = endB - startB;
  const out: DiffLine[] = [];

  if (n * m > MAX_TABLE_CELLS) {
    for (let i = startA; i < endA; i++) out.push(removed(a[i], i));
    for (let j = startB; j < endB; j++) out.push(added(b[j], j));
    return out;
  }

  // table[i * width + j] = LCS length of a[startA + i..endA) and b[startB + j..endB)
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[startA + i] === b[startB + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[startA + i] === b[startB + j]) {
      out.push(same(a[startA + i], startA + i, startB + j));
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push(removed(a[startA + i], startA + i));
      i++;
    } else {
      out.push(added(b[startB + j], startB + j));
      j++;
    }
  }
  for (; i < n; i++) out.push(removed(a[startA + i], startA + i));
  for (; j < m; j++) out.push(added(b[startB + j], startB + j));
  return out;
}

function same(text: string, oldIndex: number, newIndex: number): DiffLine {
  return { kind: "same", text, oldNumber: oldIndex + 1, newNumber: newIndex + 1 };
}

function removed(text: string, oldIndex: number): DiffLine {
  return { kind: "removed", text, oldNumber: oldIndex + 1, newNumber: null };
}

function added(text: string, newIndex: number): DiffLine {
  return { kind: "added", text, oldNumber: null, newNumber: newIndex + 1 };
}
