import { describe, expect, it } from "vitest";
import { lineDiff, type DiffLine } from "@/services/diff";

function render(lines: DiffLine[]): string[] {
  const marks = { same: " ", added: "+", removed: "-" } as const;
  return lines.map((line) => `${marks[line.kind]}${line.text}`);
}

describe("lineDiff", () => {
  it("returns only unchanged lines for identical texts", () => {
    expect(render(lineDiff("a\nb\nc", "a\nb\nc"))).toEqual([" a", " b", " c"]);
  });

  it("handles empty inputs", () => {
    expect(lineDiff("", "")).toEqual([]);
    expect(render(lineDiff("", "x\ny"))).toEqual(["+x", "+y"]);
    expect(render(lineDiff("x\ny", ""))).toEqual(["-x", "-y"]);
  });

  it("finds insertions and deletions in the middle", () => {
    expect(render(lineDiff("a\nb\nc\nd", "a\nc\nx\nd"))).toEqual([" a", "-b", " c", "+x", " d"]);
  });

  it("represents a changed line as a removal followed by an addition", () => {
    expect(render(lineDiff("title\nold line\nend", "title\nnew line\nend"))).toEqual([
      " title",
      "-old line",
      "+new line",
      " end",
    ]);
  });

  it("keeps the longest common subsequence", () => {
    const result = lineDiff("a\nb\nc\nb\na", "b\na\nb\nc");
    expect(result.filter((line) => line.kind === "same")).toHaveLength(3);
  });

  it("numbers lines on both sides", () => {
    const result = lineDiff("a\nb", "a\nx\nb");
    expect(result).toEqual([
      { kind: "same", text: "a", oldNumber: 1, newNumber: 1 },
      { kind: "added", text: "x", oldNumber: null, newNumber: 2 },
      { kind: "same", text: "b", oldNumber: 2, newNumber: 3 },
    ]);
  });

  it("treats CRLF and LF line endings alike", () => {
    expect(render(lineDiff("a\r\nb", "a\nb"))).toEqual([" a", " b"]);
  });

  it("degrades to replace-all for very large changed regions", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
    const result = lineDiff(before, after);
    expect(result).toHaveLength(6000);
    expect(result[0].kind).toBe("removed");
    expect(result[5999].kind).toBe("added");
  });
});
