/** Geometry display IDs are scoped to an observed project state, not a lease.
 * In particular, Undo branches can reuse the same native R/Face/Edge IDs. */
export const SELECTION_STATE_POLICY = Object.freeze({
  version: 1,
  requiredField: "baseStateToken",
  missingCode: "SELECTION_STATE_REQUIRED",
  recovery: "query_model 或 document.view 读取当前工程，重新确认选择，并使用该次读取的 stateToken 提交；不要仅替换令牌重试旧面/边编号。",
});

export function selectionBindingPaths(operation, fields = {}) {
  const inputs = fields.inputs || {}, parameters = fields.parameters || {}, paths = [];
  if(operation==="document.naming.preview" || operation==="document.naming.upgrade")paths.push("document.importedReferences");
  if (operation.startsWith("detail.")) {
    for (const kind of ["face", "edge"])
      if (inputs[`${kind}Id`]) paths.push(`inputs.${kind}Id`);
  }
  if(operation==="detail.loft")paths.push("inputs.sections");
  if(operation==="feature.update" && parameters.loftDefinition)paths.push("parameters.loftDefinition");
  if(["detail.sweep","detail.pipe"].includes(operation) && (inputs.pathBodyId || inputs.pathEdgeIds))paths.push("inputs.pathEdgeIds");
  if(operation==="feature.update" && parameters.sweepDefinition)paths.push("parameters.sweepDefinition");
  if (operation === "coordinate.set" && (parameters.kind === "face" || parameters.kind?.$ref || parameters.referenceTopologyId || parameters.preserveReference || parameters.copyReferenceFrom))
    paths.push("parameters.referenceTopologyId");
  if (["property.set", "property.delete"].includes(operation) && (["body", "face", "edge"].includes(inputs.kind) || inputs.kind?.$ref))
    paths.push(inputs.kind === "body" ? "inputs.bodyId" : "inputs.topologyId");
  if (["property.instance.create", "property.instance.update", "property.instance.retarget"].includes(operation)) {
    const targets=Object.hasOwn(parameters,'targets')?parameters.targets:inputs.targets;
    if((Array.isArray(targets)&&targets.length)||targets?.$ref)paths.push(`${parameters.targets!==undefined?'parameters':'inputs'}.targets`);
    const target = Object.hasOwn(parameters,"target") ? parameters.target : inputs.target;
    if (target && (["body", "face", "edge"].includes(target.kind) || target.$ref || target.kind?.$ref))
      paths.push(`${parameters.target !== undefined ? "parameters" : "inputs"}.target`);
  }
  if ((Array.isArray(parameters.selectionEdits) && parameters.selectionEdits.length) || parameters.selectionEdits?.$ref)
    paths.push("parameters.selectionEdits");
  if ((Array.isArray(parameters.coordinateSelectionEdits) && parameters.coordinateSelectionEdits.length) || parameters.coordinateSelectionEdits?.$ref)
    paths.push("parameters.coordinateSelectionEdits");
  return paths;
}

export function selectionStateProblem(operation, fields = {}) {
  const paths = selectionBindingPaths(operation, fields);
  if (!paths.length || fields.baseStateToken !== undefined) return null;
  return {
    code: SELECTION_STATE_POLICY.missingCode,
    error: "几何选择写入缺少读取时的工程状态标识（baseStateToken）。" + SELECTION_STATE_POLICY.recovery,
    fieldPath: "baseStateToken",
    expected: "stateToken returned with the selected geometry snapshot",
    selectionPaths: paths,
    retryableByModel: false,
    policyVersion: SELECTION_STATE_POLICY.version,
  };
}

// Tool schemas require a read state for families that may bind geometry.
// Conditional HTTP enforcement below remains based on the actual request.
export const SELECTION_TOOL_OPERATIONS = new Set([
  "detail.fillet", "detail.chamfer", "detail.shell", "detail.thicken", "detail.draft", "detail.revolve", "detail.sweep", "detail.pipe",
  "detail.loft",
  "coordinate.set", "property.set", "property.delete", "property.instance.create", "property.instance.update", "property.instance.retarget",
  "feature.update", "feature.suppress", "feature.restore", "feature.delete", "variable.set",
]);
