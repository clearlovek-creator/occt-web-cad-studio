import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PropertySchemaStore } from "../gateway/property-schema-store.mjs";

test("migration preview uses real validation, is read-only, and matches all six committed default types",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cad-property-preview-"));
  try{
    const store=new PropertySchemaStore(root),type=store.createType("default",{key:"Setup",fields:[]});
    for(let i=0;i<7;i++)store.createInstance("default",{typeId:type.typeId,name:`Setup${i}`,value:{}});
    const fields=[{key:"flag",type:"bool",default:false},{key:"count",type:"int",default:"9223372036854775807"},{key:"number",type:"double",default:3.5},{key:"expr",type:"expression",default:"W / 2"},{key:"mode",type:"enum",options:["A","B"],default:"B"},{key:"axis",type:"vector3",default:[0,0,1]}].map(field=>({...field,required:true}));
    const before=store.list("default"),bytes=fs.readFileSync(store.filePath("default")),version=store.contentVersion("default");
    const preview=store.previewTypeUpdate("default",{typeId:type.typeId,fields});
    assert.equal(preview.instanceCount,7);assert.equal(preview.examples.length,5);assert.equal(preview.addedFields.length,6);
    assert.deepEqual(store.list("default"),before);assert.deepEqual(fs.readFileSync(store.filePath("default")),bytes);assert.equal(store.contentVersion("default"),version);
    assert.throws(()=>store.previewTypeUpdate("default",{typeId:type.typeId,fields:[{key:"required",type:"double",required:true}]}),/required/);
    assert.deepEqual(fs.readFileSync(store.filePath("default")),bytes);
    store.updateType("default",{typeId:type.typeId,fields});
    for(const instance of store.list("default").instances)assert.deepEqual(instance.value,preview.examples[0].addedValues);
    assert.throws(()=>store.updateInstance("default",{instanceId:before.instances[0].instanceId,value:{...preview.examples[0].addedValues,count:9007199254740992}}),/safe integer/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("one property type supports multiple independent instances and immutable key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cad-property-schema-"));
  const store = new PropertySchemaStore(root);
  const type = store.createType("default", { key: "WavePort", name: "Wave Port", targetScope: "face", association: "required", fields: [{ key: "frequency", label: "Frequency", type: "double", required: true }] });
  const first = store.createInstance("default", { typeId: type.typeId, name: "Port1", value: { frequency: 10 }, target: { kind: "face", bodyId: "body-1", topologyId: "face-1" } });
  const second = store.createInstance("default", { typeId: type.typeId, name: "Port2", value: { frequency: 20 }, target: { kind: "face", bodyId: "body-2", topologyId: "face-2" } });
  assert.equal(store.list("default").types.length, 1);
  assert.equal(store.list("default").instances.length, 2);
  assert.notEqual(first.instanceId, second.instanceId);
  store.updateInstance("default", { instanceId: first.instanceId, value: { frequency: 15 } });
  assert.equal(store.list("default").instances.find((item) => item.instanceId === second.instanceId).value.frequency, 20);
  assert.throws(() => store.updateType("default", { typeId: type.typeId, key: "Other" }), /immutable/);
  const extended = store.updateType("default", { typeId: type.typeId, fields: [...type.fields, { key: "mode", label: "Mode", type: "int", required: false }] });
  assert.equal(extended.fields.length, 2);
});

test("project properties can be unassociated and type packages round-trip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cad-property-package-"));
  const store = new PropertySchemaStore(root);
  store.createType("default", { key: "SolverSettings", name: "Solver Settings", targetScope: "project", association: "none", fields: [{ key: "adaptive", label: "Adaptive", type: "bool", required: true }] });
  const exported = store.exportTypes("default");
  assert.equal(exported.format, "cad-property-types");
  const other = new PropertySchemaStore(path.join(root, "other"));
  const result = other.importTypes("default", { package: exported });
  assert.equal(result.imported.length, 1);
  assert.equal(other.list("default").types[0].key, "SolverSettings");
  assert.throws(() => other.createInstance("default", { typeKey: "SolverSettings", value: { adaptive: true }, target: { kind: "body", bodyId: "body-1" } }), /does not accept/);
});

