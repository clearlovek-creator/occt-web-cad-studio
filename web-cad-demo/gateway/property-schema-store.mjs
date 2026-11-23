import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {associationDefinition,MAX_PROPERTY_TARGETS,propertyTargetKey} from '../shared/property-targets.mjs';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const FIELD_TYPES = new Set(["bool", "int", "double", "expression", "enum", "vector3"]);
const SCOPES = new Set(["project", "body", "face", "edge"]);

function now() { return new Date().toISOString(); }
function id(value, name) {
  const result = String(value || "");
  if (!ID_PATTERN.test(result)) throw new Error(`${name} is invalid.`);
  return result;
}
function text(value, name, max = 240) {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`${name} is required and must be at most ${max} characters.`);
  return result;
}
function optionalText(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function makeId(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`; }

function normalizeField(field, index) {
  if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error(`fields[${index}] must be an object.`);
  const key = text(field.key, `fields[${index}].key`, 64);
  if (!KEY_PATTERN.test(key)) throw new Error(`fields[${index}].key must use letters, digits, dot, dash or underscore.`);
  const type = String(field.type || "");
  if (!FIELD_TYPES.has(type)) throw new Error(`fields[${index}].type is unsupported.`);
  const result = { key, label: text(field.label || key, `fields[${index}].label`, 120), type };
  if (type === "enum") {
    if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 100) throw new Error(`fields[${index}].options is required for enum fields.`);
    result.options = field.options.map((option) => text(option, `fields[${index}].options`, 120));
  }
  if (field.required !== undefined) result.required = Boolean(field.required);
  if (field.default !== undefined) result.default = clone(field.default);
  return result;
}

function normalizeTarget(target, expectedScope = null) {
  if (target === null || target === undefined || target === "") return null;
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("target must be an object or null.");
  const kind = String(target.kind || "");
  if (!SCOPES.has(kind) || kind === "project") throw new Error("target.kind must be body, face or edge.");
  if (expectedScope && expectedScope !== "project" && expectedScope !== kind) throw new Error(`target.kind must be ${expectedScope}.`);
  if (target.topologyRevision !== undefined && (!Number.isSafeInteger(target.topologyRevision) || target.topologyRevision < 0)) throw new Error("Invalid target topology revision.");
  const identities={};
  for(const key of ["bodyIdentity","topologyIdentity"])if(target[key]!==undefined){if(typeof target[key]!=="string" || !/^[a-f0-9]{32}$/.test(target[key]))throw new Error(`Invalid target ${key}.`);identities[key]=target[key];}
  if (kind === "body") return { kind, bodyId: text(target.bodyId, "target.bodyId", 96), ...(identities.bodyIdentity?{bodyIdentity:identities.bodyIdentity}:{}) };
  return { kind, bodyId: text(target.bodyId, "target.bodyId", 96), topologyId: text(target.topologyId, "target.topologyId", 128), ...identities, ...(target.topologyRevision !== undefined ? { topologyRevision: Number(target.topologyRevision) } : {}) };
}

function defaultState() { return { schemaVersion: 1, updatedAt: now(), types: [], instances: [] }; }

function normalizeAssociation(type,input,existing) {
  const multiple=type.targetMode==='multiple';
  if(!multiple && input.targets!==undefined)throw new Error('This property type accepts one target; targets requires a multiple-target type.');
  if(input.targets!==undefined && input.target!=null)throw new Error('Specify target or targets, not both.');
  if(!multiple){
    const target=input.target!==undefined?normalizeTarget(input.target,type.targetScope):existing?.target || null;
    if(type.association==='required'&&!target)throw new Error('This property requires a geometry target.');
    if(type.association==='none'&&target)throw new Error('This property type does not accept a geometry target.');
    return {target};
  }
  if(input.targets===undefined&&input.target!==undefined)throw new Error('Multiple-target properties require targets, not the legacy target field.');
  const supplied=input.targets!==undefined?input.targets:existing?.targets || [];
  if(!Array.isArray(supplied)||supplied.length>MAX_PROPERTY_TARGETS)throw new Error(`targets must contain at most ${MAX_PROPERTY_TARGETS} geometry associations.`);
  const targets=supplied.map(target=>{const normalized=normalizeTarget(target,type.targetScope);if(!normalized)throw new Error('targets cannot contain null members.');return normalized;});
  if(new Set(targets.map(propertyTargetKey)).size!==targets.length)throw new Error('Duplicate geometry association.');
  if(type.association==='required'&&!targets.length)throw new Error('This property requires at least one geometry target.');
  return {target:null,targets};
}

export class PropertySchemaStore {
  constructor(dataDir) {
    this.rootDir = path.join(dataDir, "property-schemas");
    this.records = new Map();
    this.versions = new Map();
    this.loadErrors = new Map();
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.load();
  }

  filePath(documentId) { return path.join(this.rootDir, `${id(documentId, "documentId")}.json`); }

  load() {
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.rootDir, entry.name), "utf8"));
        this.records.set(entry.name.slice(0, -5), this.validateSnapshot(parsed));
      } catch(error) { this.loadErrors.set(entry.name.slice(0, -5),error.message); }
    }
  }

  get(documentId) {
    const key = id(documentId || "default", "documentId");
    if(this.loadErrors.has(key))throw Object.assign(new Error(`属性数据损坏，原文件已保留，需由完整工程检查点恢复：${this.loadErrors.get(key)}`),{code:"PROPERTY_SCHEMA_CORRUPT"});
    if (!this.records.has(key)) this.records.set(key, defaultState());
    return this.records.get(key);
  }

  save(documentId,{preserveUpdatedAt=false}={}) {
    const key = id(documentId || "default", "documentId");
    const record = this.records.get(key) || defaultState();
    if(!preserveUpdatedAt)record.updatedAt = now();
    const target = this.filePath(key);
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    let fd;
    try {fd=fs.openSync(temporary,"wx");fs.writeFileSync(fd,JSON.stringify(record,null,2));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,target);}
    finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
    this.loadErrors.delete(key);
    this.versions.set(key,(this.versions.get(key)||0)+1);
    return clone(record);
  }

  mutate(documentId,update) {
    const key=id(documentId||"default","documentId"),previous=this.get(key),next=clone(previous);
    const result=update(next),validated=this.validateSnapshot(next);
    this.records.set(key,validated);
    try{this.save(key);}catch(error){this.records.set(key,previous);throw error;}
    return clone(result);
  }

  list(documentId) {
    const record = this.get(documentId);
    return { types: clone(record.types), instances: clone(record.instances), schemaVersion: record.schemaVersion, updatedAt: record.updatedAt };
  }
  contentVersion(documentId) {return this.versions.get(documentId)||0;}

  validateSnapshot(input) {
    if (!input || ![1,2].includes(input.schemaVersion) || !Array.isArray(input.types) || !Array.isArray(input.instances) || input.types.length > 1000 || input.instances.length > 10000) throw new Error("Invalid project property schema snapshot.");
    const typeIds=new Set(), keys=new Set(), instanceIds=new Set();
    const types=input.types.map(item=>{
      const typeId=id(item.typeId,"typeId"), key=text(item.key,"key",128);
      if(!KEY_PATTERN.test(key) || typeIds.has(typeId) || keys.has(key)) throw new Error("Property type IDs and keys must be valid and unique.");
      typeIds.add(typeId);keys.add(key);
      if(!SCOPES.has(item.targetScope) || !["none","optional","required"].includes(item.association) || (item.targetScope==="project" && item.association!=="none")) throw new Error("Invalid property target scope or association.");
      if(!Array.isArray(item.fields) || item.fields.length>100) throw new Error("Invalid property fields.");
      const fields=item.fields.map(normalizeField);
      if(new Set(fields.map(field=>field.key)).size!==fields.length) throw new Error("Duplicate property field keys.");
      if(!Number.isSafeInteger(item.version) || item.version<1) throw new Error("Invalid property type version.");
      for(const field of fields) if(field.default!==undefined) this.validateValue({fields:[{...field,required:false}]},{[field.key]:field.default});
      const definition=associationDefinition(item);if(input.schemaVersion===1&&definition.targetMode)throw new Error('Multiple-target properties require schemaVersion 2.');
      return {typeId,key,name:text(item.name,"type.name",160),description:optionalText(item.description),targetScope:item.targetScope,association:item.association,...definition,fields,version:item.version,origin:optionalText(item.origin,64)||"project",createdAt:optionalText(item.createdAt,64)||now(),updatedAt:optionalText(item.updatedAt,64)||now()};
    });
    const byId=new Map(types.map(type=>[type.typeId,type]));
    const instances=input.instances.map(item=>{
      const instanceId=id(item.instanceId,"instanceId"), type=byId.get(item.typeId);
      if(instanceIds.has(instanceId) || !type) throw new Error("Property instance IDs must be unique and refer to an existing type.");instanceIds.add(instanceId);
      if(type.targetMode==='multiple'&&!Array.isArray(item.targets))throw new Error('A v2 association collection requires targets.');
      const association=normalizeAssociation(type,item);
      const state=item.state || "active";
      if(!["active","orphaned","conflict","superseded","needs-review"].includes(state)) throw new Error("Invalid property instance state.");
      const typeVersion=item.typeVersion ?? type.version;
      if(!Number.isSafeInteger(typeVersion) || typeVersion<1 || typeVersion>type.version) throw new Error("Invalid instance type version.");
      return {instanceId,typeId:type.typeId,typeKey:type.key,typeVersion,name:text(item.name,"instance.name",160),value:this.validateValue(type,item.value),...association,state,...(item.stateReason ? {stateReason:optionalText(item.stateReason)} : {}),createdAt:optionalText(item.createdAt,64)||now(),updatedAt:optionalText(item.updatedAt,64)||now()};
    });
    return {schemaVersion:input.schemaVersion,types,instances,updatedAt:optionalText(input.updatedAt,64)||now()};
  }

  replaceSnapshot(documentId,input,options={}) {
    const key=id(documentId,"documentId"), next=this.validateSnapshot(input), previous=this.records.get(key);
    this.records.set(key,next);
    if(this.loadErrors.has(key)&&fs.existsSync(this.filePath(key))){const bytes=fs.readFileSync(this.filePath(key)),backup=this.filePath(key)+"."+crypto.createHash("sha256").update(bytes).digest("hex")+".corrupt";if(!fs.existsSync(backup))fs.writeFileSync(backup,bytes);}
    try { this.save(key,options); } catch(error) {if(previous) this.records.set(key,previous);else this.records.delete(key);throw error;}
    return this.list(key);
  }

  reset(documentId) {
    return this.replaceSnapshot(id(documentId||'default','documentId'),defaultState());
  }

  createType(documentId, input = {}) {
    const followsDescendants = input.targetMode === 'multiple' && ['face', 'edge'].includes(input.targetScope);
    const definition = followsDescendants && input.splitPolicy === undefined ? {...input, splitPolicy: 'all-descendants'} : input;
    return this.mutate(documentId, record => this.createTypeIn(record, definition));
  }

  createTypeIn(record,input) {
    const key = text(input.key, "key", 128);
    if (!KEY_PATTERN.test(key)) throw new Error("key must start with a letter and contain only letters, digits, dot, dash or underscore.");
    if (record.types.some((item) => item.key === key)) throw new Error(`Property type key already exists: ${key}.`);
    const fields = Array.isArray(input.fields) && input.fields.length ? input.fields.map(normalizeField) : [];
    if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error("Property type fields must have unique keys.");
    const targetScope = String(input.targetScope || "project");
    if (!SCOPES.has(targetScope)) throw new Error("targetScope is invalid.");
    const association = String(input.association || (targetScope === "project" ? "none" : "optional"));
    if (!["none", "optional", "required"].includes(association)) throw new Error("association must be none, optional or required.");
    if (targetScope === "project" && association !== "none") throw new Error("project properties cannot require geometry association.");
    const definition=associationDefinition({...input,targetScope,association});if(definition.targetMode)record.schemaVersion=2;
    const item = { typeId: makeId("ptype"), key, name: text(input.name || key, "name", 160), description: optionalText(input.description), targetScope, association, ...definition, fields, version: 1, origin: "project", createdAt: now(), updatedAt: now() };
    record.types.push(item); return item;
  }

  updateType(documentId, input = {}) {
    return this.mutate(documentId,record=>this.updateTypeIn(record,input));
  }

  previewTypeUpdate(documentId, input = {}) {
    const before=clone(this.get(documentId)),next=clone(before);
    const type=this.updateTypeIn(next,input);
    this.validateSnapshot(next);
    const original=before.types.find(item=>item.typeId===type.typeId);
    const addedFields=type.fields.filter(field=>!original.fields.some(old=>old.key===field.key));
    const affected=next.instances.filter(instance=>instance.typeId===type.typeId);
    return {type,instanceCount:affected.length,addedFields,changed:JSON.stringify(original.fields)!==JSON.stringify(type.fields),
      examples:affected.slice(0,5).map(instance=>({instanceId:instance.instanceId,name:instance.name,addedValues:Object.fromEntries(addedFields.filter(field=>instance.value[field.key]!==undefined).map(field=>[field.key,instance.value[field.key]]))}))};
  }

  updateTypeIn(record, input = {}) {
    const typeId = id(input.typeId, "typeId");
    const item = record.types.find((candidate) => candidate.typeId === typeId);
    if (!item) throw new Error("Property type does not exist.");
    if((input.targetMode!==undefined&&input.targetMode!==(item.targetMode||'single')) || (input.splitPolicy!==undefined&&input.splitPolicy!==(item.splitPolicy||'review')))throw new Error('Association mode and split policy are immutable; create a new property type.');
    const hasInstances = record.instances.some((instance) => instance.typeId === typeId);
    if (input.key !== undefined && String(input.key) !== item.key) throw new Error("Property type key is immutable.");
    if (input.fields !== undefined && JSON.stringify(input.fields.map(normalizeField)) !== JSON.stringify(item.fields)) {
      const nextFields = input.fields.map(normalizeField);
      if (hasInstances) {
        const previous = new Map(item.fields.map((field) => [field.key, JSON.stringify(field)]));
        const changedExisting = nextFields.some((field) => previous.has(field.key) && previous.get(field.key) !== JSON.stringify(field));
        const removed = item.fields.some((field) => !nextFields.some((candidate) => candidate.key === field.key));
        if (changedExisting || removed) throw new Error("Existing property fields cannot be changed or removed while instances exist; add a new field instead.");
      }
      item.fields = nextFields; item.version += 1;
      for(const instance of record.instances.filter(instance=>instance.typeId===typeId)){instance.value=this.validateValue(item,instance.value);instance.typeVersion=item.version;instance.updatedAt=now();}
    }
    if (input.name !== undefined) item.name = text(input.name, "name", 160);
    if (input.description !== undefined) item.description = optionalText(input.description);
    item.updatedAt = now(); return item;
  }

  deleteType(documentId, input = {}) {
    return this.mutate(documentId,record=>{
    const typeId = id(input.typeId, "typeId");
    if (record.instances.some((instance) => instance.typeId === typeId)) throw new Error("Cannot delete a property type while instances exist.");
    const index = record.types.findIndex((item) => item.typeId === typeId); if (index < 0) throw new Error("Property type does not exist.");
    const [deleted] = record.types.splice(index, 1); return deleted;
    });
  }

  findType(record, input) {
    const typeId = input.typeId ? String(input.typeId) : ""; const key = input.typeKey ? String(input.typeKey) : "";
    const item = record.types.find((candidate) => (typeId && candidate.typeId === typeId) || (key && candidate.key === key));
    if (!item) throw new Error("Property type does not exist."); return item;
  }

  validateValue(type, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("value must be an object keyed by field key.");
    value=clone(value);
    const keys = new Set(type.fields.map((field) => field.key));
    for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`value.${key} is not defined by the property type; instance field keys are immutable.`);
    const numeric = (entry) => (typeof entry === "number" || (typeof entry === "string" && entry.trim() !== "")) && Number.isFinite(Number(entry));
    for (const field of type.fields) {
      if(value[field.key]===undefined&&field.default!==undefined)value[field.key]=clone(field.default);
      if (field.required && value[field.key] === undefined) throw new Error(`value.${field.key} is required.`);
      if (value[field.key] === undefined) continue;
      const current = value[field.key];
      if (field.type === "bool" && typeof current !== "boolean") throw new Error(`value.${field.key} must be boolean.`);
      if (field.type === "int" && (!Number.isSafeInteger(current) && !(typeof current === "string" && /^[-+]?\d+$/.test(current)))) throw new Error(`value.${field.key} must be a safe integer number or an exact integer string.`);
      if (field.type === "double" && !numeric(current)) throw new Error(`value.${field.key} must be numeric.`);
      if (field.type === "vector3" && (!Array.isArray(current) || current.length !== 3 || current.some((entry) => !numeric(entry)))) throw new Error(`value.${field.key} must be a 3-vector.`);
      if (field.type === "enum" && !field.options.includes(String(current))) throw new Error(`value.${field.key} must be one of the enum options.`);
      if (field.type === "expression" && typeof current !== "string") throw new Error(`value.${field.key} must be an expression string.`);
    }
    return clone(value);
  }

  createInstance(documentId, input = {}) {
    return this.mutate(documentId,record=>{
    const type = this.findType(record, input);
    const association = normalizeAssociation(type,input);
    const value = this.validateValue(type, input.value || {});
    const item = { instanceId: makeId("prop"), typeId: type.typeId, typeKey: type.key, typeVersion: type.version, name: text(input.name || `${type.name} ${record.instances.filter((candidate) => candidate.typeId === type.typeId).length + 1}`, "name", 160), value, ...association, state: "active", createdAt: now(), updatedAt: now() };
    record.instances.push(item); return item;
    });
  }

  updateInstance(documentId, input = {}) {
    return this.mutate(documentId,record=>{
    const instanceId = id(input.instanceId, "instanceId");
    const item = record.instances.find((candidate) => candidate.instanceId === instanceId); if (!item) throw new Error("Property instance does not exist.");
    if (input.typeId !== undefined && String(input.typeId) !== item.typeId) throw new Error("Property instance type is immutable.");
    const type = record.types.find((candidate) => candidate.typeId === item.typeId); if (!type) throw new Error("Property type does not exist.");
    // Validate the complete edit before changing any persisted instance field.
    const value = input.value !== undefined ? this.validateValue(type, input.value) : item.value;
    const name = input.name !== undefined ? text(input.name, "name", 160) : item.name;
    const association = normalizeAssociation(type,input,item);
    Object.assign(item, { value, name, ...association });
    if (input.target !== undefined || input.targets!==undefined) {item.state="active";delete item.stateReason;}
    item.updatedAt = now(); return item;
    });
  }

  retargetInstance(documentId, input = {}) {
    return this.mutate(documentId,record=>{
    const instanceId = id(input.instanceId, "instanceId");
    const item = record.instances.find((candidate) => candidate.instanceId === instanceId); if (!item) throw new Error("Property instance does not exist.");
    const type = record.types.find((candidate) => candidate.typeId === item.typeId); if (!type) throw new Error("Property type does not exist.");
    if(type.targetMode==='multiple'&&!Array.isArray(input.targets))throw new Error('Retargeting an association collection requires targets.');
    Object.assign(item,normalizeAssociation(type,input));item.state = "active"; delete item.stateReason; item.updatedAt = now(); return item;
    });
  }

  deleteInstance(documentId, input = {}) {
    return this.mutate(documentId,record=>{
    const index = record.instances.findIndex((item) => item.instanceId === id(input.instanceId, "instanceId"));
    if (index < 0) throw new Error("Property instance does not exist."); const [deleted] = record.instances.splice(index, 1); return deleted;
    });
  }

  exportTypes(documentId, input = {}) {
    const record = this.get(documentId); const selected = Array.isArray(input.typeKeys) && input.typeKeys.length ? new Set(input.typeKeys.map(String)) : null;
    const types=clone(record.types.filter((item) => !selected || selected.has(item.key)).map(({ typeId, createdAt, updatedAt, origin, ...definition }) => definition));
    return { format: "cad-property-types", schemaVersion:types.some(type=>type.targetMode==='multiple')?2:1, exportedAt: now(), types };
  }

  importTypes(documentId, input = {}) {
    const payload = input.package || input; if (payload?.format !== "cad-property-types" || ![1,2].includes(payload.schemaVersion) || !Array.isArray(payload.types) || (payload.schemaVersion===1&&payload.types.some(type=>type.targetMode==='multiple'))) throw new Error("Invalid cad-property-types package.");
    return this.mutate(documentId,record=>{
    const conflict = String(input.conflict || "skip"); if (!["skip", "replace", "error"].includes(conflict)) throw new Error("conflict must be skip, replace or error.");
    const imported = []; const skipped = [];
    for (const definition of payload.types) {
      const key = text(definition.key, "type.key", 128); const existing = record.types.find((item) => item.key === key);
      if (existing) { if (conflict === "error") throw new Error(`Property type key already exists: ${key}.`); if (conflict === "skip") { skipped.push(key); continue; } if (record.instances.some((item) => item.typeId === existing.typeId)) throw new Error(`Cannot replace property type with instances: ${key}.`); record.types = record.types.filter((item) => item !== existing); }
      imported.push(this.createTypeIn(record, definition));
    }
    return { imported, skipped };
    });
  }
}

export { FIELD_TYPES, SCOPES };
