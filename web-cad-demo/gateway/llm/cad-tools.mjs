import { CAD_TOOL_OPERATION_MAP, isKnownCadOperation, isReadOnlyCadOperation } from "./command-catalog.mjs";
import { SELECTION_TOOL_OPERATIONS } from "../selection-precondition.mjs";
const tool = (name, description, properties, required = Object.keys(properties)) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", additionalProperties: false, properties:SELECTION_TOOL_OPERATIONS.has(CAD_TOOL_OPERATION_MAP[name]?.operation)?{...properties,baseStateToken:{type:"string",pattern:"^[a-f0-9]{64}$",description:"Copy the stateToken from the query_model snapshot used to choose this geometry; query and reselect after a conflict."}}:properties, required:SELECTION_TOOL_OPERATIONS.has(CAD_TOOL_OPERATION_MAP[name]?.operation)?[...required,"baseStateToken"]:required },
  strict: true,
});

const numberOrExpression = { type: ["number", "string"] };
const vector = { type: "array", minItems: 3, maxItems: 3, items: { type: ["number", "string"] } };

export const CAD_TOOL_DEFINITIONS = [
  tool("create_box", "Create a solid box Body.", { width: numberOrExpression, depth: numberOrExpression, height: numberOrExpression }),
  tool("create_cylinder", "Create a solid cylinder Body.", { radius: numberOrExpression, height: numberOrExpression }),
  tool("create_sphere", "Create a solid sphere Body.", { radius: numberOrExpression }),
  tool("translate_body", "Translate an existing Body.", { bodyId: { type: "string" }, dx: numberOrExpression, dy: numberOrExpression, dz: numberOrExpression }),
  tool("rotate_body", "Rotate an existing Body around an axis.", { bodyId: { type: "string" }, axisOrigin: vector, axisDirection: vector, angle: numberOrExpression }),
  tool("scale_body", "Uniformly scale an existing Body.", { bodyId: { type: "string" }, factor: numberOrExpression }),
  tool("boolean_fuse", "Fuse two solid Bodies.", { targetBody: { type: "string" }, toolBody: { type: "string" }}),
  tool("boolean_cut", "Subtract the Tool Body from the Target Body.", { targetBody: { type: "string" }, toolBody: { type: "string" }}),
  tool("boolean_common", "Keep the common volume of two Bodies.", { targetBody: { type: "string" }, toolBody: { type: "string" }}),
  tool("fillet_edge", "Create a fillet on an Edge.", { bodyId: { type: "string" }, edgeId: { type: "string" }, radius: numberOrExpression }),
  tool("chamfer_edge", "Create a chamfer on an Edge.", { bodyId: { type: "string" }, edgeId: { type: "string" }, distance: numberOrExpression }),
  tool("set_variable", "Create or update a scalar project variable.", { name: { type: "string" }, type: { type: "string", enum: ["length", "angle", "dimensionless", "integer"] }, expression: { type: "string" }}),
  tool("set_material", "Create or update a project material.", { name: { type: "string" }, category: { type: "string", enum: ["vacuum", "dielectric", "conductor"] }, relativePermittivity: numberOrExpression, conductivity: numberOrExpression }),
  tool("assign_material", "Assign an existing material to a Body.", { bodyId: { type: "string" }, material: { type: "string" } }),
  tool("set_coordinate_system", "Create or update a Cartesian coordinate system.", { id: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["cartesian", "threePoint", "face"] }, origin: vector, xAxis: vector, yAxis: vector }),
  tool("set_property", "Set a typed custom property on a Body, Face or Edge.", { kind: { type: "string", enum: ["body", "face", "edge"] }, bodyId: { type: "string" }, topologyId: { type: ["string", "null"] }, key: { type: "string" }, type: { type: "string", enum: ["bool", "int", "double", "expression"] }, value: { type: ["boolean", "integer", "number", "string"] } }),
  tool("create_property_type", "Create a reusable property type schema. One type can have many independent instances.", { key: { type: "string" }, name: { type: "string" }, description: { type: "string" }, targetScope: { type: "string", enum: ["project", "body", "face", "edge"] }, association: { type: "string", enum: ["none", "optional", "required"] }, fields: { type: "array", items: { type: "object", additionalProperties: false, properties: { key: { type: "string" }, label: { type: "string" }, type: { type: "string", enum: ["bool", "int", "double", "expression", "enum", "vector3"] }, required: { type: "boolean" }, options: { type: "array", items: { type: "string" } } }, required: ["key", "label", "type", "required", "options"] } } }, ["key", "name", "targetScope", "association", "fields"]),
  tool("list_property_types", "List reusable property type schemas in the current project.", {}),
  tool("create_property_instance", "Create an instance of an existing property type. The same type may be instantiated many times.", { typeId: { type: ["string", "null"] }, typeKey: { type: ["string", "null"] }, name: { type: "string" }, value: { type: "object" }, target: { type: ["object", "null"] } }, ["typeId", "typeKey", "name", "value", "target"]),
  tool("update_property_instance", "Update an existing property instance value without changing its type.", { instanceId: { type: "string" }, name: { type: "string" }, value: { type: "object" } }, ["instanceId", "name", "value"]),
  tool("retarget_property_instance", "Change the geometry target of a property instance.", { instanceId: { type: "string" }, target: { type: ["object", "null"] } }),
  tool("delete_property_instance", "Delete one property instance.", { instanceId: { type: "string" }}),
  tool("list_property_instances", "List property instances, including their optional geometry targets.", {}),
  tool("delete_body", "Delete a Body and its dependent history.", { bodyId: { type: "string" }}),
  tool("measure_geometry", "Measure a Body, Face or Edge without mutation.", { bodyId: { type: "string" }, selectionType: { type: "string", enum: ["body", "face", "edge"] }, selectionId: { type: "string" }}),
  tool("relate_geometry", "Compute the distance and geometric relation between two Bodies without mutation.", { bodyA: { type: "string" }, bodyB: { type: "string" }, tolerance: { type: "number", minimum: 0, maximum: 1 } }, ["bodyA", "bodyB"]),
  tool("undo", "Undo the latest document mutation.", {}),
  tool("redo", "Redo the latest undone mutation.", {}),
];

