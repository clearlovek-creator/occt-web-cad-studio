import { pathToFileURL } from "node:url";
import { CAD_OPERATION_CATALOG } from "./llm/command-catalog.mjs";
import { selectionStateProblem, SELECTION_TOOL_OPERATIONS, SELECTION_STATE_POLICY } from "./selection-precondition.mjs";
import {loftSectionsSchema,loftDefinitionSchema,validateLoftSections,validateLoftDefinition,readMcpNativeCapabilities,loftCapabilityRequirement} from './cad-mcp-loft.mjs';
import {loftHoleLimits} from './worker-capabilities.mjs';
import {serveBoundedMcp} from './bounded-mcp-stdio.mjs';
import {executeMcpModelingTask} from './cad-mcp-modeling-task.mjs';
import {PI_BATCH_OPERATIONS, requiresPiWriteApproval} from './pi-write-approval.mjs';
import {MESH_STRATEGY_OPTIONS_SCHEMA} from '../shared/mesh-strategy.mjs';
import {MESH_MCP_TOOLS,callMeshMcpTool} from './cad-mcp-mesh-tasks.mjs';

const PROTOCOL_VERSION = "2024-11-05";
const MCP_READ_ONLY_OPERATIONS = new Set([...CAD_OPERATION_CATALOG.filter((item) => item.readOnly).map((item) => item.operation), "geometry.check"]);
const needsNativeRevision=operation=>!MCP_READ_ONLY_OPERATIONS.has(operation)&&!['primitive.','surface.','property.type.','property.instance.','property.package.','mesh.strategy.'].some(prefix=>operation.startsWith(prefix));
const createsPrimitive=operation=>operation.startsWith('primitive.')||operation.startsWith('surface.');
const OPTIONAL_FIELDS = {
  'mesh.strategy.update':{parameters:['name','options']},
  "property.type.create": {parameters:["targetMode","splitPolicy","description"]},
  "property.instance.create": {parameters:["target","targets"]},
  "property.instance.update": {parameters:["name","value","target","targets"]},
  "property.instance.retarget": {parameters:["target","targets"]},
  "coordinate.set": { parameters: ["kind","origin","xAxis","yAxis","xPoint","planePoint","referenceBodyId","referenceTopologyId","associationMode","preserveReference","copyReferenceFrom"] },
  "transform.coordinate": { parameters: ["sourceCoordinateSystemId", "targetCoordinateSystemId"] },
  "transform.align": { parameters: ["mode"] },
  "detail.shell": { parameters: ["inward"] },
  "detail.loft": { parameters: ["placement","sectionSpacing","ruled"] },
  "detail.sweep": {inputs:["pathBodyId","pathEdgeIds"],parameters:["pathX","pathY","pathZ","placement","frame","reverse"]},
  "detail.pipe": {inputs:["pathBodyId","pathEdgeIds"],parameters:["pathX","pathY","pathZ","placement","frame","reverse"]},
  "feature.update": {parameters:["sweepDefinition","loftDefinition"]},
  "geometry.measure": { inputs: ["selectionType", "selectionId"] },
  "property.list": { inputs: ["kind", "bodyId", "topologyId"] },
};
const REQUIRED_FIELDS = {
  'mesh.strategy.create':{parameters:['name','options']},'mesh.strategy.update':{inputs:['strategyId'],parameters:['revision','definitionHash']},'mesh.strategy.delete':{inputs:['strategyId'],parameters:['revision','definitionHash']},
  "primitive.box": { parameters: ["width", "depth", "height"] }, "primitive.cylinder": { parameters: ["radius", "height"] },
  "primitive.cone": { parameters: ["radius1", "radius2", "height"] }, "primitive.sphere": { parameters: ["radius"] },
  "primitive.wedge": { parameters: ["width", "depth", "height"] }, "primitive.prism": { parameters: ["radius", "height"] }, "primitive.pyramid": { parameters: ["baseWidth", "baseDepth", "height"] },
  "primitive.torus": { parameters: ["majorRadius", "minorRadius"] }, "primitive.tube": { parameters: ["outerRadius", "innerRadius", "height"] },
  "surface.rectangle": { parameters: ["width", "height"] }, "surface.disk": { parameters: ["radius"] },
  "surface.cylinder": { parameters: ["radius", "height"] }, "surface.cone": { parameters: ["radius1", "radius2", "height"] }, "surface.sphere": { parameters: ["radius"] },
  "transform.translate": { inputs: ["bodyId"], parameters: ["dx", "dy", "dz"] }, "transform.rotate": { inputs: ["bodyId"], parameters: ["originX", "originY", "originZ", "axisX", "axisY", "axisZ", "angleDegrees"] },
  "transform.mirror": { inputs: ["bodyId"], parameters: ["originX", "originY", "originZ", "normalX", "normalY", "normalZ"] }, "transform.scale": { inputs: ["bodyId"], parameters: ["factor"] },
  "transform.scale_non_uniform": { inputs: ["bodyId"], parameters: ["factorX", "factorY", "factorZ"] }, "transform.copy": { inputs: ["bodyId"], parameters: ["dx", "dy", "dz"] },
  "transform.coordinate": { inputs: ["bodyId"] }, "transform.align": { inputs: ["bodyId"], parameters: ["targetX", "targetY", "targetZ"] },
  "boolean.fuse": { inputs: ["targetBody", "toolBody"] }, "boolean.cut": { inputs: ["targetBody", "toolBody"] }, "boolean.common": { inputs: ["targetBody", "toolBody"] },
  "boolean.section": { inputs: ["targetBody", "toolBody"] }, "boolean.split": { inputs: ["targetBody", "toolBody"] }, "boolean.partition": { inputs: ["targetBody", "toolBody"] },
  "boolean.fragments": { inputs: ["targetBody", "toolBody"] }, "boolean.imprint": { inputs: ["targetBody", "toolBody"] },
  "detail.fillet": { inputs: ["bodyId", "edgeId"], parameters: ["radius"] }, "detail.chamfer": { inputs: ["bodyId", "edgeId"], parameters: ["distance"] },
  "detail.shell": { inputs: ["bodyId", "faceId"], parameters: ["thickness"] }, "detail.thicken": { inputs: ["bodyId", "faceId"], parameters: ["thickness"] }, "detail.offset": { inputs: ["bodyId"], parameters: ["distance"] },
  "detail.revolve": { inputs: ["bodyId", "faceId"], parameters: ["angleDegrees", "originX", "originY", "originZ", "axisX", "axisY", "axisZ"] },
  "detail.sweep": { inputs: ["bodyId", "faceId"] }, "detail.pipe": { inputs: ["bodyId", "faceId"] },
  "detail.loft": { inputs: ["sections"] }, "detail.draft": { inputs: ["bodyId", "faceId"], parameters: ["angleDegrees"] },
  "pattern.linear": { inputs: ["bodyId"], parameters: ["count", "spacing", "directionX", "directionY", "directionZ"] }, "pattern.circular": { inputs: ["bodyId"], parameters: ["count", "angleDegrees", "axisX", "axisY", "axisZ"] },
  "pattern.rectangular": { inputs: ["bodyId"], parameters: ["countX", "countY", "spacingX", "spacingY"] }, "pattern.mirror": { inputs: ["bodyId"], parameters: ["normalX", "normalY", "normalZ"] },
  "geometry.measure": { inputs: ["bodyId"] }, "geometry.check": { inputs: ["bodyId"] }, "geometry.relation": { inputs: ["bodyA", "bodyB"] }, "body.presentation": { inputs: ["bodyId"] },
  "variable.set": { parameters: ["name", "type", "expression"] }, "variable.delete": { inputs: ["name"] }, "coordinate.set": { parameters: ["id", "name"] }, "coordinate.delete": { inputs: ["id"] },
  "material.set": { parameters: ["name"] }, "material.delete": { inputs: ["name"] }, "material.property.set": { parameters: ["materialName", "key", "type", "value"] }, "material.property.delete": { parameters: ["materialName", "key"] },
  "body.delete": { inputs: ["bodyId"] }, "body.update": { inputs: ["bodyId"] }, "feature.update": { inputs: ["featureId"] }, "feature.suppress": { inputs: ["featureId"] }, "feature.restore": { inputs: ["featureId"] }, "feature.delete": { inputs: ["featureId"] },
  "property.set": { inputs: ["kind", "bodyId"], parameters: ["key", "type", "value"] }, "property.delete": { inputs: ["kind", "bodyId"], parameters: ["key"] },
  "property.type.create": { parameters: ["key", "name", "targetScope", "association", "fields"] }, "property.type.update": { inputs: ["typeId"] }, "property.type.delete": { inputs: ["typeId"] },
  "property.instance.create": { parameters: ["typeId", "name", "value"] }, "property.instance.update": { inputs: ["instanceId"] }, "property.instance.delete": { inputs: ["instanceId"] }, "property.instance.retarget": { inputs: ["instanceId"] },
  "property.package.import": { parameters: ["package"] },
};

