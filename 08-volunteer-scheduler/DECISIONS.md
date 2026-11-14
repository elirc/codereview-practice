# Decisions

Choices made where the spec left room for interpretation.

## Recurrence candidate cap

**Unclear:** the 1,000-candidate cap would make a long-running uncounted series (for example a daily series that started three years ago) generate nothing for today's horizon if candidates were always counted from `dtstart`.
**Chosen:** when a rule has no `count`, generation starts at the period containing `rangeStart` (keeping the interval phase), so the cap bounds the work inside the requested range. Rules with a `count` always walk from `dtstart`, since the count is defined from there. A month without the requested day still counts as one examined candidate, which keeps impossible rules bounded.