for(const definition of CAD_TOOL_DEFINITIONS){
  if(definition.name==='create_property_type')Object.assign(definition.parameters.properties,{targetMode:{type:['string','null'],enum:['single','multiple',null]},splitPolicy:{type:['string','null'],enum:['review','all-descendants',null]}});
  if(['create_property_instance','retarget_property_instance'].includes(definition.name)){
    definition.parameters.properties.targets={type:['array','null'],maxItems:256,items:{type:'object',properties:{kind:{type:'string',enum:['body','face','edge']},bodyId:{type:'string'},topologyId:{type:'string'},bodyIdentity:{type:'string'},topologyIdentity:{type:'string'}},required:['kind','bodyId'],additionalProperties:false}};
    definition.parameters.required=definition.parameters.required.filter(key=>key!=='target');
    definition.description+=' Use target for a single-target type, targets for a multiple-target type; never invent IDs. Null target clears only an optional single association. Collections are homogeneous and limited to 256 verified members.';
  }
}

const TOOL_OPERATIONS = Object.fromEntries(Object.entries(CAD_TOOL_OPERATION_MAP).map(([name, descriptor]) => [
  name,
  [descriptor.operation, descriptor.inputKeys.length ? { keys: descriptor.inputKeys } : {}, descriptor.parameterKeys],
]));
const TOOL_NAMES = new Set(CAD_TOOL_DEFINITIONS.map((item) => item.name));
export function validateCadToolContract() {
  const definitionNames = new Set(CAD_TOOL_DEFINITIONS.map((item) => item.name));
  for (const definition of CAD_TOOL_DEFINITIONS) {
    const descriptor = CAD_TOOL_OPERATION_MAP[definition.name];
    if (!descriptor) throw new Error(`CAD tool ${definition.name} has no operation contract.`);
    if (!isKnownCadOperation(descriptor.operation)) throw new Error(`CAD tool ${definition.name} maps to unknown operation ${descriptor.operation}.`);
  }
  for (const name of Object.keys(CAD_TOOL_OPERATION_MAP)) if (!definitionNames.has(name)) throw new Error(`Operation contract ${name} has no CAD tool definition.`);
  return true;
}
validateCadToolContract();
for (const [toolName, [operation]] of Object.entries(TOOL_OPERATIONS)) {
  if (!isKnownCadOperation(operation)) throw new Error(`Tool ${toolName} maps to unknown CAD operation ${operation}.`);
}

