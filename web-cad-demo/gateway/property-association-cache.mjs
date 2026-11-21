import {resolvePropertySchema} from './property-associations.mjs';
export const PROPERTY_ASSOCIATION_CACHE_LIMITS=Object.freeze({entries:16,bytes:32*1024*1024,entryBytes:16*1024*1024,encodeNodes:1000000});
const fields=['target','targets','state','stateReason','association'];
const validAuthority=a=>a&&a.stable===true&&/^[A-Za-z0-9_-]{1,64}$/.test(a.documentId)&&/^[a-f0-9-]{36}$/.test(a.workerInstance)&&/^[a-f0-9]{64}$/.test(a.stateToken)&&['generation','stateSequence','propertyVersion'].every(k=>Number.isSafeInteger(a[k])&&a[k]>=0);
const key=a=>JSON.stringify([a.documentId,a.workerInstance,a.generation,a.stateToken,a.stateSequence,a.propertyVersion]);
const boundKey=(a,view)=>JSON.stringify([key(a),view.revision]);
/** Count normalized overlays before encoding; values and type definitions are
 * never cached. Encoded bytes are not a V8 heap/RSS guarantee. */
function encodedSize(value,maxBytes,maxNodes){
  let bytes=0,nodes=0;const add=n=>{bytes+=n;return bytes<=maxBytes;};
  function visit(v,depth){if(++nodes>maxNodes||depth>16)return false;if(v===null)return add(4);if(typeof v==='string')return v.length<=8192&&add(Buffer.byteLength(JSON.stringify(v)));if(typeof v==='boolean')return add(v?4:5);if(typeof v==='number')return Number.isFinite(v)&&add(Buffer.byteLength(JSON.stringify(v)));if(typeof v!=='object')return false;
    if(Array.isArray(v)){if(v.length>maxNodes-nodes||!add(2+Math.max(0,v.length-1)))return false;for(const item of v)if(!visit(item,depth+1))return false;return true;}
    if(Object.getPrototypeOf(v)!==Object.prototype)return false;const keys=Object.keys(v);if(keys.length>maxNodes-nodes||!add(2+Math.max(0,keys.length-1)))return false;for(const name of keys)if(name.length>128||!add(Buffer.byteLength(JSON.stringify(name))+1)||!visit(v[name],depth+1))return false;return true;
  }return visit(value,0)?bytes:null;
}
export class PropertyAssociationCache{
  #entries=new Map();#views=new WeakMap();#bytes=0;
  constructor({resolve=resolvePropertySchema,...limits}={}){for(const [k,v]of Object.entries(limits))if(!Object.hasOwn(PROPERTY_ASSOCIATION_CACHE_LIMITS,k)||!Number.isSafeInteger(v)||v<1||v>PROPERTY_ASSOCIATION_CACHE_LIMITS[k])throw Error('Invalid property association cache limits.');if(typeof resolve!=='function')throw Error('Invalid association resolver.');this.resolve=resolve;this.limits={...PROPERTY_ASSOCIATION_CACHE_LIMITS,...limits};this.hits=0;this.misses=0;this.bypasses=0;this.evictions=0;}
  clear(){this.#entries.clear();this.#bytes=0;this.#views=new WeakMap();}
  observe(view,authority){if(view?.ok!==false&&Number.isSafeInteger(view?.revision)&&view.revision>=0&&validAuthority(authority)&&(view.documentId===undefined||view.documentId===authority.documentId))this.#views.set(view,{key:boundKey(authority,view),documentId:authority.documentId,revision:view.revision});}
  #drop(id){const e=this.#entries.get(id);if(e){this.#bytes-=e.bytes;this.#entries.delete(id);}}
  read(documentId,view,{authority,loadSchema}){
    const proof=this.#views.get(view),current=authority(),eligible=proof&&view?.ok!==false&&proof.documentId===documentId&&proof.revision===view?.revision&&validAuthority(current)&&current.documentId===documentId&&proof.key===boundKey(current,view),schema=loadSchema();
    const decorate=(result,hit,status)=>Object.defineProperty({...result},'associationCache',{value:{version:1,hit,status,verificationReused:hit,scope:'same-observed-native-state-and-property-version',valuesCached:false},enumerable:false});
    if(!eligible){this.bypasses++;return decorate(this.resolve(schema,view),false,'bypass');}
    const existing=this.#entries.get(documentId);
    if(existing&&existing.key===proof.key){const saved=JSON.parse(existing.text),after=authority();
      if(saved.patches.length===schema.instances.length&&saved.patches.every((p,i)=>p.instanceId===schema.instances[i].instanceId)&&validAuthority(after)&&boundKey(after,view)===proof.key){this.#entries.delete(documentId);this.#entries.set(documentId,existing);this.hits++;return decorate({...schema,instances:schema.instances.map((instance,i)=>({...instance,...saved.patches[i].overlay})),associationResolution:saved.verification},true,'hit');}
    }
    this.#drop(documentId);this.misses++;const result=this.resolve(schema,view),after=authority();
    if(!validAuthority(after)||boundKey(after,view)!==proof.key)return decorate(result,false,'state-changed');
    if(result.associationResolution?.status!=='complete'||result.instances.some(i=>i.state!=='active'))return decorate(result,false,'unverified');
    let text,bytes;try{const payload={patches:result.instances.map(instance=>({instanceId:instance.instanceId,overlay:Object.fromEntries(fields.filter(f=>Object.hasOwn(instance,f)&&instance[f]!==undefined).map(f=>[f,instance[f]]))})),verification:result.associationResolution};bytes=encodedSize(payload,Math.min(this.limits.entryBytes,this.limits.bytes),this.limits.encodeNodes);if(bytes===null)return decorate(result,false,'oversized');text=JSON.stringify(payload);if(Buffer.byteLength(text)!==bytes)return decorate(result,false,'encoding-changed');}catch{return decorate(result,false,'encoding-failed');}
    while(this.#entries.size>=this.limits.entries||this.#bytes+bytes>this.limits.bytes){this.#drop(this.#entries.keys().next().value);this.evictions++;}
    this.#entries.set(documentId,{key:proof.key,text,bytes});this.#bytes+=bytes;return decorate(result,false,'stored');
  }
  status(){return {entries:this.#entries.size,bytes:this.#bytes,limits:{...this.limits},hits:this.hits,misses:this.misses,bypasses:this.bypasses,evictions:this.evictions};}
}
