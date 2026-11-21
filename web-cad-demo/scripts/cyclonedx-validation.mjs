import path from 'node:path';
import {createRequire} from 'node:module';
import {domainToASCII} from 'node:url';
import {readSmallJson,hashFile} from '../gateway/frontend-release.mjs';
export function removeEnumDescriptions(schema){
  let removed=0;
  function visit(node){if(!node||typeof node!=='object')return;
    if(Object.hasOwn(node,'meta:enum')){const metadata=node['meta:enum'];if(!Array.isArray(node.enum)||!metadata||typeof metadata!=='object'||Array.isArray(metadata)||Object.entries(metadata).some(([key,value])=>!node.enum.includes(key)||typeof value!=='string'))throw Error('Unsupported enum annotation shape; schema was not relaxed.');delete node['meta:enum'];removed++;}
    for(const value of Object.values(node))visit(value);
  }visit(schema);return removed;
}
export function createCycloneValidator(schemas){
  const require=createRequire(import.meta.url),Ajv=require('ajv'),ajv=new Ajv({allErrors:true,strictKeywords:true,format:'full'});
  ajv.addKeyword('deprecated',{metaSchema:{type:'boolean'},valid:true});
  // This generator emits ASCII references and no internationalized mailbox local
  // parts. Validate that conservative subset rather than ignore unknown formats.
  const formats=require('ajv/lib/compile/formats')('full');
  for(const [name,base]of[['iri','uri'],['iri-reference','uri-reference']])ajv.addFormat(name,value=>/^[\x21-\x7e]*$/.test(value)&&(formats[base] instanceof RegExp?formats[base].test(value):formats[base](value)));
  ajv.addFormat('idn-email',value=>{const at=value.lastIndexOf('@');if(at<1||/[^\x21-\x7e]/.test(value.slice(0,at)))return false;const domain=domainToASCII(value.slice(at+1));return Boolean(domain)&&formats.email.test(value.slice(0,at+1)+domain);});
  let removed=0;for(const original of schemas){const schema=structuredClone(original);removed+=removeEnumDescriptions(schema);ajv.addSchema(schema,schema.$id);}
  const validate=ajv.getSchema('http://cyclonedx.org/schema/bom-1.6.schema.json');if(!validate)throw Error('BOM schema is missing.');
  return {validate,ajvVersion:require('ajv/package.json').version,formatProfile:'Conservative generated-report subset: ASCII IRI references; ASCII mailbox local parts with IDNA domains. Other formats use Ajv full validation; unknown formats fail.',annotationAdaptation:{keyword:'meta:enum',removed,reason:'Ajv 6 cannot register colon-named annotation keywords; descriptions removed, all enum and other validation constraints retained.'}};
}
export const schemaHashes=Object.freeze({'bom-1.6.schema.json':'1ebcb88a2c845ecb6ff7bee7aeabdff9422cb0347f3d6875b241bd444b7e098f','spdx.schema.json':'33863a360fc4d348e183d89c1ca7aa0877f481e7eb55be2d4102a30386188a10','jsf-0.82.schema.json':'2faf5eb3651f2ae5f46091a131770d8d847bbd121139d19c85fc7051bfa58c46'});
export function validateCycloneDx(bom,directory){
  const input=readSmallJson(path.join(directory,'schema-input.json')),names=Object.keys(schemaHashes);
  if(input.format!=='web-cad-cyclonedx-schema-input'||input.version!==1||!Array.isArray(input.files)||input.files.length!==3||new Set(input.files.map(file=>file.file)).size!==3)throw Error('Invalid schema acquisition evidence.');
  const schemas=input.files.map(item=>{if(!names.includes(item.file)||item.url!=='https://cyclonedx.org/schema/'+item.file)throw Error('Unexpected schema input.');const file=path.join(directory,item.file);if(item.sha256!==schemaHashes[item.file]||hashFile(file)!==item.sha256)throw Error('Schema source changed or does not match the pinned reviewed version.');return readSmallJson(file);});
  const {validate,...evidence}=createCycloneValidator(schemas);if(!validate(bom))throw Error('CycloneDX schema validation failed: '+JSON.stringify(validate.errors));
  return {version:'1.6',schemaValidated:true,schemaFiles:input.files,...evidence};
}
