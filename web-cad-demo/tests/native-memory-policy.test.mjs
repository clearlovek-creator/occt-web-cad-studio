import test from 'node:test';
import assert from 'node:assert/strict';
import {geometryMemoryPolicy,assertNativeMemoryGuard,nativeResourceExitError} from '../gateway/native-resource-policy.mjs';
test('geometry memory policy is strict, bounded and cannot be disabled or silently downgraded by platform',()=>{
  assert.equal(geometryMemoryPolicy({},'win32').limitBytes,2*1024**3);
  for(const value of ['0','-1','128','1.5',' 134217728','1e9','9999999999999999999999','8589934593',''])assert.throws(()=>geometryMemoryPolicy({GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:value},'win32'),error=>error.code==='WORKER_RESOURCE_CONFIG_INVALID'&&error.permanent);
  assert.equal(geometryMemoryPolicy({GEOMETRY_WORKER_MEMORY_LIMIT_BYTES:'134217728'},'win32').limitBytes,128*1024*1024);
  assert.throws(()=>geometryMemoryPolicy({},'linux'),error=>error.code==='WORKER_RESOURCE_PLATFORM_UNSUPPORTED');
});
test('only the running native handshake can prove exactly the requested commit limits and failure policy',()=>{
  const policy=geometryMemoryPolicy({},'win32'),resource={version:1,basis:'windows-job-commit-v1',processLimitBytes:policy.limitBytes,jobLimitBytes:policy.limitBytes,enforced:true,failurePolicy:'retire-on-memory-event-or-allocator-failure-v1'},health={ok:true,protocolVersion:1,service:'occt-geometry-worker',capabilities:{version:1,processResources:resource}};
  assert.deepEqual(assertNativeMemoryGuard(health,policy),resource);
  for(const patch of [{version:2},{basis:'rss-sampling'},{enforced:false},{processLimitBytes:1024},{jobLimitBytes:1024},{failurePolicy:'best-effort'}])assert.throws(()=>assertNativeMemoryGuard({...health,capabilities:{...health.capabilities,processResources:{...resource,...patch}}},policy),error=>error.code==='WORKER_RESOURCE_GUARD_UNAVAILABLE'&&error.permanent);
  assert.throws(()=>assertNativeMemoryGuard({...health,capabilities:{version:1}},policy));
});
test('authoritative resource exits distinguish a hard-limit event from allocator failure and permanently blocked setup',()=>{
  const policy=geometryMemoryPolicy({},'win32');assert.equal(nativeResourceExitError(86,policy).code,'WORKER_MEMORY_LIMIT');assert.equal(nativeResourceExitError(87,policy).code,'WORKER_MEMORY_EXHAUSTED');for(const code of [88,89])assert.equal(nativeResourceExitError(code,policy).permanent,true);assert.equal(nativeResourceExitError(1,policy).code,'WORKER_UNAVAILABLE');
});
