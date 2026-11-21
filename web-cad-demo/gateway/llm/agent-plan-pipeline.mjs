/**
 * Explicit Planner -> Resolver -> Safety Gate boundary.
 * The model client is the Planner, this module coordinates the deterministic
 * stages, and the Controller remains the only Executor of CAD mutations.
 */
export function buildValidatedAgentPlan(rawPlan, { prompt = "", context = {}, validate, resolve }) {
  if (typeof validate !== "function") throw new Error("Agent plan safety gate is required.");
  if (typeof resolve !== "function") throw new Error("Agent plan resolver is required.");
  const validated = validate(rawPlan);
  const resolved = resolve(validated, context, prompt);
  return { ...resolved, prompt: String(prompt || "") };
}

export function reportAgentPlan(plan) {
  return {
    planId: plan?.planId || null,
    status: plan?.status || "rejected",
    allowed: plan?.allowed === true,
    stepCount: Array.isArray(plan?.steps) ? plan.steps.length : 0,
    questionCount: Array.isArray(plan?.questions) ? plan.questions.length : 0,
    summary: String(plan?.summary || "").slice(0, 1000),
  };
}
