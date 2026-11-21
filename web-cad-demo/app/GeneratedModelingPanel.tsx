"use client";

import type { DirectModelResult } from "./DirectModelingPanel";
import {LoftModelingPanel,type LoftBodySummary} from "./LoftModelingPanel";
import {SweepModelingPanel} from "./SweepModelingPanel";

export function GeneratedModelingPanel(props:{kind:"sweep"|"pipe"|"loft";model:{revision:number;bodyMetadata?:LoftBodySummary[]}|null;bodyId:string|null;faceId:string|null;onModel:(result:DirectModelResult)=>void}){
  if(props.kind==="loft")return <LoftModelingPanel {...props}/>;
  return <SweepModelingPanel {...props} kind={props.kind}/>;
}
