import type { Step } from "../api/schemas";

function byRound(steps: Step[]): Map<number, Step[]> {
  const rounds = new Map<number, Step[]>();
  for (const step of steps) {
    rounds.set(step.round, [...(rounds.get(step.round) ?? []), step]);
  }
  return rounds;
}

export function StepTimeline({
  steps,
  currentStepId,
}: {
  steps: Step[];
  currentStepId: string | null;
}) {
  if (steps.length === 0) {
    return <p className="muted">Not submitted yet.</p>;
  }
  return (
    <>
      {[...byRound(steps).entries()].map(([round, roundSteps]) => (
        <section key={round}>
          <h3>Round {round}</h3>
          <ol>
            {roundSteps.map((step) => (
              <li key={step.id}>
                <strong>{step.kind === "manager" ? step.approver?.full_name : "Finance"}</strong>
                {" — "}
                {step.status}
                {step.id === currentStepId && " (awaiting decision)"}
                {step.decided_by && ` by ${step.decided_by.full_name}`}
                {step.decided_at && ` on ${new Date(step.decided_at).toLocaleString()}`}
                {step.comment && <blockquote>{step.comment}</blockquote>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