export const CAD_TOOL_DESCRIPTORS = Object.freeze(CAD_TOOL_DEFINITIONS.map((definition) => {
  const [operation, inputSpec, parameterKeys] = TOOL_OPERATIONS[definition.name];
  return Object.freeze({ name: definition.name, operation, inputKeys: inputSpec.keys || [], parameterKeys, risk: "none", readOnly: isReadOnlyCadOperation(operation) });
}));

export function isCadToolCall(value) {
  return Boolean(value && typeof value.name === "string" && TOOL_NAMES.has(value.name));
}

export function toolCallsToModelingPlan(calls) {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error("The model returned no CAD tool calls.");
  const steps = calls.map((call, index) => {
    if (!isCadToolCall(call)) throw new Error(`Unknown CAD tool: ${call?.name || ""}.`);
    let args = call.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch (error) { throw new Error(`Tool ${call.name} returned invalid arguments: ${error.message}`); }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`Tool ${call.name} arguments must be an object.`);
    const [operation, inputSpec, parameterKeys] = TOOL_OPERATIONS[call.name];
    const inputs = {};
    for (const key of inputSpec.keys || []) if (args[key] !== undefined && args[key] !== null) inputs[key] = args[key];
    const parameters = {};
    for (const key of parameterKeys) if (args[key] !== undefined && (args[key] !== null || key==='target')) parameters[key] = args[key];
    const risk = "none";
    return { id: `tool-step-${index + 1}`, operation, inputs, parameters,...(args.baseStateToken!==undefined?{baseStateToken:args.baseStateToken}:{}), explanation: call.explanation || `Execute ${call.name}.`, risk, selection: operation === "geometry.measure" ? "body-or-face-or-edge" : "none" };
  });
  return { summary: steps.map((step) => step.explanation).join(" ").slice(0, 1000), risk: "none", questions: [], steps };
}

const CAD_QUERY_TOOL_DEFINITIONS = [
  tool("query_model", "Read the current Web Studio model state. Use this before acting when entity ids or history are uncertain.", { kind: { type: "string", enum: ["geometry-tree", "body", "feature", "variables", "materials", "coordinates", "history", "property-types", "properties"] }, bodyId: { type: ["string", "null"] }, featureId: { type: ["string", "null"] } }, ["kind", "bodyId", "featureId"]),
];
const READ_ONLY_TOOL_NAMES = new Set(["measure_geometry", "relate_geometry", "query_model", "list_property_types", "list_property_instances"]);
const CAD_QUERY_TOOL_NAMES = new Set(CAD_QUERY_TOOL_DEFINITIONS.map((item) => item.name));
export function isCadQueryToolCall(value) {
  return Boolean(value && typeof value.name === "string" && CAD_QUERY_TOOL_NAMES.has(value.name));
}

export function isCadMutationTool(name) { return !READ_ONLY_TOOL_NAMES.has(String(name || "")); }

export function toolDefinitionsForProtocol(protocol, { includeQueries = false, mode = "edit" } = {}) {
  const definitions = includeQueries ? [...CAD_TOOL_DEFINITIONS, ...CAD_QUERY_TOOL_DEFINITIONS] : CAD_TOOL_DEFINITIONS;
  const filtered = definitions;
  return filtered.map((definition) => protocol === "responses"
    ? { type: "function", name: definition.name, description: definition.description, parameters: definition.parameters, strict: true }
    : { type: "function", function: { name: definition.name, description: definition.description, parameters: definition.parameters, strict: true } });
}