function operationInputSchema(operation, nativeCapabilities) {
  const required = REQUIRED_FIELDS[operation] || {};
  const isBoolean=operation.startsWith('boolean.');
  const optional = isBoolean ? {inputs:['targetBodies','toolBodies'],parameters:['keepTarget','keepTool','refine','splitResults']} : OPTIONAL_FIELDS[operation] || {};
  const parameterFields = [...new Set([...(required.parameters || []), ...(optional.parameters || [])])];
  const inputFields = [...new Set([...(required.inputs || []), ...(optional.inputs || [])])];
  const parameterProperties = Object.fromEntries(parameterFields.map((field) => [field,
    operation.startsWith('mesh.strategy.')&&field==='options'?MESH_STRATEGY_OPTIONS_SCHEMA
      : operation.startsWith('mesh.strategy.')&&field==='revision'?{type:'integer',minimum:1}
      : operation.startsWith('mesh.strategy.')&&field==='definitionHash'?{type:'string',pattern:'^[a-f0-9]{64}$'}
      : operation.startsWith('mesh.strategy.')&&field==='name'?{type:'string',minLength:1,maxLength:80}
      : operation==="coordinate.set" && ["id","name","referenceBodyId","referenceTopologyId","copyReferenceFrom"].includes(field) ? {type:"string",minLength:1}
      : ["origin","xAxis","yAxis","xPoint","planePoint"].includes(field) ? {type:"array",items:{type:"number"},minItems:3,maxItems:3}
      : field==="associationMode" ? {type:"string",enum:["associative","snapshot"]}
      : field==="targetMode" ? {type:"string",enum:["single","multiple"]}
      : field==="splitPolicy" ? {type:"string",enum:["review","all-descendants"]}
      : field==="targets" ? {type:"array",maxItems:256,items:{type:"object",properties:{kind:{type:"string",enum:["body","face","edge"]},bodyId:{type:"string"},topologyId:{type:"string"},topologyRevision:{type:"integer"},bodyIdentity:{type:"string"},topologyIdentity:{type:"string"}},required:["kind","bodyId"],additionalProperties:false}}
      : field==="placement" ? {type:"string",enum:operation==="detail.loft"?["actual","z-spacing"]:["actual","align-start"]}
      : field==="frame" ? {type:"string",enum:["corrected-frenet","frenet"]}
      : field==="reverse" ? {type:"boolean"}
      : field==="loftDefinition" ? loftDefinitionSchema(nativeCapabilities)
      : field==="sweepDefinition" ? {type:"object",additionalProperties:true}
      : ['ruled','keepTarget','keepTool','refine','splitResults'].includes(field) ? {type:"boolean"}
      : field==="kind" && operation==="coordinate.set" ? {type:"string",enum:["cartesian","threePoint","face"]}
      : field === "fields" || field === "target" || field === "value" ? {} : field === "inward" || field === "preserveReference" ? { type: "boolean" }
      : field === "mode" ? { type: "string", enum: ["min", "center", "max"] }
        : { anyOf: [{ type: "string" }, { type: "number" }], description: "A value or expression; keep units and variable expressions as strings." },
  ]));
  const inputProperties = Object.fromEntries(inputFields.map((field) => [field,
    field === "sections" ? loftSectionsSchema(nativeCapabilities)
      : field === "pathEdgeIds" ? {type:"array",minItems:1,maxItems:32,uniqueItems:true,items:{type:"string",pattern:"^edge-[0-9]+-[1-9][0-9]*$"}}
      : isBoolean && ['targetBodies','toolBodies'].includes(field) ? {type:'array',minItems:1,maxItems:32,uniqueItems:true,items:{type:'string'}}
      : field === "selectionType" ? { type: "string", enum: ["body", "face", "edge"] } : { type: "string" },
  ]));
  const properties = {
    inputs: { type: "object", properties: inputProperties, ...(required.inputs?.length && !isBoolean ? { required: required.inputs } : {}), additionalProperties: true,
      ...(isBoolean ? {allOf:[{anyOf:[{required:['targetBody']},{required:['targetBodies']}]},{anyOf:[{required:['toolBody']},{required:['toolBodies']}]}]} : {}) },
    parameters: { type: "object", properties: parameterProperties, ...(required.parameters?.length ? { required: required.parameters } : {}), additionalProperties: true },
  };
  const rootRequired = [];
  if (required.inputs?.length) rootRequired.push("inputs");
  if (required.parameters?.length) rootRequired.push("parameters");
  if(operation==='property.instance.retarget')rootRequired.push('parameters');
  properties.baseRevision = { type: "integer", minimum: 0, description: "Native revision from the SAME observed snapshot as the selected entities. May be omitted only when baseStateToken identifies that observation; never replace a stale revision/token on old geometry IDs." };
  properties.baseStateToken = { type: "string", pattern: "^[a-f0-9]{64}$", description: "Copy stateToken from the SAME query_model/body.presentation snapshot used to choose the geometry. After a conflict, query and reselect; never just replace this token on old Face/Edge IDs." };
  if(SELECTION_TOOL_OPERATIONS.has(operation)||!MCP_READ_ONLY_OPERATIONS.has(operation))rootRequired.push("baseStateToken");
  return { type: "object", properties, ...(rootRequired.length ? { required: rootRequired } : {}), additionalProperties: false,
    ...(["detail.sweep","detail.pipe"].includes(operation)?{anyOf:[{properties:{inputs:{required:["pathBodyId","pathEdgeIds"]}}},{required:["parameters"],properties:{parameters:{required:["pathX","pathY","pathZ"]}}}]}:operation==='property.instance.retarget'?{anyOf:[{properties:{parameters:{required:['target']}}},{properties:{parameters:{required:['targets']}}}]}:{}) };
}
const queryTool = {
  name: "query_model",
  description: "Read the active CAD document, including Body/Feature tree, project data, topology, and current revision. This tool never changes geometry.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["geometry-tree", "body", "feature", "variables", "materials", "coordinates", "property-types", "properties", "history"], description: "Use geometry-tree for spatial overview, body for one Body, feature with featureId for exact stored parameters and section identities; other scopes read existing project data." },
      bodyId: { type: "string", description: "Required when kind is body." },
      featureId: { type: "string", description: "Required when kind is feature." },
    },
    additionalProperties: false,
  },
};

