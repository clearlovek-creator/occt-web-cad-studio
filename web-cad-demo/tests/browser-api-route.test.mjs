import test from 'node:test';
import assert from 'node:assert/strict';
import {geometryApiUrl,routeGeometryApi} from '../scripts/browser-api-route.cjs';
test('browser isolation maps development and production paths into the exact test gateway',async()=>{
  let predicate,handler;await routeGeometryApi({route:(a,b)=>{predicate=a;handler=b;}},'http://127.0.0.1:8859/api','http://localhost:3990/');
  for(const url of ['http://127.0.0.1:8788/api/commands','http://localhost:3990/api/documents/default/imports/step'])assert.equal(predicate(new URL(url)),true);
  for(const url of ['http://localhost:3000/api/commands','https://example.com/api/commands','http://localhost:3990/assets/app.js','http://localhost:3990/api-other'])assert.equal(predicate(new URL(url)),false);
  let next;handler({request:()=>({url:()=> 'http://localhost:3990/api/events?request=once'}),continue:value=>{next=value.url;}});assert.equal(next,'http://127.0.0.1:8859/api/events?request=once');
  assert.equal(geometryApiUrl('http://127.0.0.1:8788/api/commands','http://127.0.0.1:8859/api'),'http://127.0.0.1:8859/api/commands');assert.throws(()=>geometryApiUrl('http://localhost/assets/x','http://127.0.0.1/api'));
});
