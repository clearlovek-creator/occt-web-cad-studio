import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observeGatewayStop} from './helpers/observe-gateway-stop.mjs';
const reset=()=>Promise.reject(Object.assign(Error('fetch failed'),{cause:{code:'ECONNRESET'}}));
test('lost shutdown reply remains pending until the exact child actually closes',async()=>{const child=new EventEmitter();let settled=false;const pending=observeGatewayStop(child,reset).then(value=>{settled=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);child.emit('close',0);const proof=await pending;assert.deepEqual(proof,{requestAccepted:false,requestErrorCode:'ECONNRESET',exitCode:0,processClosed:true});assert.equal(child.listenerCount('close'),0);});
test('an accepted shutdown without observed close is not success',async()=>{const child=new EventEmitter();await assert.rejects(observeGatewayStop(child,async()=>({ok:true,status:202}),{timeoutMs:20}),/unconfirmed/);assert.equal(child.listenerCount('close'),0);});
test('a connection reset without actual child close is still unconfirmed',async()=>{const child=new EventEmitter();await assert.rejects(observeGatewayStop(child,reset,{timeoutMs:20}),/unconfirmed/);assert.equal(child.listenerCount('close'),0);});
test('nonzero exit is preserved for the caller instead of being promoted to a clean stop',async()=>{const child=new EventEmitter(),pending=observeGatewayStop(child,async()=>({ok:true,status:202}));child.emit('close',88);assert.equal((await pending).exitCode,88);});
