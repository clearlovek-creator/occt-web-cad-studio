/** Per-resolution deterministic admission. Estimated retained state is not a
 * V8 heap/RSS measurement, and input decoding/output serialization are external. */
export const PROPERTY_ASSOCIATION_LIMITS=Object.freeze({bodyRecords:50000,featureRecords:20000,lineageRecords:100000,workUnits:500000,stateBytes:32*1024*1024,candidateSlots:262144,cacheEntries:4096});
export const PROPERTY_ASSOCIATION_LIMIT_REASON='本次属性关联解析超出共享预算，未完成的关联已保留且需复核；未将其视为已删除或已完整继承。';
export class PropertyAssociationBudget{
  constructor(overrides={}){
    if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw Error('Invalid property association limits.');
    for(const [key,value]of Object.entries(overrides))if(!Object.hasOwn(PROPERTY_ASSOCIATION_LIMITS,key)||!Number.isSafeInteger(value)||value<1||value>PROPERTY_ASSOCIATION_LIMITS[key])throw Error('Property association limits must be known positive integers at or below hard defaults.');
    this.limits={...PROPERTY_ASSOCIATION_LIMITS,...overrides};this.usage=Object.fromEntries(Object.keys(this.limits).filter(key=>key!=='cacheEntries').map(key=>[key,0]));this.limitedBy=new Set();this.cacheHits=0;this.cachePeak=0;this.indexBuilt=false;
  }
  take(key,amount=1,{optional=false}={}){
    if(!Object.hasOwn(this.usage,key)||!Number.isSafeInteger(amount)||amount<0)throw Error('Invalid property association budget charge.');
    if(amount>this.limits[key]-this.usage[key]){if(!optional)this.limitedBy.add(key);return false;}this.usage[key]+=amount;return true;
  }
  work(){return this.take('workUnits');}
  report(){return {version:1,status:this.limitedBy.size?'budget-limited':'complete',indexBuilt:this.indexBuilt,limits:{...this.limits},usage:{...this.usage},limitedBy:[...this.limitedBy].sort(),cacheHits:this.cacheHits,cachePeak:this.cachePeak};}
}