const commandTools = CAD_OPERATION_CATALOG.map(({ operation, mode }) => {
  const readOnly = MCP_READ_ONLY_OPERATIONS.has(operation);
  return ({
  name: operation.replaceAll(".", "__"),
  description: `${readOnly ? "Read-only" : "Modeling"} CAD command ${operation}. ${readOnly ? "Queries the active document." : "Updates the active CAD document when requested by the user."}${SELECTION_TOOL_OPERATIONS.has(operation)?" Requires baseStateToken from the same observed snapshot as the selected entities. Missing/stale state requires query_model and reselection, not blind retry.":""}${operation==="coordinate.set"?" Face coordinates follow the selected historical face by default. Use current referenceBodyId/referenceTopologyId to bind; preserveReference:true keeps an existing anchor during rename; copyReferenceFrom copies an existing frame to a NEW id. Never invent or reuse stale face ids.":""}${operation==="detail.loft"?" Supply 2-32 ordered sections as {bodyId,faceId} from observed planar Faces, each with one closed boundary; holes and curved Faces are rejected, never replaced with bounding boxes. Actual spatial placement is the default. Only placement=z-spacing uses sectionSpacing to translate real profiles along global Z relative to the first profile. ruled selects straight rather than smooth connections.":""}`,
  inputSchema: operationInputSchema(operation),
  operation,
  readOnly,
  mode,
  });
});
const toolByName = new Map([[queryTool.name, queryTool], ...commandTools.map((tool) => [tool.name, tool]),...MESH_MCP_TOOLS.map(tool=>[tool.name,tool])]);
for(const tool of commandTools)if(tool.operation.startsWith('property.'))tool.description+=' Types default to single target. Create targetMode=multiple for an explicit homogeneous Body/Face/Edge collection; choose immutable splitPolicy=review or all-descendants (Face/Edge only). Collection instances use parameters.targets (0-256 observed members), never target; value-only edits omit geometry to preserve stored anchors. Query property-types/properties to inspect the current type and association status before editing.';
for(const tool of commandTools)if(["detail.sweep","detail.pipe"].includes(tool.operation))tool.description+=" Either supply legacy pathX/pathY/pathZ, or observed pathBodyId with 1-32 ordered pathEdgeIds. Model paths use actual OCCT curves, require connected G1 tangency, and retain historical source identities. placement=actual requires the profile at the path start normal plane; placement=align-start explicitly moves/rotates a profile copy, not the source. frame is corrected-frenet or frenet; reverse flips the complete route. Planar profile holes are retained; sharp corners and singular/self-overlapping torus sections are rejected. Existing curved features are edited with feature.update parameters.sweepDefinition, omitting profile/path to retain their references.";

