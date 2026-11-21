const VALUE_TYPES = new Set(["bool", "int", "double", "expression"]);
const PROPERTY_SCHEMA_FIELD_TYPES = new Set(["bool", "int", "double", "expression", "enum", "vector3"]);
const VARIABLE_TYPES = new Set(["length", "angle", "dimensionless", "integer"]);
const PROPERTY_KINDS = new Set(["body", "face", "edge"]);
const COORDINATE_KINDS = new Set(["cartesian", "threePoint", "face"]);
const PRIMITIVE_REQUIRED = {
  "primitive.box": ["width", "depth", "height"],
  "primitive.cylinder": ["radius", "height"],
  "primitive.cone": ["radius1", "radius2", "height"],
  "primitive.sphere": ["radius"],
  "primitive.torus": ["majorRadius", "minorRadius"],
  "primitive.tube": ["outerRadius", "innerRadius", "height"],
};

function requiredText(values, field, path) {
  const value = values[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path}.${field} is required.`);
  return value.trim();
}

function requiredValue(values, field, path) {
  if (!Object.prototype.hasOwnProperty.call(values, field) || values[field] === undefined || values[field] === null || values[field] === "")
    throw new Error(`${path}.${field} is required.`);
  return values[field];
}

function vector(values, field, path) {
  const value = requiredValue(values, field, path);
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !(typeof item === "number" || (typeof item === "string" && item.trim()))))
    throw new Error(`${path}.${field} must contain three numeric values or expressions.`);
}

export function validateDomainPlanStep(operation, inputs, parameters, index) {
  const stepPath = `steps[${index}]`;
  if (PRIMITIVE_REQUIRED[operation]) {
    for (const field of PRIMITIVE_REQUIRED[operation]) requiredValue(parameters, field, `${stepPath}.parameters`);
  } else if (operation === "variable.set") {
    requiredText(parameters, "name", `${stepPath}.parameters`);
    const type = requiredText(parameters, "type", `${stepPath}.parameters`);
    if (!VARIABLE_TYPES.has(type)) throw new Error(`${stepPath}.parameters.type is invalid.`);
    requiredText(parameters, "expression", `${stepPath}.parameters`);
  } else if (operation === "variable.delete") {
    requiredText(inputs, "name", `${stepPath}.inputs`);
  } else if (operation === "material.set") {
    requiredText(parameters, "name", `${stepPath}.parameters`);
    if (parameters.category !== undefined && !["vacuum", "dielectric", "conductor"].includes(parameters.category)) throw new Error(`${stepPath}.parameters.category is invalid.`);
    for (const field of ["relativePermittivity", "conductivity"]) if (parameters[field] !== undefined && !(typeof parameters[field] === "number" || (typeof parameters[field] === "string" && parameters[field].trim()))) throw new Error(`${stepPath}.parameters.${field} must be a number or expression.`);
  } else if (operation === "material.delete") {
    requiredText(inputs, "name", `${stepPath}.inputs`);
  } else if (operation === "material.property.set") {
    requiredText(parameters, "materialName", `${stepPath}.parameters`);
    requiredText(parameters, "key", `${stepPath}.parameters`);
    const type = requiredText(parameters, "type", `${stepPath}.parameters`);
    if (!VALUE_TYPES.has(type)) throw new Error(`${stepPath}.parameters.type is invalid.`);
    requiredValue(parameters, "value", `${stepPath}.parameters`);
  } else if (operation === "material.property.delete") {
    requiredText(parameters, "materialName", `${stepPath}.parameters`);
    requiredText(parameters, "key", `${stepPath}.parameters`);
  } else if (["property.set", "property.delete", "property.list"].includes(operation)) {
    const kind = requiredText(inputs, "kind", `${stepPath}.inputs`);
    if (!PROPERTY_KINDS.has(kind)) throw new Error(`${stepPath}.inputs.kind is invalid.`);
    requiredText(inputs, "bodyId", `${stepPath}.inputs`);
    if ((kind === "face" || kind === "edge") && !String(inputs.topologyId || "").trim()) throw new Error(`${stepPath}.inputs.topologyId is required for ${kind}.`);
    if (operation !== "property.list") {
      requiredText(parameters, "key", `${stepPath}.parameters`);
      if (operation === "property.set") {
        const type = requiredText(parameters, "type", `${stepPath}.parameters`);
        if (!VALUE_TYPES.has(type)) throw new Error(`${stepPath}.parameters.type is invalid.`);
        requiredValue(parameters, "value", `${stepPath}.parameters`);
      }
    }
  } else if (operation === "property.type.create") {
    const key = requiredText(parameters, "key", `${stepPath}.parameters`);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new Error(`${stepPath}.parameters.key is invalid.`);
    requiredText(parameters, "name", `${stepPath}.parameters`);
    if (!Array.isArray(parameters.fields)) throw new Error(`${stepPath}.parameters.fields is required.`);
    for (const [fieldIndex, field] of parameters.fields.entries()) {
      if (!field || typeof field !== "object") throw new Error(`${stepPath}.parameters.fields[${fieldIndex}] is invalid.`);
      requiredText(field, "key", `${stepPath}.parameters.fields[${fieldIndex}]`);
      const type = requiredText(field, "type", `${stepPath}.parameters.fields[${fieldIndex}]`);
      if (!PROPERTY_SCHEMA_FIELD_TYPES.has(type)) throw new Error(`${stepPath}.parameters.fields[${fieldIndex}].type is invalid.`);
    }
    if (!["project", "body", "face", "edge"].includes(parameters.targetScope)) throw new Error(`${stepPath}.parameters.targetScope is invalid.`);
    if (!["none", "optional", "required"].includes(parameters.association)) throw new Error(`${stepPath}.parameters.association is invalid.`);
  } else if (operation === "property.type.update" || operation === "property.type.delete") {
    requiredText(inputs, "typeId", `${stepPath}.inputs`);
  } else if (operation === "property.instance.create") {
    if (!String(parameters.typeId || parameters.typeKey || "").trim()) throw new Error(`${stepPath}.parameters.typeId or typeKey is required.`);
    requiredText(parameters, "name", `${stepPath}.parameters`);
    requiredValue(parameters, "value", `${stepPath}.parameters`);
  } else if (operation === "property.instance.update") {
    requiredText(inputs, "instanceId", `${stepPath}.inputs`);
    requiredValue(parameters, "value", `${stepPath}.parameters`);
  } else if (operation === "property.instance.retarget") {
    requiredText(inputs, "instanceId", `${stepPath}.inputs`);
    if (parameters.target === undefined && parameters.targets === undefined) throw new Error(`${stepPath}.parameters.target or targets is required.`);
  } else if (operation === "property.instance.delete") {
    requiredText(inputs, "instanceId", `${stepPath}.inputs`);
  } else if (operation === "coordinate.set") {
    requiredText(parameters, "id", `${stepPath}.parameters`);
    requiredText(parameters, "name", `${stepPath}.parameters`);
    const kind = parameters.kind || "cartesian";
    if (!COORDINATE_KINDS.has(kind)) throw new Error(`${stepPath}.parameters.kind is invalid.`);
    for (const field of ["origin", "xAxis", "yAxis"]) if(parameters[field]!==undefined)vector(parameters, field, `${stepPath}.parameters`);
    if (kind === "threePoint") for (const field of ["xPoint", "planePoint"]) vector(parameters, field, `${stepPath}.parameters`);
    if(parameters.preserveReference!==undefined && typeof parameters.preserveReference!=="boolean")throw new Error(`${stepPath}.parameters.preserveReference must be boolean.`);
    if(parameters.associationMode!==undefined && !["snapshot","associative"].includes(parameters.associationMode))throw new Error(`${stepPath}.parameters.associationMode is invalid.`);
    if (kind === "face" && !parameters.preserveReference && !parameters.copyReferenceFrom) {
      requiredText(parameters, "referenceBodyId", `${stepPath}.parameters`);
      requiredText(parameters, "referenceTopologyId", `${stepPath}.parameters`);
    }
  } else if (operation === "coordinate.delete") {
    requiredText(inputs, "id", `${stepPath}.inputs`);
  }
}

export function isDomainMutation(operation) {
  return /^(?:variable|coordinate|material|property)\.(?!(?:type|instance)\.list$|package\.export$)/.test(operation);
}
