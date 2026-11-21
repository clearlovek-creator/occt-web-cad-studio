const MAX_QUESTIONS = 32;

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}
function valuesFrom(model, key) {
  return Array.isArray(model?.[key]) ? model[key].filter((item) => item && typeof item === "object") : [];
}
function candidateId(item, keys = ["id"]) {
  for (const key of keys) if (asText(item?.[key])) return asText(item[key]);
  return "";
}
function resolveFrom(value, candidates, keys, fieldPath, label, questions) {
  const text = asText(value);
  if (!text) return value;
  const exact = candidates.find((item) => keys.some((key) => asText(item?.[key]) === text));
  if (exact) return candidateId(exact, keys);
  const folded = candidates.find((item) => keys.some((key) => asText(item?.[key]).toLowerCase() === text.toLowerCase()));
  if (folded) return candidateId(folded, keys);
  questions.push({ questionId: `resolve-${questions.length + 1}`, fieldPath, prompt: `${label} ${text} 已不存在，请从当前工程中重新选择。`, selection: label === "Body" ? "body" : undefined, code: "ENTITY_NOT_FOUND", received: text });
  return text;
}
function addQuestion(questions, fieldPath, prompt, selection, code, received) {
  if (questions.some((item) => item.fieldPath === fieldPath)) return;
  questions.push({ questionId: `resolve-${questions.length + 1}`, fieldPath, prompt, ...(selection ? { selection } : {}), ...(code ? { code } : {}), ...(received !== undefined ? { received } : {}) });
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function topologyForBody(model, bodyId) {
  const body = valuesFrom(model, "bodies").find((item) => candidateId(item, ["bodyId", "id"]) === bodyId);
  if (body?.topology) return body.topology;
  const presentation = valuesFrom(model, "bodyPresentations").find((item) => candidateId(item, ["bodyId", "id"]) === bodyId);
  if (!presentation) return null;
  return {
    topologyRevision: presentation.topologyRevision,
    faceIds: unique(Array.isArray(presentation.triangleFaceIds) ? presentation.triangleFaceIds : []),
    edgeIds: unique(Array.isArray(presentation.edges) ? presentation.edges.map((edge) => edge?.edgeId) : []),
  };
}

export function resolveAgentPlan(plan, context = {}, prompt = "") {
  const model = context && typeof context.model === "object" && context.model ? context.model : {};
  const bodies = valuesFrom(model, "bodies");
  const features = valuesFrom(model, "features");
  const variables = valuesFrom(model, "variables");
  const materials = valuesFrom(model, "materials");
  const coordinates = valuesFrom(model, "coordinateSystems");
  const hasBodies = bodies.length > 0 || Array.isArray(model.bodyMetadata);
  const bodyCandidates = bodies.length ? bodies : valuesFrom(model, "bodyMetadata");
  const selectedBody = Array.isArray(context.selections) ? context.selections.find((item) => item?.kind === "body" && asText(item.bodyId)) : null;
  const promptText = String(prompt || "").toLowerCase();
  const mentionedBody = bodyCandidates.find((body) => [body.name, body.bodyId, body.id].some((value) => asText(value) && promptText.includes(asText(value).toLowerCase())));
  const fallbackBodyId = asText(selectedBody?.bodyId) || candidateId(mentionedBody, ["bodyId", "id"]);
  const questions = [];
  const steps = (plan.steps || []).map((step, index) => {
    const inputs = { ...(step.request?.inputs || {}) };
    const parameters = { ...(step.request?.parameters || {}) };
    const path = `steps[${index}]`;
    const bodyFields = ["bodyId", "targetBody", "toolBody", "sourceBody", "referenceBodyId"];
    for (const field of bodyFields) {
      if (inputs[field]) inputs[field] = resolveFrom(inputs[field], bodyCandidates, ["bodyId", "id", "name"], `${path}.inputs.${field}`, "Body", questions);
      if (parameters[field]) parameters[field] = resolveFrom(parameters[field], bodyCandidates, ["bodyId", "id", "name"], `${path}.parameters.${field}`, "Body", questions);
    }
    for (const field of ["bodyIds", "targetBodies", "sourceBodies"]) {
      if (!Array.isArray(inputs[field])) continue;
      inputs[field] = inputs[field].map((value, itemIndex) => resolveFrom(value, bodyCandidates, ["bodyId", "id", "name"], `${path}.inputs.${field}[${itemIndex}]`, "Body", questions));
    }
    if (["body.delete", "body.update"].includes(step.operation) && !asText(inputs.bodyId) && fallbackBodyId) inputs.bodyId = fallbackBodyId;
    if (["body.delete", "body.update"].includes(step.operation) && !asText(inputs.bodyId)) addQuestion(questions, `${path}.inputs.bodyId`, `请先选择或指定要${step.operation === "body.delete" ? "删除" : "更新"}的 Body。`, "body", "BODY_REQUIRED");
    if (["body.delete", "body.update"].includes(step.operation) && asText(inputs.bodyId) && hasBodies && !bodyCandidates.some((body) => candidateId(body, ["bodyId", "id"]) === inputs.bodyId)) addQuestion(questions, `${path}.inputs.bodyId`, `Body ${inputs.bodyId} 已不存在，请重新选择。`, "body", "BODY_NOT_FOUND", inputs.bodyId);

    for (const field of ["featureId", "targetFeature", "toolFeature"]) {
      if (inputs[field]) inputs[field] = resolveFrom(inputs[field], features, ["id", "featureId"], `${path}.inputs.${field}`, "Feature", questions);
    }
    if (Array.isArray(inputs.featureIds)) inputs.featureIds = inputs.featureIds.map((value, itemIndex) => resolveFrom(value, features, ["id", "featureId"], `${path}.inputs.featureIds[${itemIndex}]`, "Feature", questions));

    const kind = asText(inputs.kind);
    const topologyId = asText(inputs.topologyId || inputs.referenceTopologyId);
    const topologyBodyId = asText(inputs.bodyId || inputs.referenceBodyId);
    if (topologyId && topologyBodyId && (kind === "face" || kind === "edge" || step.operation === "coordinate.set")) {
      const topology = topologyForBody(model, topologyBodyId);
      if (topology) {
        const ids = kind === "edge" ? topology.edgeIds : topology.faceIds;
        if (ids.length && !ids.includes(topologyId)) addQuestion(questions, `${path}.inputs.topologyId`, `${kind === "edge" ? "Edge" : "Face"} ${topologyId} 不属于 Body ${topologyBodyId} 的当前拓扑，请重新拾取。`, kind, "TOPOLOGY_NOT_FOUND", topologyId);
      }
    }

    if (step.operation === "boolean.cut" || step.operation === "boolean.fuse" || step.operation === "boolean.common") {
      if (asText(inputs.targetBody) && asText(inputs.toolBody) && inputs.targetBody === inputs.toolBody) addQuestion(questions, `${path}.inputs.toolBody`, "Boolean 的 Target 和 Tool 必须是两个不同的 Body。", "body", "BOOLEAN_BODIES_MUST_DIFFER");
    }
    const variableName = asText(inputs.name || parameters.name);
    if (["variable.delete"].includes(step.operation) && variableName && variables.length && !variables.some((item) => asText(item.name) === variableName)) addQuestion(questions, `${path}.inputs.name`, `变量 ${variableName} 不存在，请先查询当前变量。`, undefined, "VARIABLE_NOT_FOUND", variableName);
    const materialName = asText(inputs.name || inputs.materialName || parameters.materialName || parameters.material);
    if (["material.delete", "material.property.set", "material.property.delete"].includes(step.operation) && materialName && materials.length && !materials.some((item) => asText(item.name) === materialName)) addQuestion(questions, `${path}.${step.operation.startsWith("material.property") ? "parameters.materialName" : "inputs.name"}`, `材料 ${materialName} 不存在，请先新增或查询材料。`, undefined, "MATERIAL_NOT_FOUND", materialName);
    if (step.operation === "body.update" && asText(parameters.material) && materials.length && !materials.some((item) => asText(item.name) === asText(parameters.material))) addQuestion(questions, `${path}.parameters.material`, `材料 ${parameters.material} 不存在，不能分配给 Body。`, undefined, "MATERIAL_NOT_FOUND", parameters.material);
    const coordinateId = asText(inputs.id || parameters.coordinateSystemId);
    if (step.operation === "coordinate.delete" && coordinateId && coordinates.length && !coordinates.some((item) => asText(item.id) === coordinateId)) addQuestion(questions, `${path}.inputs.id`, `坐标系 ${coordinateId} 不存在，请先查询当前坐标系。`, undefined, "COORDINATE_NOT_FOUND", coordinateId);
    if (parameters.coordinateSystemId && coordinates.length && !coordinates.some((item) => asText(item.id) === asText(parameters.coordinateSystemId))) addQuestion(questions, `${path}.parameters.coordinateSystemId`, `坐标系 ${parameters.coordinateSystemId} 不存在，请重新选择。`, undefined, "COORDINATE_NOT_FOUND", parameters.coordinateSystemId);

    return { ...step, request: { ...step.request, inputs, parameters } };
  });
  if (!questions.length) return { ...plan, steps, resolver: { status: "resolved", revision: context.revision ?? null } };
  return { ...plan, steps, questions: [...(plan.questions || []), ...questions].slice(0, MAX_QUESTIONS), status: "needs-input", resolver: { status: "needs-input", revision: context.revision ?? null, errors: questions.map((item) => ({ code: item.code, fieldPath: item.fieldPath, received: item.received })) } };
}