const batchTool = {
  name:'batch_modify', annotations:{readOnlyHint:false},
  description:'Modify 2-16 existing Body operations atomically. The workbench displays the affected Bodies and waits for explicit approval. Choose all Body IDs from the same query_model snapshot.',
  inputSchema:{type:'object',additionalProperties:false,required:['baseStateToken','steps'],properties:{
    baseStateToken:{type:'string',pattern:'^[a-f0-9]{64}$'},baseRevision:{type:'integer',minimum:0},
    steps:{type:'array',minItems:2,maxItems:16,items:{type:'object',additionalProperties:false,required:['operation','inputs'],properties:{
      operation:{type:'string',enum:PI_BATCH_OPERATIONS},inputs:{type:'object'},parameters:{type:'object'},
    }}},
  }},
};

export function listCadMcpTools({nativeCapabilities, embeddedPi=false}={}) {
  const holes=loftHoleLimits(nativeCapabilities);
  return [queryTool, ...commandTools,...MESH_MCP_TOOLS].map(({ name, description, inputSchema, operation, readOnly }) => ({ name,
    annotations:{readOnlyHint:name==='query_model'||Boolean(readOnly)},
    description:holes&&operation==='detail.loft'?description.replace('each with one closed boundary; holes and curved Faces are rejected','each with one outer boundary and optionally 1-16 explicitly corresponding inner loops; curved Faces are rejected')+' Through-hole capability is negotiated from the actual native process. Read geometry__measure with selectionType=face for boundaryLoops; map ALL inner loops exactly once with sections[].holeEdgeIds in consistent channel order across sections. Never guess nearest loops or drop holes to bypass a failure.':description+(operation==='feature.update'?' Edit an existing Loft with parameters.loftDefinition; retained {sectionId} entries preserve stored references. Query the feature first, keep its version and never replace opaque selectors.':holes&&operation==='geometry.measure'?' Face results include bounded boundaryLoops: exact displayed Edge membership, role, closure, validity, planarity and completeness; incomplete evidence is not a usable mapping.':''),
    inputSchema:['detail.loft','feature.update'].includes(operation)?operationInputSchema(operation,nativeCapabilities):inputSchema })).concat(embeddedPi?[batchTool]:[]);
}

