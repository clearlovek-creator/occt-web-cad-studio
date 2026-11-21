/* Test-only counting wrapper; no production route, flag or data mutation. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../../gateway/backend-release.mjs';
const workspace=path.resolve(import.meta.dirname,'../..'),release=selectBackendRelease(path.resolve(process.env.CAD_TEST_BACKEND_RELEASE_ROOT),process.env.CAD_TEST_BACKEND_RELEASE_ID),entry=path.join(release.directory,'runtime/scripts/backend-server.mjs'),storeFile=path.join(release.directory,'runtime/gateway/property-schema-store.mjs'),{PropertySchemaStore}=await import(pathToFileURL(storeFile).href),list=PropertySchemaStore.prototype.list;
PropertySchemaStore.prototype.list=function(...args){const stack=String(new Error().stack).split('\n'),direct=stack.some(line=>line.includes('executePropertySchemaOperation'))&&!stack.some(line=>line.includes('ProjectDataStore.list'));const result=list.apply(this,args);if(direct)console.log(JSON.stringify({type:'fixture.property-operation-list-read'}));return result;};
process.argv=[process.execPath,entry,'--release',release.directory,'--workspace',workspace];await import(pathToFileURL(entry).href);
