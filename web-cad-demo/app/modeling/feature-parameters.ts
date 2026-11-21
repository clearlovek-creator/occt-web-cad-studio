/** Hide stored coordinate/matrix implementation fields, not real dimensions
 * such as a Torus's majorRadius and minorRadius. */
export function editableNumberEntries(feature:{type?:string;numberParameters:Record<string,number>}) {
  return Object.entries(feature.numberParameters).filter(([key])=>!key.startsWith("cs") && !/^m\d\d$/.test(key)
    && !(key==="count" && (feature.type==="pattern.rectangular" || feature.type==="pattern.mirror")));
}
