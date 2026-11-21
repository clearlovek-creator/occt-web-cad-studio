"use client";
import {useState} from "react";
import {featureOutputName,featureTypeLabel,type FeatureData} from "../model/feature-graph";
import {ContextActions} from "./ContextActions";

/** Recovery entries are features, not placeholder/hidden geometry Bodies. */
export function SuppressedFeatureBranch({features,total,busy,onEdit,onAction}:{
  features:FeatureData[];total:number;busy?:boolean;onEdit:(featureId:string)=>void;
  onAction:(featureId:string,action:"restore"|"delete")=>Promise<void>;
}){
  const [expanded,setExpanded]=useState(true);
  if(!features.length)return null;
  return <ul className="body-feature-tree suppressed-feature-tree" role="tree" aria-label="已抑制特征树" data-testid="suppressed-features">
    <li role="treeitem" aria-selected={false} aria-expanded={expanded}>
      <button type="button" className="managed-tree-label suppressed-group-label" aria-label={`${expanded?"折叠":"展开"} 已抑制特征`} onClick={()=>setExpanded(value=>!value)}><span className="tree-toggle">{expanded?"▾":"▸"}</span><span className="managed-tree-icon" aria-hidden="true">Ⅱ</span><strong>已抑制特征</strong><small>{features.length===total?total:`${features.length}/${total}`}</small></button>
      {expanded&&<ul role="group" className="body-feature-list suppressed-feature-list">{features.map(feature=>{
        const name=featureOutputName(feature);
        return <li key={feature.id} role="treeitem" aria-selected={false} data-suppressed-feature-id={feature.id}>
          <ContextActions label={`${name} ${feature.id}`} className="suppressed-feature-row" actions={[
            {label:"编辑特征参数",disabled:busy,run:()=>onEdit(feature.id)},
            {label:"恢复特征",disabled:busy,run:()=>onAction(feature.id,"restore")},
            {label:"删除特征",disabled:busy,danger:true,run:()=>onAction(feature.id,"delete")},
          ]}>
            <span className="suppressed-state-mark" aria-hidden="true">Ⅱ</span>
            <button type="button" className="feature-tree-label suppressed-feature-label" aria-label={`编辑已抑制特征 ${feature.id}`} title={`${feature.type} · ${feature.id} · 已抑制；恢复后生成 ${feature.outputBodies.length} 个历史输出`} disabled={busy} onClick={()=>onEdit(feature.id)}><strong>{name}</strong><small>{featureTypeLabel(feature.type)} · {feature.id}</small></button>
            <button type="button" className="suppressed-restore-button" aria-label={`恢复特征 ${feature.id}`} disabled={busy} onClick={()=>void onAction(feature.id,"restore")}>恢复</button>
          </ContextActions>
        </li>;
      })}</ul>}
    </li>
  </ul>;
}
