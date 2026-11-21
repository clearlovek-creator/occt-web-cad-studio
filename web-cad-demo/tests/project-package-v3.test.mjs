import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {encodeProjectPackage,decodeProjectPackage,ProjectFileError} from '../gateway/project-package.mjs';
import {PROJECT_V3_MAGIC} from '../gateway/project-package-v3.mjs';
import {validateProjectMeshArchive,stageProjectMeshArchive} from '../gateway/project-mesh-archive.mjs';
import {ProjectFileService} from '../gateway/project-file-service.mjs';
import {archiveFixture} from './helpers/project-mesh-archive-fixture.mjs';
const geometry=Buffer.from('BINFILE'+'x'.repeat(100)),propertySchema={schemaVersion:1,types:[],instances:[]},projectData={projectDataVersion:1,propertySchema,meshStrategies:{version:1,strategies:[]}};
const encode=(meshArchive,patch={})=>encodeProjectPackage({geometry,projectData,meshArchive,documentId:'doc',revision:1,name:'便携工程',sources:[],...patch});
const header=PROJECT_V3_MAGIC.length+4+32,hash=bytes=>crypto.createHash('sha256').update(bytes).digest();
function rewrite(bytes,change){const old=bytes.readUInt32LE(PROJECT_V3_MAGIC.length),manifest=JSON.parse(bytes.subarray(header,header+old));change(manifest);const json=Buffer.from(JSON.stringify(manifest)),prefix=Buffer.alloc(header);PROJECT_V3_MAGIC.copy(prefix);prefix.writeUInt32LE(json.length,PROJECT_V3_MAGIC.length);hash(json).copy(prefix,PROJECT_V3_MAGIC.length+4);return Buffer.concat([prefix,json,bytes.subarray(header+old)]);}