export function createCadMcpHandler({ apiRoot = process.env.CAD_GEOMETRY_API_URL || "http://127.0.0.1:8788/api", documentId = process.env.CAD_DOCUMENT_ID || "default", mode = process.env.CAD_AGENT_MODE || "edit", piSessionId = process.env.CAD_PI_SESSION_ID, piToolToken = process.env.CAD_PI_TOOL_TOKEN, fetchImpl = fetch } = {}) {
  const root = apiRoot.replace(/\/+$/, "");
  const activeMode = mode === "plan" ? "plan" : "edit";
  if (Boolean(piSessionId) !== Boolean(piToolToken)) throw new Error('Incomplete embedded Pi CAD session binding');
  const piHeaders = piSessionId ? {'X-Cad-Pi-Session':piSessionId,'X-Cad-Pi-Token':piToolToken} : undefined;
  const write = async (command, signal) => remember(await executeMcpModelingTask({
    root,command,fetchImpl,signal,piHeaders,approvalRequired:Boolean(piHeaders)&&requiresPiWriteApproval(command),
  }));
  const revisions=new Map();
  const remember=result=>{if(typeof result?.stateToken==='string'&&/^[a-f0-9]{64}$/.test(result.stateToken)&&Number.isInteger(result.revision)&&result.revision>=0){revisions.set(result.stateToken,result.revision);while(revisions.size>16)revisions.delete(revisions.keys().next().value);}return result;};
  const queryCad=async args=>{
    const response=await fetchImpl(`${root}/agent/model/query`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId,kind:args?.kind||'geometry-tree',bodyId:args?.bodyId||'',featureId:args?.featureId||''})});
    const result=await response.json();if(!response.ok||result?.ok===false)throw Object.assign(new Error(result?.error||`CAD query failed (${response.status})`),{code:result?.code});return remember(result.query||result);
  };

  async function callCadTool(name, args, signal) {
    if(signal?.aborted)throw Object.assign(new Error('工具调用已取消，未发送几何命令。'),{code:'MCP_CANCELLED_BEFORE_SEND',outcome:'not-started'});
    if (name === 'batch_modify' && piHeaders && activeMode === 'edit') {
      if (!Array.isArray(args.steps) || args.steps.length < 2 || args.steps.length > 16 ||
          !/^[a-f0-9]{64}$/.test(args.baseStateToken || '') ||
          args.steps.some(step => !step || !PI_BATCH_OPERATIONS.includes(step.operation)))
        throw Object.assign(new Error('请从同一工程快照选择对象，并提供 2 到 16 条 Body 操作。'),{code:'PI_BATCH_ARGUMENTS',outcome:'not-started'});
      return write({protocolVersion:1,documentId,operation:'project.batch',baseStateToken:args.baseStateToken,baseRevision:args.baseRevision,
        steps:args.steps.map(({operation,inputs,parameters})=>({operation,inputs,parameters}))},signal);
    }
    const tool = toolByName.get(name);
    if (!tool) throw new Error(`Unknown CAD MCP tool: ${name}`);
    if (name === "query_model") {
      return queryCad(args);
    }
    // Retain explicit read-only access for older external clients. Pi sessions always use edit access.
    if (!tool.readOnly && activeMode === "plan") throw new Error(`Plan 模式为只读；${tool.operation||tool.name} 需要切换到 Edit 模式。`);
    if(MESH_MCP_TOOLS.includes(tool))return callMeshMcpTool({tool,args:args||{},root,documentId,fetchImpl,signal});
    if(!tool.readOnly&&args?.baseStateToken===undefined){
      if(!createsPrimitive(tool.operation))throw Object.assign(new Error(SELECTION_STATE_POLICY.recovery),{code:'SELECTION_STATE_REQUIRED'});
      // Creation binds a new object, not old Face/Edge IDs. Capture an admission
      // baseline so a delayed/disconnected creation cannot commit across another edit.
      const response=await fetchImpl(`${root}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId,operation:'document.summary'})}),observed=await response.json();
      if(!response.ok||observed.ok!==true||!/^[a-f0-9]{64}$/.test(observed.stateToken||''))throw Object.assign(new Error('新建几何缺少可信工程基线，未发送创建命令。'),{code:'MCP_OBSERVATION_REQUIRED'});
      remember(observed);args={...args,baseStateToken:observed.stateToken};
    }
    const problem=selectionStateProblem(tool.operation,args || {});
    if(problem)throw Object.assign(new Error(problem.error),problem);
    let needsHoles=tool.operation==='detail.loft'?validateLoftSections(args?.inputs?.sections):false;
    if(tool.operation==='feature.update'){
      if(args?.parameters?.loftDefinition!==undefined)needsHoles=validateLoftDefinition(args.parameters.loftDefinition);
      const required=selectionStateProblem('feature.update',{...args,parameters:{loftDefinition:{}}});if(required)throw Object.assign(new Error(required.error),required);
      const observed=await queryCad({kind:'feature',featureId:args?.inputs?.featureId});
      if(observed.stateToken!==args.baseStateToken)throw Object.assign(new Error('工程已变化，未刷新旧选择的状态标识；请重新读取并确认特征。'),{code:'PROJECT_STATE_CONFLICT'});
      if(!observed.feature||observed.feature.id!==args?.inputs?.featureId)throw Object.assign(new Error('待编辑的特征不存在，命令未发送。'),{code:'FEATURE_NOT_FOUND'});
      if(observed.feature.type==='detail.loft'){
        const version=observed.feature.stringParameters?.loftVersion;
        if(version!==undefined&&!['2','3'].includes(version))throw Object.assign(new Error('该 Loft 定义版本不受支持，未降级编辑。'),{code:'UNSUPPORTED_LOFT_VERSION'});
        needsHoles=needsHoles||version==='3';
      }
    }
    const workerCapabilityPrecondition=needsHoles?loftCapabilityRequirement(await readMcpNativeCapabilities(root,fetchImpl)):undefined;
    let baseRevision=args?.baseRevision;
    if(baseRevision!==undefined&&(!Number.isInteger(baseRevision)||baseRevision<0))throw Object.assign(new Error('baseRevision 必须是读取时的非负整数修订号。'),{code:'MCP_REVISION_REQUIRED',retryableByModel:true});
    if(needsNativeRevision(tool.operation)&&baseRevision===undefined){
      if(typeof args?.baseStateToken!=='string')throw Object.assign(new Error('该命令需要读取时的 baseRevision 或 baseStateToken；请先 query_model，不会猜用当前修订号。'),{code:'MCP_REVISION_REQUIRED',retryableByModel:true});
      if(!revisions.has(args.baseStateToken)){
        const observed=await queryCad({kind:'geometry-tree'});
        if(observed.stateToken!==args.baseStateToken)throw Object.assign(new Error('工程已变化，不能用新修订号补签旧几何选择；请重新读取并确认选择。'),{code:'PROJECT_STATE_CONFLICT'});
      }
      baseRevision=revisions.get(args.baseStateToken);
      if(!Number.isInteger(baseRevision))throw Object.assign(new Error('当前回复缺少可验证的修订号，命令未发送。请重新读取工程。'),{code:'MCP_REVISION_REQUIRED'});
    }
    const command = {
        protocolVersion: 1, documentId, operation: tool.operation,
        inputs: args?.inputs && typeof args.inputs === 'object' ? args.inputs : {},
        parameters: args?.parameters && typeof args.parameters === 'object' ? args.parameters : {},
        ...(Number.isInteger(baseRevision) ? { baseRevision } : {}),
        ...(args?.baseStateToken !== undefined ? { baseStateToken: args.baseStateToken } : {}),
        ...(workerCapabilityPrecondition?{workerCapabilityPrecondition}:{}),
    };
    if(!tool.readOnly)return write(command,signal);
    const response = await fetchImpl(`${root}/commands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: 1,
        documentId,
        operation: tool.operation,
        inputs: args?.inputs && typeof args.inputs === "object" ? args.inputs : {},
        parameters: args?.parameters && typeof args.parameters === "object" ? args.parameters : {},
        ...(Number.isInteger(baseRevision) ? { baseRevision } : {}),
        ...(args?.baseStateToken !== undefined ? { baseStateToken: args.baseStateToken } : {}),
        ...(workerCapabilityPrecondition?{workerCapabilityPrecondition}:{}),
      }),
    });
    const result = await response.json();
    if (!response.ok || result?.ok === false) throw Object.assign(new Error(result?.error || `CAD command ${tool.operation} failed (${response.status})`),{code:result?.code,fieldPath:result?.fieldPath,selectionPaths:result?.selectionPaths,retryableByModel:result?.retryableByModel===true});
    return remember(result);
  }

  return async function handleMcpMessage(message, {signal}={}) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const { id, method, params = {} } = message;
    if (typeof method !== "string") return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } };
    if (method.startsWith("notifications/")) return null;
    try {
      if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "web-cad-current-session", version: "1.0.0" } } };
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: listCadMcpTools({nativeCapabilities:await readMcpNativeCapabilities(root,fetchImpl),embeddedPi:Boolean(piHeaders)}) } };
      if (method === "tools/call") {
        const name = params.name;
        const result = await callCadTool(name, params.arguments || {}, signal);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } };
      }
      return { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (error) {
      if (method === "tools/call") {
        const stateError=["SELECTION_STATE_REQUIRED","PROJECT_STATE_CONFLICT","STALE_REVISION","REVISION_CONFLICT"].includes(error?.code);
        const detail=error?.code?JSON.stringify({ok:false,code:error.code,error:error.message,...(error.outcome?{outcome:error.outcome}:{}),...(error.requestId?{requestId:error.requestId}:{}),...(error.modelingTask?{modelingTask:error.modelingTask}:{}),...(error.meshRequest?{meshRequest:error.meshRequest}:{}),...(error.recovery?{recovery:error.recovery}:{}),...(error.fieldPath?{fieldPath:error.fieldPath}:{}),...(error.selectionPaths?{selectionPaths:error.selectionPaths}:{}),...(stateError?{recovery:SELECTION_STATE_POLICY.recovery}:{}),retryableByModel:!stateError && error.retryableByModel===true}):error instanceof Error?error.message:String(error);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: detail }], isError: true } };
      }
      return { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
  };
}

export async function runCadMcpStdio({ stdin = process.stdin, stdout = process.stdout, options } = {}) {
  const handle = createCadMcpHandler(options);
  return serveBoundedMcp({stdin,stdout,handle,isReadOnly:message=>message.method!=='tools/call'||message.params?.name==='query_model'||Boolean(toolByName.get(message.params?.name)?.readOnly)}).done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCadMcpStdio();
