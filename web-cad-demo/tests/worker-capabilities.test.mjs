import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGeometryFeatures,capabilitySnapshot,loftHoleLimits,assertCapabilityPrecondition,assertImportedNamingUpgrade,LOFT_HOLES_CAPABILITY,IMPORTED_NAMING_CAPABILITY} from '../gateway/worker-capabilities.mjs';
import {mutationFingerprint} from '../gateway/project-state.mjs';
const instance='11111111-1111-4111-8111-111111111111',health={ok:true,protocolVersion:1,service:'occt-geometry-worker',capabilities:{version:1,loftThroughHoles:{version:1,maxSections:32,maxHolesPerSection:16},faceBoundaryLoops:{version:1}}};

test('immutable STEP naming is reported only from its exact native declaration and never inferred from old import support',()=>{
  assert.equal(nativeGeometryFeatures(health)[IMPORTED_NAMING_CAPABILITY],undefined);
  const declaration={version:1,basis:'immutable-step-brep-v1',sourceFingerprintAlgorithm:'sha256-chain-1m-v1',private:'do not expose'};
  const current={...health,capabilities:{...health.capabilities,importedTopologyNaming:declaration}};
  assert.deepEqual(nativeGeometryFeatures(current)[IMPORTED_NAMING_CAPABILITY],{version:1,basis:'immutable-step-brep-v1',sourceFingerprintAlgorithm:'sha256-chain-1m-v1'});
  for(const patch of [{version:2},{basis:'index'},{sourceFingerprintAlgorithm:'unknown'}])assert.equal(nativeGeometryFeatures({...current,capabilities:{...current.capabilities,importedTopologyNaming:{...declaration,...patch}}})[IMPORTED_NAMING_CAPABILITY],undefined);
});
test('only exact allowlisted declarations from a successful native handshake expose through-hole limits',()=>{
  assert.deepEqual(nativeGeometryFeatures({ok:true}),{});const features=nativeGeometryFeatures({...health,unknown:'secret',capabilities:{...health.capabilities,secret:'never forward'}});assert.deepEqual(Object.keys(features),[LOFT_HOLES_CAPABILITY]);assert.equal(JSON.stringify(features).includes('secret'),false);
  assert.deepEqual(loftHoleLimits(capabilitySnapshot(instance,true,features)),{maxSections:32,maxHolesPerSection:16});
  for(const patch of [{ok:false},{protocolVersion:2},{service:'other'},{capabilities:{version:2}}, {capabilities:{...health.capabilities,faceBoundaryLoops:{version:2}}},{capabilities:{...health.capabilities,loftThroughHoles:{version:1,maxSections:100,maxHolesPerSection:16}}}])assert.deepEqual(nativeGeometryFeatures({...health,...patch}),{});
});

test('legacy naming upgrade requires its exact actual native proof policy, not just STEP naming support',()=>{
  const declaration={version:1,basis:'immutable-step-brep-v1',sourceFingerprintAlgorithm:'sha256-chain-1m-v1',upgrade:{version:1,basis:'unchanged-dual-replay-v1',archivedRecovery:false,private:'not forwarded'}};
  const current={...health,capabilities:{...health.capabilities,importedTopologyNaming:declaration}},features=nativeGeometryFeatures(current),snapshot=capabilitySnapshot(instance,true,features);
  assert.deepEqual(features[IMPORTED_NAMING_CAPABILITY].upgrade,{version:1,basis:'unchanged-dual-replay-v1',archivedRecovery:false});
  assert.doesNotThrow(()=>assertImportedNamingUpgrade(snapshot));
  for(const patch of [{version:2},{basis:'index'},{archivedRecovery:true}]){
    const other=nativeGeometryFeatures({...current,capabilities:{...current.capabilities,importedTopologyNaming:{...declaration,upgrade:{...declaration.upgrade,...patch}}}});
    assert.equal(other[IMPORTED_NAMING_CAPABILITY].upgrade,undefined);
    assert.throws(()=>assertImportedNamingUpgrade(capabilitySnapshot(instance,true,other)),error=>error.code==='WORKER_CAPABILITY_UNAVAILABLE');
  }
  assert.throws(()=>assertImportedNamingUpgrade(capabilitySnapshot(instance,false,features)),error=>error.code==='WORKER_CAPABILITY_UNAVAILABLE');
});
test('readiness, exact worker generation and supported capability are independent preconditions',()=>{
  const snapshot=capabilitySnapshot(instance,true,nativeGeometryFeatures(health)),required={version:1,workerInstance:instance,capability:LOFT_HOLES_CAPABILITY};assert.doesNotThrow(()=>assertCapabilityPrecondition(required,snapshot));
  for(const current of [capabilitySnapshot(instance,false,snapshot.features),{...snapshot,workerInstance:'22222222-2222-4222-8222-222222222222'}])assert.throws(()=>assertCapabilityPrecondition(required,current),error=>error.code==='WORKER_INSTANCE_CHANGED');
  assert.throws(()=>assertCapabilityPrecondition(required,{...snapshot,features:{}}),error=>error.code==='WORKER_CAPABILITY_UNAVAILABLE');
  for(const value of [null,{}, {...required,capability:'unknown'}, {...required,version:2},{...required,workerInstance:1},{...required,forged:true}])assert.throws(()=>assertCapabilityPrecondition(value,snapshot),error=>error.code==='WORKER_CAPABILITY_PRECONDITION_INVALID');
});
test('archived naming upgrade exposes only its exact proof policy and bounded native limits',()=>{
  const upgrade={version:1,basis:'unchanged-dual-replay-v1',archivedRecovery:'exact-recertification-v1',maxArchivedSources:64,maxArchivedProofs:256},imported={version:1,basis:'immutable-step-brep-v1',sourceFingerprintAlgorithm:'sha256-chain-1m-v1',upgrade};
  const featuresFor=patch=>nativeGeometryFeatures({...health,capabilities:{...health.capabilities,importedTopologyNaming:{...imported,upgrade:{...upgrade,...patch}}}});
  assert.deepEqual(featuresFor({secret:'not forwarded'})[IMPORTED_NAMING_CAPABILITY].upgrade,upgrade);
  assert.doesNotThrow(()=>assertImportedNamingUpgrade(capabilitySnapshot(instance,true,featuresFor({}))));
  for(const patch of [{archivedRecovery:true},{archivedRecovery:'guess-v1'},{maxArchivedSources:65},{maxArchivedSources:0},{maxArchivedProofs:257},{maxArchivedProofs:1.5},{maxArchivedProofs:undefined}]){
    const features=featuresFor(patch);assert.equal(features[IMPORTED_NAMING_CAPABILITY].upgrade,undefined);
    assert.throws(()=>assertImportedNamingUpgrade(capabilitySnapshot(instance,true,features)),error=>error.code==='WORKER_CAPABILITY_UNAVAILABLE');
  }
  assert.throws(()=>assertImportedNamingUpgrade(capabilitySnapshot(instance,true,{[IMPORTED_NAMING_CAPABILITY]:{upgrade}})),error=>error.code==='WORKER_CAPABILITY_UNAVAILABLE');
});
test('capability preconditions never change the semantic idempotency fingerprint',()=>{
  const fields={documentId:'d',inputs:{sections:[{bodyId:'body-1',faceId:'face-1-1'}]},parameters:{ruled:true}};
  assert.equal(mutationFingerprint('detail.loft',fields),mutationFingerprint('detail.loft',{...fields,workerCapabilityPrecondition:{version:1,workerInstance:instance,capability:LOFT_HOLES_CAPABILITY}}));
});