test('V3 carries exact binary geometry, project data, STEP sources and authenticated raw/derived mesh assets',t=>{
  const f=archiveFixture(t,{derived:true}),archive=f.capture(),step=Buffer.from('ISO-10303-21;'),bytes=encode(archive,{sources:[{featureId:'feature-step',fileName:'模型.step',bytes:step}]}),decoded=decodeProjectPackage(bytes);assert.equal(decoded.packageVersion,3);assert.equal(decoded.legacy,false);assert.deepEqual(decoded.geometry,geometry);assert.deepEqual(decoded.projectData,projectData);assert.deepEqual(decoded.sources[0].bytes,step);assert.equal(decoded.metadata.document.name,'便携工程');assert.equal(validateProjectMeshArchive(decoded.meshArchive).jobs[0].jobId,f.job.jobId);const stage=stageProjectMeshArchive(decoded.meshArchive,f.root);try{assert.equal(stage.summaries[0].normalMeshAdmitted,true);}finally{stage.cleanup();}
});
test('binary mesh segments are not embedded as base64 or re-expanded into duplicate Buffer copies',t=>{
  const f=archiveFixture(t),bytes=encode(f.capture()),manifest=JSON.parse(bytes.subarray(header,header+bytes.readUInt32LE(PROJECT_V3_MAGIC.length))),decoded=decodeProjectPackage(bytes);assert.ok(manifest.blobs.every(blob=>Object.keys(blob).sort().join(',')==='bytes,sha256'));assert.equal(manifest.meshArchive.blobs,undefined);assert.equal(decoded.geometry.buffer,bytes.buffer);assert.ok(decoded.meshArchive.blobs.every(blob=>blob.data.buffer===bytes.buffer));assert.equal(JSON.stringify(manifest).includes('"data":'),false);
});
test('content addressing deduplicates a STEP segment identical to geometry while preserving logical references',t=>{
  const f=archiveFixture(t),bytes=encode(f.capture(),{sources:[{featureId:'step',fileName:'part.step',bytes:geometry}]}),decoded=decodeProjectPackage(bytes),manifest=JSON.parse(bytes.subarray(header,header+bytes.readUInt32LE(PROJECT_V3_MAGIC.length)));assert.equal(manifest.geometry,manifest.sources[0].blob);assert.deepEqual(decoded.geometry,decoded.sources[0].bytes);
});
test('legacy XBF and V1/V2 compressed engineering packages retain their exact supported contracts',t=>{
  const f=archiveFixture(t);assert.equal(decodeProjectPackage(geometry).legacy,true);assert.equal(decodeProjectPackage(encodeProjectPackage({geometry,propertySchema,documentId:'doc',revision:1})).packageVersion,1);assert.equal(decodeProjectPackage(encodeProjectPackage({geometry,projectData,documentId:'doc',revision:1})).packageVersion,2);assert.equal(decodeProjectPackage(encode(f.capture())).packageVersion,3);
});
test('corrupt header, manifest, binary tail and undeclared trailing bytes fail before adopting a mesh archive',t=>{
  const f=archiveFixture(t),original=encode(f.capture());for(const change of [bytes=>bytes[PROJECT_V3_MAGIC.length+4]^=1,bytes=>bytes[header]^=1,bytes=>bytes[bytes.length-1]^=1,bytes=>bytes.writeUInt32LE(0xffffffff,PROJECT_V3_MAGIC.length)]){const bytes=Buffer.from(original);change(bytes);assert.throws(()=>decodeProjectPackage(bytes),ProjectFileError);}assert.throws(()=>decodeProjectPackage(Buffer.concat([original,Buffer.from('extra')])));assert.throws(()=>decodeProjectPackage(original.subarray(0,original.length-1)));
});
test('consistent outer manifest rewrites cannot add paths, aliases, unknown versions or missing blob references',t=>{
  const f=archiveFixture(t),bytes=encode(f.capture());for(const change of [m=>m.version=4,m=>m.geometry='0'.repeat(64),m=>m.document.id='foreign',m=>m.sources=[{featureId:'step',fileName:'../secret.step',blob:m.geometry}],m=>m.meshArchive.assets[0].files['../../secret']=m.geometry,m=>m.blobs[0].path='C:/private',m=>m.meshArchive.extra=true])assert.throws(()=>decodeProjectPackage(rewrite(bytes,change)));
});
test('duplicate segment identities and false lengths are rejected without parsing their data as geometry',t=>{
  const f=archiveFixture(t),bytes=encode(f.capture());for(const change of [m=>m.blobs[1].sha256=m.blobs[0].sha256,m=>m.blobs[0].bytes=Number.MAX_SAFE_INTEGER,m=>m.blobs[0].bytes=-1,m=>m.blobs[0].bytes=.5,m=>m.blobs[0].bytes=0,m=>m.blobs[0].bytes++])assert.throws(()=>decodeProjectPackage(rewrite(bytes,change)));
});
test('V3 enforces total and logical expanded budgets even when binary content is deduplicated',t=>{
  const f=archiveFixture(t),archive=f.capture(),bytes=encode(archive);assert.throws(()=>decodeProjectPackage(bytes,{maxUnpackedBytes:bytes.length-1}),{code:'PROJECT_TOO_LARGE'});assert.throws(()=>encodeProjectPackage({geometry,projectData,meshArchive:archive,documentId:'doc',revision:1},{maxUnpackedBytes:100}),{code:'PROJECT_TOO_LARGE'});
  const largeGeometry=Buffer.concat([Buffer.from('BINFILE'),Buffer.alloc(1024**2)]),sources=Array.from({length:10},(_,i)=>({featureId:'step-'+i,fileName:'part-'+i+'.step',bytes:largeGeometry})),input={geometry:largeGeometry,projectData,meshArchive:archive,documentId:'doc',revision:1,sources};assert.throws(()=>encodeProjectPackage(input,{maxUnpackedBytes:2*1024**2}),{code:'PROJECT_TOO_LARGE'});const deduplicated=encodeProjectPackage(input);assert.ok(deduplicated.length<2*1024**2);assert.throws(()=>decodeProjectPackage(deduplicated,{maxUnpackedBytes:2*1024**2}),{code:'PROJECT_TOO_LARGE'});
});
test('project identity, geometry, source names and incompatible property aliases cannot silently lose data',t=>{
  const f=archiveFixture(t),archive=f.capture();for(const patch of [{documentId:'other'},{revision:-1},{revision:2},{name:'bad\nname'},{geometry:Buffer.from('not-xbf')},{projectData:undefined},{propertySchema:{schemaVersion:1,types:[{key:'different'}],instances:[]}}, {sources:[{featureId:'step',fileName:'bad.txt',bytes:geometry}]},{sources:[{featureId:'step',fileName:'a.step',bytes:geometry},{featureId:'step',fileName:'b.step',bytes:geometry}]}])assert.throws(()=>encode(archive,patch));
});
test('the current live-open path refuses V3 assets before touching geometry, properties or transaction files',async t=>{
  const f=archiveFixture(t),before=fs.readdirSync(f.root).sort();let commands=0;const service=new ProjectFileService({dataDir:f.root,historyStore:{},propertySchemaStore:{},command:()=>{commands++;}}),afterConstruction=fs.readdirSync(f.root).sort();await assert.rejects(service.open('target',encode(f.capture())),{code:'PROJECT_MESH_ASSET_UPGRADE_REQUIRED'});assert.equal(commands,0);assert.equal(fs.existsSync(service.journalPath('target')),false);assert.deepEqual(fs.readdirSync(f.root).sort(),afterConstruction);assert.ok(before.every(name=>afterConstruction.includes(name)));
});
