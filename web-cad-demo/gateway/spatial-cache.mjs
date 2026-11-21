/** Cache by persistent geometry identity, not revision (Undo branches reuse R).
 * Missing identities allow deduplication inside one view only, never reuse across views. */
export function compactSpatialMeasurement(result){
  const fields=['ok','error','code','bodyId','selectionType','selectionId','volume','area','length','edgeLengthPolicy','perimeter','centroid','bounds','curveType','endpoints','radius','center','obb','spatialPolicy'];
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]]));
}
export class SpatialMeasurementCache {
  constructor({maxDocuments=32,maxMeasurements=256}={}){this.maxDocuments=maxDocuments;this.maxMeasurements=maxMeasurements;this.documents=new Map();this.viewKeys=new WeakMap();}
  key(view){
    if(this.viewKeys.has(view))return this.viewKeys.get(view);
    const bodies=view.bodyMetadata||[],identities=bodies.map(body=>{const identity=view.entityIdentities?.[body.bodyId]||body;return [body.bodyId,identity.bodyIdentity||body.bodyIdentity,identity.topologyIdentity||body.topologyIdentity,body.topologyRevision];});
    const valid=identities.every(row=>/^[a-f0-9]{32}$/.test(row[1])&&/^[a-f0-9]{32}$/.test(row[2])&&Number.isSafeInteger(row[3]));
    const key=valid?JSON.stringify([view.revision,view.spatialPolicy||null,identities.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)]):Symbol('unverified-view');this.viewKeys.set(view,key);return key;
  }
  async read(document,view,selection,load){
    const key=this.key(view);let entry=this.documents.get(document);
    if(!entry||entry.key!==key){entry={key,measurements:new Map(),pending:new Map()};this.documents.delete(document);this.documents.set(document,entry);while(this.documents.size>this.maxDocuments)this.documents.delete(this.documents.keys().next().value);}
    else{this.documents.delete(document);this.documents.set(document,entry);}
    if(entry.measurements.has(selection)){const measurement=entry.measurements.get(selection);entry.measurements.delete(selection);entry.measurements.set(selection,measurement);return {measurement,cached:true};}
    if(entry.pending.has(selection))return entry.pending.get(selection);
    const pending=Promise.resolve().then(load).then(measurement=>{
      if(!measurement?.ok)return {measurement:null,error:String(measurement?.error||'Measurement failed.')};
      entry.measurements.set(selection,measurement);while(entry.measurements.size>this.maxMeasurements)entry.measurements.delete(entry.measurements.keys().next().value);
      return {measurement,cached:false};
    }).catch(error=>({measurement:null,error:error instanceof Error?error.message:String(error)})).finally(()=>entry.pending.delete(selection));
    entry.pending.set(selection,pending);return pending;
  }
}
