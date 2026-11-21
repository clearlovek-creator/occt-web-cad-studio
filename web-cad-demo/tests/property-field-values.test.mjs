import test from "node:test";
import assert from "node:assert/strict";
import { parsePropertyValue, normalizePropertyFields } from "../app/model/property-field-values.ts";
const field=(type,extra={})=>({key:"value",label:"参数",type,...extra});
test("all six field types normalize editor defaults and exact integer values without rounding",()=>{
  assert.equal(parsePropertyValue(field("bool"),false),false);
  assert.equal(parsePropertyValue(field("int"),"42"),42);
  assert.equal(parsePropertyValue(field("int"),"9223372036854775807"),"9223372036854775807");
  assert.equal(parsePropertyValue(field("double"),"1.25e3"),1250);
  assert.equal(parsePropertyValue(field("expression"),"width / 2"),"width / 2");
  assert.equal(parsePropertyValue(field("enum",{options:["A","B"]}),"B"),"B");
  assert.deepEqual(parsePropertyValue(field("vector3"),"1, 2, -3"),[1,2,-3]);
  assert.equal(parsePropertyValue(field("double"),""),undefined);
  const fields=[field("vector3",{default:"0, 0, 1"}),{...field("double",{default:"3"}),key:"legacy"}];
  assert.deepEqual(normalizePropertyFields(fields,["legacy"]).map(f=>f.default),[[0,0,1],"3"]);
  assert.equal(fields[0].default,"0, 0, 1");
});
test("invalid defaults, blank vector components and already rounded integer numbers are rejected",()=>{
  for(const [type,value,extra] of [["int","1.2"],["int",9007199254740992],["double","Infinity"],["double",true],["bool","false"],["vector3","0,,1"],["vector3",[0,null,1]],["enum","C",{options:["A"]}],["expression",42]])assert.throws(()=>parsePropertyValue(field(type,extra),value));
  assert.throws(()=>parsePropertyValue(field("double",{required:true})," "),/不能为空/);
  assert.throws(()=>normalizePropertyFields([field("double",{default:""})]),/不能为空/);
});
