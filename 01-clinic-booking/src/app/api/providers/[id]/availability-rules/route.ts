import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { createRuleBody } from "@/server/schemas";
import { serializeRule } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { createRule, listRules } from "@/services/availability";

export const GET = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const rules = await listRules(actor, parseId(params.id, "Provider"));
  return json({ rules: rules.map(serializeRule) });
});

export const POST = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const providerId = parseId(params.id, "Provider");
  const input = await readJson(req, createRuleBody);
  const result = await createRule(actor, providerId, input, clock.now());
  return json(
    { rule: serializeRule(result.rule), affectedAppointments: result.affectedAppointments },
    201,
  );
});