test("instances cannot introduce keys outside their type and failed edits are atomic", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cad-property-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PropertySchemaStore(root);
  const type = store.createType("default", { key: "WavePort", targetScope: "face", association: "required", fields: [{ key: "frequency", type: "double", required: true }] });
  const original = store.createInstance("default", { typeId: type.typeId, name: "Port1", value: { frequency: 3 }, target: { kind: "face", bodyId: "body-1", topologyId: "face-1" } });
  assert.throws(() => store.updateInstance("default", { instanceId: original.instanceId, name: "Changed", value: { frequency: 4, inventedKey: 1 } }), /not defined/);
  assert.throws(() => store.updateInstance("default", { instanceId: original.instanceId, name: "Changed", value: { frequency: 4 }, target: null }), /requires a geometry target/);
  assert.deepEqual(store.list("default").instances[0], original);
  const edited = store.updateInstance("default", { instanceId: original.instanceId, name: "Edited", value: { frequency: 6 }, target: { kind: "face", bodyId: "body-2", topologyId: "face-2" } });
  assert.equal(edited.name, "Edited");
  assert.equal(edited.value.frequency, 6);
  assert.equal(edited.target.bodyId, "body-2");
  assert.deepEqual(new PropertySchemaStore(root).list("default").instances[0], edited);
  for (const frequency of [null, false, "", " ", {}, []]) assert.throws(() => store.updateInstance("default", { instanceId: original.instanceId, value: { frequency } }), /must be numeric/);
});

test('type edits and multi-type imports validate completely before changing memory or disk',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-property-validation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new PropertySchemaStore(root),type=store.createType('default',{key:'Setup',fields:[{key:'count',type:'int'}]}),before=store.list('default'),bytes=fs.readFileSync(store.filePath('default'));
  assert.throws(()=>store.updateType('default',{typeId:type.typeId,name:'',fields:[...type.fields,{key:'enabled',type:'bool'}]}),/name/);
  assert.throws(()=>store.importTypes('default',{package:{format:'cad-property-types',schemaVersion:1,types:[{key:'NewGood',fields:[]},{key:'NewBad',fields:[{key:'x',type:'unknown'}]}]}}),/unsupported/);
  assert.deepEqual(store.list('default'),before);assert.deepEqual(fs.readFileSync(store.filePath('default')),bytes);
});

test('property file replacement failures leave all public mutations atomic',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-property-write-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new PropertySchemaStore(root),type=store.createType('default',{key:'Setup',fields:[{key:'count',type:'int'}]}),instance=store.createInstance('default',{typeId:type.typeId,value:{count:1}}),before=store.list('default'),bytes=fs.readFileSync(store.filePath('default')),version=store.contentVersion('default');
  const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===store.filePath('default'))throw Object.assign(new Error('injected file replacement failure'),{code:'EPERM'});return rename(from,to);};
  try{for(const action of [()=>store.createType('default',{key:'Another'}),()=>store.updateType('default',{typeId:type.typeId,name:'Changed'}),()=>store.updateInstance('default',{instanceId:instance.instanceId,value:{count:2}}),()=>store.retargetInstance('default',{instanceId:instance.instanceId,target:null}),()=>store.deleteInstance('default',{instanceId:instance.instanceId}),()=>store.reset('default')]){assert.throws(action,/injected/);assert.deepEqual(store.list('default'),before);assert.deepEqual(fs.readFileSync(store.filePath('default')),bytes);assert.equal(store.contentVersion('default'),version);}}
  finally{fs.renameSync=rename;}
  assert.ok(!fs.readdirSync(path.dirname(store.filePath('default'))).some(file=>file.includes('.tmp-')));
});

test('adding required fields migrates every instance only with a valid default',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-property-defaults-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new PropertySchemaStore(root),type=store.createType('default',{key:'Setup',fields:[]});store.createInstance('default',{typeId:type.typeId,name:'A',value:{}});store.createInstance('default',{typeId:type.typeId,name:'B',value:{}});
  const before=store.list('default');assert.throws(()=>store.updateType('default',{typeId:type.typeId,fields:[{key:'enabled',type:'bool',required:true}]}),/required/);assert.deepEqual(store.list('default'),before);
  const next=store.updateType('default',{typeId:type.typeId,fields:[{key:'enabled',type:'bool',required:true,default:true}]});
  for(const item of store.list('default').instances){assert.equal(item.value.enabled,true);assert.equal(item.typeVersion,next.version);}
  assert.equal(store.createInstance('default',{typeId:type.typeId,value:{}}).value.enabled,true);
});

test('damaged property files stay unavailable and are preserved when a verified snapshot restores them',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-property-corrupt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new PropertySchemaStore(root);store.createType('default',{key:'Setup',fields:[]});const good=store.list('default');fs.writeFileSync(store.filePath('default'),'{ damaged');
  const restored=new PropertySchemaStore(root);assert.throws(()=>restored.list('default'),error=>error.code==='PROPERTY_SCHEMA_CORRUPT');assert.equal(fs.readFileSync(store.filePath('default'),'utf8'),'{ damaged');
  restored.replaceSnapshot('default',good,{preserveUpdatedAt:true});assert.deepEqual(restored.list('default'),good);assert.ok(fs.readdirSync(path.dirname(store.filePath('default'))).some(file=>file.endsWith('.corrupt')));
});
