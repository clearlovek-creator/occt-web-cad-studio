import type { PropertyField } from "./property-schema";

/** Convert editor text once, without rounding exact integers or blank vectors. */
export function parsePropertyValue(field: PropertyField, raw: unknown): unknown {
  const empty=raw===undefined || raw==="" || (typeof raw==="string" && !raw.trim());
  if(empty){if(field.required)throw new Error(`${field.label || field.key} 不能为空。`);return undefined;}
  const fail=(message:string):never=>{throw new Error(`${field.label || field.key} ${message}`);};
  if(field.type==="bool")return typeof raw==="boolean"?raw:fail("必须是布尔值。");
  if(field.type==="int"){
    if(typeof raw==="number")return Number.isSafeInteger(raw)?raw:fail("不能使用已丢失精度的整数，请输入完整整数文本。");
    if(typeof raw!=="string" || !/^[-+]?\d+$/.test(raw.trim()))return fail("必须是整数。");
    const exact=BigInt(raw.trim()).toString(),number=Number(exact);
    return Number.isSafeInteger(number)?number:exact;
  }
  if(field.type==="double")return (typeof raw==="number" || typeof raw==="string") && Number.isFinite(Number(raw))?Number(raw):fail("必须是有限数值。");
  if(field.type==="vector3"){
    const parts=Array.isArray(raw)?raw:typeof raw==="string"?raw.split(","):[];
    if(parts.length!==3 || parts.some(entry=>(typeof entry!=="number" && typeof entry!=="string") || String(entry).trim()==="" || !Number.isFinite(Number(entry))))return fail("必须包含三个非空数值，例如 0, 0, 1。");
    return parts.map(Number);
  }
  if(field.type==="enum")return typeof raw==="string" && field.options?.includes(raw)?raw:fail("必须使用已定义的枚举选项。");
  return typeof raw==="string"?raw:fail("必须是表达式文本。");
}

export function normalizePropertyFields(fields: PropertyField[], preserveKeys: string[] = []): PropertyField[] {
  return fields.map(field=>{
    const result={...field};
    if(field.default!==undefined && !preserveKeys.includes(field.key))result.default=parsePropertyValue({...field,required:true},field.default);
    return result;
  });
}
