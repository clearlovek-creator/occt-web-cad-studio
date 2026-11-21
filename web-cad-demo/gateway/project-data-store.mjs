import {emptyMeshStrategies} from '../shared/mesh-strategy.mjs';
/** One certified engineering-data checkpoint, with independent domain stores.
 * Legacy property-only snapshots are read without rewriting their bytes. */
export class ProjectDataStore {
  constructor({propertySchemaStore,meshStrategyStore}){Object.assign(this,{propertySchemaStore,meshStrategyStore});}
  validateSnapshot(value){
    if(value?.projectDataVersion!==undefined){if(value.projectDataVersion!==1||Object.keys(value).some(key=>!['projectDataVersion','propertySchema','meshStrategies'].includes(key)))throw Error('工程数据封装版本或字段不支持。');return {projectDataVersion:1,propertySchema:this.propertySchemaStore.validateSnapshot(value.propertySchema),meshStrategies:this.meshStrategyStore.validateSnapshot(value.meshStrategies)};}
    return {projectDataVersion:1,propertySchema:this.propertySchemaStore.validateSnapshot(value),meshStrategies:emptyMeshStrategies()};
  }
  list(id){return {projectDataVersion:1,propertySchema:this.propertySchemaStore.list(id),meshStrategies:this.meshStrategyStore.list(id)};}
  replaceSnapshot(id,value,options={}){const next=this.validateSnapshot(value);this.propertySchemaStore.replaceSnapshot(id,next.propertySchema,options);this.meshStrategyStore.replaceSnapshot(id,next.meshStrategies);return this.list(id);}
  reset(id){this.propertySchemaStore.reset(id);this.meshStrategyStore.reset(id);return this.list(id);}
  filePaths(id){return [this.propertySchemaStore.filePath(id),this.meshStrategyStore.filePath(id)];}
}
