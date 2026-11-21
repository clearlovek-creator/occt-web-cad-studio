import type { PrimitiveKind } from "./ribbon-catalog";

const stroke = { stroke: "currentColor", strokeWidth: 1.45, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const topFill = "var(--cad-icon-top, #d9eaf7)";
const sideFill = "var(--cad-icon-side, #a9c9e1)";

/** Small isometric line icons for solid primitives; every silhouette shows volume, not a 2D symbol. */
export function PrimitiveToolIcon({ kind }: { kind: PrimitiveKind }) {
  let drawing;
  switch (kind) {
    case "box": drawing = <>
      <path d="M3.5 8 12 3.5 20.5 8 12 12.5Z" fill={topFill} {...stroke}/>
      <path d="M3.5 8v9L12 21v-8.5Z" fill={sideFill} {...stroke}/>
      <path d="M20.5 8v9L12 21" fill="var(--cad-icon-front, #c4dced)" {...stroke}/>
    </>; break;
    case "cylinder": drawing = <>
      <path d="M5 7.5v9c0 2 3.1 3.7 7 3.7s7-1.7 7-3.7v-9" fill={sideFill} {...stroke}/>
      <path d="M5 7.5c0 2 3.1 3.7 7 3.7s7-1.7 7-3.7-3.1-3.7-7-3.7-7 1.7-7 3.7Z" fill={topFill} {...stroke}/>
      <path d="M5 16.5c0 2 3.1 3.7 7 3.7s7-1.7 7-3.7" {...stroke}/>
    </>; break;
    case "cone": drawing = <>
      <path d="M12 3.5 4.5 17c0 2.1 3.4 3.8 7.5 3.8s7.5-1.7 7.5-3.8Z" fill={sideFill} {...stroke}/>
      <path d="M4.5 17c0-2.1 3.4-3.8 7.5-3.8s7.5 1.7 7.5 3.8-3.4 3.8-7.5 3.8S4.5 19.1 4.5 17Z" fill={topFill} {...stroke}/>
      <path d="M12 3.5v9.7" {...stroke}/>
    </>; break;
    case "sphere": drawing = <>
      <circle cx="12" cy="12" r="8.5" fill={topFill} {...stroke}/>
      <path d="M3.7 12h16.6M12 3.5c2.5 2.2 3.8 5 3.8 8.5s-1.3 6.3-3.8 8.5c-2.5-2.2-3.8-5-3.8-8.5S9.5 5.7 12 3.5Z" {...stroke}/>
    </>; break;
    case "torus": drawing = <>
      <path d="M3.2 12c0-4.2 3.9-7.5 8.8-7.5s8.8 3.3 8.8 7.5-3.9 7.5-8.8 7.5S3.2 16.2 3.2 12Z" fill={sideFill} {...stroke}/>
      <path d="M7.5 12c0-2.1 2-3.8 4.5-3.8s4.5 1.7 4.5 3.8-2 3.8-4.5 3.8-4.5-1.7-4.5-3.8Z" fill="var(--cad-icon-hole, #f4f8fb)" {...stroke}/>
      <path d="M4.1 9.1c1.6 1.7 4.5 2.8 7.9 2.8s6.3-1.1 7.9-2.8" {...stroke}/>
    </>; break;
    case "wedge": drawing = <>
      <path d="M3.5 8 12 4l8.5 4v9L12 21l-8.5-4Z" fill={sideFill} {...stroke}/>
      <path d="M3.5 8 12 4l8.5 4-8.5 4.5Z" fill={topFill} {...stroke}/>
      <path d="M3.5 8v9L12 21v-8.5M12 12.5l8.5-4.5" {...stroke}/>
      <path d="M3.5 17 20.5 8" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round"/>
    </>; break;
    case "prism": drawing = <>
      <path d="m5 7 7-3.5L19 7v10l-7 3.5L5 17Z" fill={sideFill} {...stroke}/>
      <path d="m5 7 7-3.5L19 7l-7 3.7Z" fill={topFill} {...stroke}/>
      <path d="M12 10.7v9.8M5 7v10M19 7v10" {...stroke}/>
      <path d="m5 7 7 3.7L19 7" {...stroke}/>
    </>; break;
    case "pyramid": drawing = <>
      <path d="m4 15 8-4 8 4-8 5Z" fill={topFill} {...stroke}/>
      <path d="M12 3.5 4 15l8 5Z" fill={sideFill} {...stroke}/>
      <path d="M12 3.5 20 15l-8 5" fill="var(--cad-icon-front, #c4dced)" {...stroke}/>
      <path d="m4 15 8-4 8 4" {...stroke}/>
    </>; break;
    case "tube": drawing = <>
      <path d="M4.5 7.5v9c0 2.2 3.4 4 7.5 4s7.5-1.8 7.5-4v-9" fill={sideFill} {...stroke}/>
      <path d="M4.5 7.5c0 2.2 3.4 4 7.5 4s7.5-1.8 7.5-4-3.4-4-7.5-4-7.5 1.8-7.5 4Z" fill={topFill} {...stroke}/>
      <path d="M8 7.5c0 1.1 1.8 2 4 2s4-.9 4-2-1.8-2-4-2-4 .9-4 2Z" fill="var(--cad-icon-hole, #f4f8fb)" {...stroke}/>
      <path d="M8 7.5v1.8m8-1.8v1.8M4.5 16.5c0 2.2 3.4 4 7.5 4s7.5-1.8 7.5-4" {...stroke}/>
    </>; break;
  }

  return <svg className="primitive-tool-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true" focusable="false">{drawing}</svg>;
}
