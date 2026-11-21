import type {MeshWireChunk} from './mesh';
import {localizeCoordinateValues} from './viewport-coordinates';

export const MESH_WIRE_TIMEOUT_MESSAGE='网格显示数据块读取超时，已停止显示；不会自动重复请求。';
export function isMeshWireTimeout(reason:unknown):reason is Error {return reason instanceof Error&&(reason as Error&{code?:string}).code==='MESH_WIRE_TIMEOUT';}
function assertActive(signal:AbortSignal,deadlineAt:number) {
    if(signal.aborted)throw new DOMException('网格显示读取已取消。','AbortError');
    if(performance.now()>=deadlineAt)throw Object.assign(Error(MESH_WIRE_TIMEOUT_MESSAGE),{code:'MESH_WIRE_TIMEOUT'});
}

/** Cleanup cannot extend the observation deadline, even for a broken stream. */
function discard(body:{cancel:()=>Promise<unknown>}|null|undefined) {
    try {if(body)void Promise.resolve(body.cancel()).catch(()=>{});}
    catch { /* Synchronous cleanup errors must not replace the actual failure. */ }
}

/** Retire our observer promptly. An uncooperative transport may still finish;
 * its late response is discarded and can never resume the parsing pipeline. */
function observe<T>(work:PromiseLike<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T> {
    return new Promise((resolve,reject)=>{
        let finished=false;
        const abort=()=>{
            if(finished)return;
            finished=true;signal.removeEventListener('abort',abort);
            reject(new DOMException('网格显示读取已取消。','AbortError'));
        };
        signal.addEventListener('abort',abort,{once:true});
        void Promise.resolve(work).then(value=>{
            if(finished){try{late?.(value);}catch{/* Best-effort disposal only. */}return;}
            finished=true;signal.removeEventListener('abort',abort);resolve(value);
        },reason=>{
            if(finished)return;
            finished=true;signal.removeEventListener('abort',abort);reject(reason);
        });
        if(signal.aborted)abort();
    });
}

/** Yield to timer/input/render tasks, not just to another promise microtask.
 * The batch limit amortizes browsers' nested-timer minimum-delay clamp. */
async function yieldReadTask(signal:AbortSignal,deadlineAt:number) {
    assertActive(signal,deadlineAt);let timer:ReturnType<typeof setTimeout>|undefined;
    try{await observe(new Promise<void>(resolve=>{timer=setTimeout(resolve,0);}),signal);}
    finally{if(timer!==undefined)clearTimeout(timer);}
    assertActive(signal,deadlineAt);
}

async function readBytes(response:Response,limit:number,signal:AbortSignal,deadlineAt:number,exact=false) {
    const reader=response.body?.getReader();
    if(!reader)throw Error('网格显示回复缺少二进制内容。');
    const bytes=new Uint8Array(limit);let size=0,consumed=false,empty=0,batch=0,lastYield=performance.now();
    try {
        for(;;){
            assertActive(signal,deadlineAt);
            const part=await observe(reader.read(),signal);
            assertActive(signal,deadlineAt);
            if(part.done){consumed=true;break;}
            if(!part.value.byteLength&&++empty>4096)throw Object.assign(Error('网格显示字节流包含过多空片段，已停止读取。'),{code:'MESH_WIRE_STREAM_LIMIT'});
            if(size+part.value.byteLength>bytes.length)throw Error('网格显示回复超过数据块预算。');
            bytes.set(part.value,size);size+=part.value.byteLength;
            if(++batch>=8192||(batch>=16&&performance.now()-lastYield>=8)){await yieldReadTask(signal,deadlineAt);batch=0;lastYield=performance.now();}
        }
        if(exact&&size!==bytes.length)throw Error('网格显示数据不完整。');
        return bytes.subarray(0,size);
    } finally {
        if(!consumed)discard(reader);
        // releaseLock may reject if a nonstandard reader retains its pending
        // read. That does not restore ownership or keep the caller waiting.
        try {reader.releaseLock();}catch{/* No asynchronous cleanup barrier. */}
    }
}

export async function readMeshWireChunk({apiRoot,jobId,wireKey,index,chunk,signal,fetcher,deadlineAt=performance.now()+15000}:{
    apiRoot:string;jobId:string;wireKey:string;index:number;chunk:MeshWireChunk;
    signal:AbortSignal;fetcher:typeof fetch;deadlineAt?:number;
}) {
    if(!Number.isFinite(deadlineAt))throw Error('网格显示读取期限无效。');
    assertActive(signal,deadlineAt);
    const response=await observe(fetcher(`${apiRoot}/mesh/jobs/${encodeURIComponent(jobId)}/render?wireKey=${encodeURIComponent(wireKey)}&chunk=${index}`,{signal}),signal,value=>discard(value.body));
    try{assertActive(signal,deadlineAt);}catch(reason){discard(response.body);throw reason;}
    if(!response.ok){
        let message=`网格显示读取失败（HTTP ${response.status}）。`;
        try {
            const bytes=await readBytes(response,8192,signal,deadlineAt);
            const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
            if(typeof payload.error==='string')message=payload.error.slice(0,512);
        }catch{/* Keep the bounded HTTP diagnostic, not an arbitrary stream error. */}
        assertActive(signal,deadlineAt);throw Error(message);
    }
    if(response.headers.get('X-CAD-Mesh-Format')!=='float64-le'||response.headers.get('X-CAD-Mesh-Wire')!==wireKey||response.headers.get('X-CAD-Mesh-Chunk')!==String(index)){
        discard(response.body);throw Error('网格显示回复与请求分组不一致。');
    }
    const length=response.headers.get('Content-Length');
    if(length!==null&&Number(length)!==chunk.bytes){discard(response.body);throw Error('网格显示数据长度不匹配。');}
    const bytes=await readBytes(response,chunk.bytes,signal,deadlineAt,true);
    assertActive(signal,deadlineAt);
    const digest=await observe(crypto.subtle.digest('SHA-256',bytes),signal);
    assertActive(signal,deadlineAt);
    const actual=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    if(actual!==chunk.sha256)throw Error('网格显示数据内容校验失败。');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const local=localizeCoordinateValues(bytes.byteLength/8,n=>view.getFloat64(n*8,true));
    assertActive(signal,deadlineAt);return local;
}
