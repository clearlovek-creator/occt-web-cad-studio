import {selectionBindingPaths} from '../../gateway/selection-precondition.mjs';

/** Migration fixture: carry ONLY a token previously returned to this client.
 * Never query/retry automatically or replace an explicitly supplied token.
 * Tests of missing/stale preconditions intentionally use raw fetch instead. */
export class ObservedCommandClient {
  constructor(){this.observations=new Map();}
  key(documentId='default',scope=''){return `${scope}\n${documentId || 'default'}`;}
  observe(payload,documentId=payload?.documentId || 'default',scope=''){
    if(!payload?.ok || typeof payload.stateToken!=='string')return payload;
    const key=this.key(documentId,scope),previous=this.observations.get(key),sequence=Number.isSafeInteger(payload.stateSequence)?payload.stateSequence:0;
    if(!previous || sequence>=previous.sequence)this.observations.set(key,{token:payload.stateToken,sequence});
    return payload;
  }
  prepare(body,scope='',route='/commands'){
    if(!body || typeof body!=='object' || Array.isArray(body))return body;
    if(body.baseStateToken!==undefined)return body;
    const requires=Array.isArray(body.steps)?body.steps.some(step=>step && typeof step.operation==='string' && selectionBindingPaths(step.operation,step).length)
      :route==='/fillet'?Boolean(body.edgeId):selectionBindingPaths(typeof body.operation==='string'?body.operation:'',body).length>0;
    const observed=this.observations.get(this.key(body.documentId,scope));
    return requires && observed?{...body,baseStateToken:observed.token}:body;
  }
}
