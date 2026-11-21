"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {CommandEditSession,isReadOnlyCommand} from "./modeling/command-edit-session";
import {CommandEditScope} from "./modeling/CommandEditScope";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BodyAppearancePanel, FeatureTree, boxDimensions, type FeatureData } from "./ModelMetadataPanels";
import { PropertySchemaPanel, PropertyTypeManagerPanel } from "./PropertySchemaPanel";
import { StepExchangePanel } from "./StepExchangePanel";
import { AdvancedModelingPanel } from "./AdvancedModelingPanel";
import { AdvancedBooleanPanel } from "./AdvancedBooleanPanel";
import { GeneratedModelingPanel } from "./GeneratedModelingPanel";
import { WORKBENCH_TABS, type WorkbenchCommand, type PrimitiveKind, type SurfaceKind, type TransformKind, type BooleanKind } from "./workbench/ribbon-catalog";
import { FeatureHistoryControls } from "./FeatureHistoryControls";
import {failedSelectionTarget} from "./FeatureReferenceRepair";
import type {FeatureRepairProposal} from "./modeling/feature-input";
import { CommandChrome } from "./workbench/CommandChrome";
import { CommandJournal } from "./workbench/CommandJournal";
import {ModelingTaskStatus} from './workbench/ModelingTaskStatus';
import {StepImportStatus} from './workbench/StepImportStatus';
import { ProjectTree } from "./workbench/ProjectTree";
import { usePropertySchema } from "./model/property-schema";
import { pruneBodyRenderables } from "./model/render-cache";
import { viewportHealth } from "./model/viewport-health";
import {createViewportFrame} from './model/viewport-frame';
import {MeshWireLayer} from './model/mesh-wire-layer';
import { gridDragDimensionText, gridDragHeightReference, gridDragInstruction, gridDragSteps, hasDragFootprintMovement, hasDragHeightAdjustment, heightFromScreenDrag, needsDragHeight, shouldSwitchModelingMethod, type GridDragKind } from "./modeling/grid-drag";
import { dragPreviewGeometry } from "./modeling/grid-drag-preview";
import {constructionFrame,constructionToWorld,constructionDragCommand,snappedConstructionPoint,dragDimension,GLOBAL_CONSTRUCTION_COORDINATE,type ConstructionFrame} from "./modeling/construction-frame";
import {alignConstructionGrid,constructionMatrix,createConstructionGrid} from "./modeling/construction-frame-three";
import {ConstructionControls} from "./workbench/ConstructionControls";
import { useModelingController, workspaceFileName,ModelingCommandError } from "./modeling/modeling-controller";
import {startBackupDownload} from './modeling/backup-download-action';
import { useWorkspaceMetadata } from "./model/workspace";
import { WorkspacePanel } from "./workbench/WorkspacePanel";
import { ProjectBackupPanel } from "./workbench/ProjectBackupPanel";
import {SourceAuditPanel} from './SourceAuditPanel';
import {SourceRecoveryBanner} from './workbench/SourceRecoveryBanner';
import { ProjectLoadStatus } from "./workbench/ProjectLoadStatus";
import { OperationWindow } from "./workbench/OperationWindow";
import { StudioIcon } from "./workbench/StudioIcon";
import { CommandDock, PropertiesDock, defaultStudioPanels, studioPanels, type SelectionDetails, type StudioPanel } from "./workbench/StudioPanels";
import { PiModelingAgentPanel } from "./PiModelingAgentPanel";
import { MeasurementPanel } from "./MeasurementPanel";
import { measurementRows, type MeasurementSnapshot } from "./modeling/measurement";
import { engineeringNumber } from "./modeling/engineering-number";
import {canonicalPropertyHighlightTargets,makePropertyHighlight} from './modeling/property-highlight';
import type {PropertyTarget} from './model/property-schema';
import { AgentProviderSettingsPanel } from "./AgentProviderSettingsPanel";
import { MeshWorkbenchPanel } from "./MeshWorkbenchPanel";
import type { CadCommandId } from "./commands/command-registry";
import { type CoordinateSystemData, type MaterialData, type ScalarVariableData } from "./ProjectDataPanel";
import { AdvancedProjectDataPanel, type ProjectDataMode } from "./AdvancedProjectDataPanel";
import { modelingController } from "./modeling/runtime";
import { API_ROOT } from "./api-config";
import type {MeshJobPayload,MeshRenderGroup,MeshQualitySelection,MeshPreparationResult,MeshDiagnosticTarget} from "./model/mesh";
import {createPreparationPreview} from "./model/mesh-preparation-render";
import {createMeshDiagnosticHighlight} from "./model/mesh-quality-render";
import {diagnosticCellsVisible,diagnosticSelectionProblem} from './model/mesh-spatial';
import {setViewportPositions,placeViewportObject,isViewportCoordinateError,viewportSpan,viewportOrbitLimits} from './model/viewport-coordinates';
import {viewportRaycaster,pickViewportBody,pickViewportEdge} from './model/viewport-picking';
import { bodyLayer, edgeLayer, changeViewportProjection, setBodyDisplay, setViewportFrustum, setViewportDisplay, viewportFov, viewportViewHeight, viewportFitDistance, visibleViewportBounds, type ViewportCamera, type ViewportDisplay, type ViewportProjection } from "./model/viewport-camera";
import {meshTopologyLabels} from './model/mesh-topology';
import {useProjectMeshJobs} from "./model/use-project-mesh-jobs";
import {assessMeshSource} from "../shared/mesh-source.mjs";
import {assessMeshDisplaySource} from './model/mesh-display-source';
import {bodyMeshRootGroupIds} from './model/mesh-display-groups';
import {meshAdmitted} from '../shared/mesh-admission.mjs';
import type { ModelingCommandInput, ModelingCommandResponse } from "./modeling/command-contract";

type SelectionMode = "body" | "face" | "edge";
type StandardView = "iso" | "top" | "front" | "right" | "back";
type OperationKind = "primitives" | "surfaces" | "transform" | "boolean" | "agent" | "agentSettings" | "mesh" | "pattern" | "patternCircular" | "patternRectangular" | "patternMirror" | "revolve" | "shapeCheck" | "measure" | "fillet" | "chamfer" | "draft" | "offsetFeature" | "exchange" | "properties" | "propertyTypes" | "history" | "projectData" | "capabilities" | "bodyAppearance" | "generated" | "workspace" | "sources" | "backups" | "nameBeforeSave";

const OPERATION_META: Record<OperationKind, { title: string; subtitle: string }> = {
  nameBeforeSave: { title: "保存工程", subtitle: "输入工程名称后生成备份" },
  backups:{title:'工程备份管理',subtitle:'独立备份目录 · 原始版本下载 · 文件维护'},
  sources:{title:'工程来源与引用',subtitle:'来源检查 · 恢复记录 · 旧工程引用升级'},
  workspace: { title: "工程管理与恢复", subtitle: "工程名称 · 后台恢复快照 · 下载备份状态" },
  generated: { title: "生成几何", subtitle: "扫掠 · 管道 · 放样" },
  bodyAppearance: { title: "几何设置", subtitle: "名称 · 材料 · 颜色 · 不透明度" },
  primitives: { title: "创建基础体", subtitle: "Solid Body · 常用三维基元" },
  surfaces: { title: "创建基础面", subtitle: "Rectangle · Disk · Cylinder · Cone · Sphere" },
  transform: { title: "实体变换", subtitle: "Translate · Rotate · Mirror · Scale" },
  boolean: { title: "Boolean 运算", subtitle: "Fuse · Cut · Common" },
  agent: { title: "建模助手", subtitle: "Pi Agent · 当前工程 CAD 工具" },

  agentSettings: { title: "大模型设置", subtitle: "OpenAI 兼容 Provider · 连接测试 · API Key 管理" },
  mesh: { title: "网格工具", subtitle: "脏几何修复 · 表面交叉处理 · 四面体质量分析" },
  pattern: { title: "线性阵列", subtitle: "沿方向复制当前 Body" },
  patternCircular: { title: "环形阵列", subtitle: "绕轴复制当前 Body" },
  patternRectangular: { title: "矩形阵列", subtitle: "沿两条方向复制当前 Body" },
  patternMirror: { title: "镜像阵列", subtitle: "跨平面复制当前 Body" },
  revolve: { title: "旋转体", subtitle: "绕指定轴旋转选中的 Face 生成新 Body" },
  shapeCheck: { title: "Shape Check", subtitle: "OCCT 几何有效性与拓扑统计" },
  measure: { title: "几何测量", subtitle: "体 / 面 / 边 · BRep 几何计量 · Global / mm" },
  fillet: { title: "边圆角", subtitle: "选择 Edge 后创建精确 Fillet" },
  chamfer: { title: "边倒角", subtitle: "选择 Edge 后创建对称距离 Chamfer" },
  draft: { title: "拔模", subtitle: "选择 Face，设置中性面和拔模角度" },
  offsetFeature: { title: "壳体与偏置", subtitle: "Shell · Thicken · Offset" },
  exchange: { title: "工程 / STEP 文件", subtitle: "CADPROJ 工程包 · 兼容 XBF · STEP 交换" },
  properties: { title: "属性实例", subtitle: "工程级或 Body · Face · Edge 属性实例" },
  propertyTypes: { title: "属性类型管理", subtitle: "可复用类型 · 自定义属性字段 · 类型文件" },
  history: { title: "参数与历史", subtitle: "特征重算 · Undo · Redo" },
  projectData: { title: "工程参数", subtitle: "标量变量 · 参数表达式 · 坐标系" },
  capabilities: { title: "当前建模能力", subtitle: "已接入的真实 OCCT 命令" },
};

type EdgeData = {
  edgeId: string;
  points: number[];
};

type BodyPresentation = {
  bodyId: string;
  topologyRevision: number;
  positions: number[];
  normals: number[];
  indices: number[];
  triangleFaceIds: string[];
  edges: EdgeData[];
  presentationQuality?: "preview" | "full";
  stats: {
    faceCount: number;
    edgeCount: number;
    triangleCount: number;
    truncated?: boolean;
  };
};

type BodyMetadata = { bodyId: string; bodyIdentity?: string; topologyIdentity?: string; topologyRevision?: number; name: string; visible: boolean; color: string; material: string; opacity?: number; kind: "solid" | "sheet" | "wire" | "shape" };

type ModelData = BodyPresentation & {
  ok: true;
  documentId?: string;
  stateToken?: string;
  stateSequence?: number;
  history?: ModelingCommandResponse["history"];
  revision: number;
  bodyCount: number;
  canUndo?: boolean;
  canRedo?: boolean;
  warnings?: string[];
  features: FeatureData[];
  bodyPresentations?: BodyPresentation[];
  activeBodyId?: string;
  presentationMode?: "metadata" | "preview" | "lazy" | "full";
  variables?: ScalarVariableData[];
  coordinateSystems?: CoordinateSystemData[];
  materials?: MaterialData[];
  bodyMetadata?: BodyMetadata[];
};



const defaultBodyColor = 0x7b91aa;
const defaultEdgeColor = 0x203040;
const selectionColor = 0xffb14a;
const selectionEmissive = 0x3a1b00;
const bodySelectionColor = 0x688fc6;
const dockedOperations = new Set<OperationKind>(["primitives", "surfaces", "transform", "fillet", "chamfer", "draft", "revolve", "offsetFeature", "shapeCheck", "bodyAppearance"]);

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const renderable = child as THREE.Mesh | THREE.Line;
    if (renderable.geometry) renderable.geometry.dispose();
    if (renderable.material) {
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material];
      materials.forEach((material) => material.dispose());
    }
  });
}


export default function CadDemo() {
  const mountRef = useRef<HTMLDivElement>(null);
  const menuProjectInputRef = useRef<HTMLInputElement>(null);
  const menuStepInputRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<ViewportCamera | null>(null);
  const viewportCameraRef = useRef<{camera: ViewportCamera; target: THREE.Vector3} | null>(null);
  const changeProjectionRef = useRef<(value: ViewportProjection) => void>(() => undefined);
  const captureViewportRef = useRef<() => void>(() => undefined);
  const snapMarkerRef = useRef<HTMLSpanElement>(null);
  const [projection, setProjection] = useState<ViewportProjection>("perspective");
  const [displayMode, setDisplayMode] = useState<ViewportDisplay>("edges");
  const displayModeRef = useRef<ViewportDisplay>("edges");
  const axesRef = useRef<SVGSVGElement>(null);
  const [panelVisibility, setPanelVisibility] = useState(defaultStudioPanels);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [treeQuery, setTreeQuery] = useState("");
  const panelMenuRef = useRef<HTMLDivElement>(null);
  const changePanel = useCallback((id: StudioPanel, visible: boolean) => {
    setPanelVisibility(current => ({ ...current, [id]: visible }));
  }, []);
  const restorePanels = useCallback(() => {
    setPanelVisibility(defaultStudioPanels);
    setMessagesExpanded(true);
    setAgentOpen(false);
    setPanelMenuOpen(false);
  }, []);
  useEffect(() => {
    if (!panelMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!panelMenuRef.current?.contains(event.target as Node)) setPanelMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPanelMenuOpen(false);
      panelMenuRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [panelMenuOpen]);
  const changeDisplayMode = useCallback((value: ViewportDisplay) => {
    displayModeRef.current = value;
    setDisplayMode(value);
    if (cameraRef.current) setViewportDisplay(cameraRef.current, value, selectionModeRef.current === "edge");
    bodyMeshesRef.current.forEach(mesh => setBodyDisplay(mesh, value));
    invalidateViewportRef.current();
  }, []);
  const controlsRef = useRef<OrbitControls | null>(null);
  const invalidateViewportRef=useRef<()=>void>(()=>{});
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const meshGroupRef = useRef<THREE.Group | null>(null);
  const meshWireLayerRef=useRef<MeshWireLayer|null>(null),meshWireProgressRef=useRef(''),meshWireErrorRef=useRef('');
  const qualityGroupRef = useRef<THREE.Group | null>(null);
  const qualitySelectionRef = useRef<MeshQualitySelection|null>(null);
  const preparationGroupRef=useRef<THREE.Group|null>(null);
  const preparationDisplayRef=useRef<MeshPreparationResult|null>(null);
  const preparationVisibilityRef=useRef(new Map<string,boolean>());
  const meshResultsRef = useRef<MeshJobPayload[]>([]);
  const meshGroupVisibilityRef = useRef(new Map<string, boolean>());
  const meshBodyLoadsRef=useRef(new Map<string,{controller:AbortController;jobId:string;documentId:string}>());
  const [pendingMeshBodies,setPendingMeshBodies]=useState<Record<string,boolean>>({});
  useEffect(()=>{const loads=meshBodyLoadsRef.current;return()=>{for(const entry of loads.values())entry.controller.abort();loads.clear();};},[]);
  const bodyMeshesRef = useRef<THREE.Mesh[]>([]);
  const edgeLinesRef = useRef<THREE.Line[]>([]);
  const faceHighlightRef = useRef<THREE.Mesh | null>(null);
  const propertyHighlightRef=useRef<THREE.Group|null>(null),propertyHighlightEpoch=useRef(0);
  const propertySelectionRef=useRef<{documentId:string;propertyKey:string;targets:NonNullable<PropertyTarget>[]} | null>(null);
  const propertySchemaKeyRef=useRef('');
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const dragModelingRef = useRef(false);
  const dragSessionRef=useRef<CommandEditSession|null>(null);
  const dragPrimitiveRef = useRef<GridDragKind>("box");
  const dragStartRef = useRef<THREE.Vector3 | null>(null);
  const dragEndRef = useRef<THREE.Vector3 | null>(null);
  const dragStageRef = useRef<"idle" | "base" | "height">("idle");
  const dragHeightRef = useRef(20);
  const dragCommittingRef = useRef(false);
  const dragHeightAnchorRef = useRef({ x: 0, y: 0 });
  const dragFootprintAnchorRef = useRef({ x: 0, y: 0 });
  const dragHeightAdjustedRef = useRef(false);
  const cancelDragRef = useRef<() => void>(() => undefined);
  const reselectDragBaseRef = useRef<() => void>(() => undefined);
  const parameterInputRef = useRef<{ kind: GridDragKind; parameters: Record<string, unknown> } | null>(null);
  const dragGhostRef = useRef<THREE.Group | null>(null);
  const constructionFrameRef=useRef<ConstructionFrame|null>(null);
  const dragFrameRef=useRef<ConstructionFrame|null>(null);
  const snapStepRef=useRef(1),dragStepRef=useRef(1);
  const modelRef = useRef<ModelData | null>(null);
  const modelGenerationRef = useRef(0);
  const selectedBodyIdsRef = useRef<string[]>([]);
  const bodySelectionAnchorRef = useRef<string | null>(null);
  const fullRenderLoadRef = useRef<Promise<void> | null>(null);
  const boxSelectRef = useRef<{ startX: number; startY: number; additive: boolean; active: boolean } | null>(null);
  const initialLoadStartedRef = useRef(false);
  const restoreRetryTimerRef = useRef<number | null>(null);
  const selectionModeRef = useRef<SelectionMode>("face");
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const bodyPresentationLoadsRef = useRef(new Map<string, Promise<void>>());
  const assemblyPreviewLoadRef = useRef<Promise<void> | null>(null);

  const [filletRadius, setFilletRadius] = useState(5);
  const [messagesExpanded, setMessagesExpanded] = useState(true);
  const [chamferDistance, setChamferDistance] = useState(2);
  const [offsetFeatureKind, setOffsetFeatureKind] = useState<"shell" | "thicken" | "offset">("shell");
  const [draftAngleExpression, setDraftAngleExpression] = useState("5 deg");
  const [draftNeutralOrigin, setDraftNeutralOrigin] = useState({ x: "0", y: "0", z: "0" });
  const [draftNeutralNormal, setDraftNeutralNormal] = useState({ x: "0", y: "0", z: "1" });
  const [draftDirection, setDraftDirection] = useState({ x: "0", y: "0", z: "1" });
  const [patternCountExpression, setPatternCountExpression] = useState("3");
  const [patternSpacingExpression, setPatternSpacingExpression] = useState("50 mm");
  const [patternDirection, setPatternDirection] = useState({ x: "1", y: "0", z: "0" });
  const [circularCountExpression, setCircularCountExpression] = useState("4");
  const [circularAngleExpression, setCircularAngleExpression] = useState("90 deg");
  const [circularOrigin, setCircularOrigin] = useState({ x: "0", y: "0", z: "0" });
  const [circularAxis, setCircularAxis] = useState({ x: "0", y: "0", z: "1" });
  const [rectangularCountXExpression, setRectangularCountXExpression] = useState("3");
  const [rectangularCountYExpression, setRectangularCountYExpression] = useState("2");
  const [rectangularSpacingXExpression, setRectangularSpacingXExpression] = useState("50 mm");
  const [rectangularSpacingYExpression, setRectangularSpacingYExpression] = useState("50 mm");
  const [rectangularDirection1, setRectangularDirection1] = useState({ x: "1", y: "0", z: "0" });
  const [rectangularDirection2, setRectangularDirection2] = useState({ x: "0", y: "1", z: "0" });
  const [mirrorOrigin, setMirrorOrigin] = useState({ x: "0", y: "0", z: "0" });
  const [mirrorNormal, setMirrorNormal] = useState({ x: "1", y: "0", z: "0" });
  const [revolveAngleExpression, setRevolveAngleExpression] = useState("360 deg");
  const [revolveOrigin, setRevolveOrigin] = useState({ x: "0", y: "0", z: "0" });
  const [revolveAxis, setRevolveAxis] = useState({ x: "0", y: "0", z: "1" });
  const [shapeCheckResult, setShapeCheckResult] = useState<{ documentId: string; bodyId: string; stateToken: string | null; valid: boolean; faceCount: number; edgeCount: number; solidCount: number } | null>(null);
  const [offsetExpression, setOffsetExpression] = useState("2 mm");
  const [offsetReverse, setOffsetReverse] = useState(false);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("face");
  useEffect(() => {
    if (cameraRef.current) setViewportDisplay(cameraRef.current, displayModeRef.current, selectionMode === "edge");
    invalidateViewportRef.current();
  }, [selectionMode]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(null);
  const [selectedBodyIds, setSelectedBodyIds] = useState<string[]>([]);
  const [model, setModel] = useState<ModelData | null>(null);
  const [meshResults, setMeshResults] = useState<MeshJobPayload[]>([]);
  const [qualitySelection,setQualitySelection] = useState<MeshQualitySelection|null>(null);
  const [preparationDisplay,setPreparationDisplay]=useState<MeshPreparationResult|null>(null);
  const [meshGroupVisibility, setMeshGroupVisibility] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [sourceRecoveryBlocked,setSourceRecoveryBlocked]=useState(false);
  const [assemblyProgress, setAssemblyProgress] = useState<number | null>(null);
  const [selectionRect, setSelectionRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [dragModeling, setDragModeling] = useState(false);
  const [dragPrimitive, setDragPrimitive] = useState<GridDragKind>("box");
  const [dragPreview, setDragPreview] = useState<{ width: number; depth: number; height: number; x: number; y: number } | null>(null);
  const [dragStage, setDragStage] = useState<"idle" | "base" | "height">("idle");
  const [parameterDraft, setParameterDraft] = useState<{ kind: GridDragKind; parameters: Record<string, unknown>; version: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ left: number; top: number } | null>(null);
  const viewportMenuRef = useRef<HTMLDivElement>(null);
  const [deletingBodyId, setDeletingBodyId] = useState<string | null>(null);
  const [status, setStatus] = useState("正在连接 OCCT 几何服务…");
  const [propertySelectionCount,setPropertySelectionCount]=useState({total:0,visible:0});
  const [error, setError] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const [activeOperation, setOperation] = useState<OperationKind | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saveNameOwner, setSaveNameOwner] = useState<string | null>(null);
  const [saveNameError, setSaveNameError] = useState<string | null>(null);
  const savingProjectRef = useRef(false);
  const [commandTabVersion, setCommandTabVersion] = useState(0);
  const setActiveOperation = useCallback((operation: OperationKind | null) => {
    setOperation(operation);
    if (operation) {
      changePanel("commands", true);
      setCommandTabVersion(current => current + 1);
      if (dockedOperations.has(operation)) setAgentOpen(false);
    }
  }, [changePanel]);
  const [sourcePanelView,setSourcePanelView]=useState<'audit'|'restores'>('audit');
  const [activeTool, setActiveTool] = useState<WorkbenchCommand | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [generatedKind, setGeneratedKind] = useState<"sweep" | "pipe" | "loft">("sweep");
  const [featureToEdit, setFeatureToEdit] = useState<string | null>(null);
  const [treeFeatureRepair,setTreeFeatureRepair]=useState<FeatureRepairProposal|null>(null);
  const [treeRepairEpoch,setTreeRepairEpoch]=useState(0);
  const [projectDockWidth, setProjectDockWidth] = useState(302);
  const dockResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [projectDataMode, setProjectDataMode] = useState<ProjectDataMode>("variables");
  const [projectDataItemId, setProjectDataItemId] = useState<string | null>(null);
  const [projectDataCopyId, setProjectDataCopyId] = useState<string | null>(null);
  const [propertyTypeId, setPropertyTypeId] = useState<string | null | undefined>(undefined);
  const [propertyInstanceId, setPropertyInstanceId] = useState<string | null | undefined>(undefined);
  const [instanceTypeId, setInstanceTypeId] = useState<string | null>(null);
  const [appearanceBodyId, setAppearanceBodyId] = useState<string | null>(null);
  const controllerState = useModelingController(modelingController);
  const [constructionSelection,setConstructionSelection]=useState(()=>({documentId:modelingController.getSnapshot().documentId,id:"global"}));
  const constructionId=constructionSelection.documentId===controllerState.documentId?constructionSelection.id:"global";
  const [snapStep,setSnapStep]=useState(1);
  const constructionCoordinates=model?.coordinateSystems?.length?model.coordinateSystems:[GLOBAL_CONSTRUCTION_COORDINATE];
  const constructionInfo=useMemo(()=>{
    const coordinate=constructionId==="global"?GLOBAL_CONSTRUCTION_COORDINATE:constructionCoordinates.find(item=>item.id===constructionId);
    if(!coordinate)return {frame:null,error:"所选坐标系已删除，请重新选择；不会自动改用 Global。"};
    try{return {frame:constructionFrame(coordinate),error:null};}catch(reason){return {frame:null,error:reason instanceof Error?reason.message:"构造坐标系无效。"};}
  },[constructionCoordinates,constructionId]);
  useEffect(()=>{
    if(dragFrameRef.current && (dragFrameRef.current.signature!==constructionInfo.frame?.signature || dragStepRef.current!==snapStep))cancelDragRef.current();
    constructionFrameRef.current=constructionInfo.frame;snapStepRef.current=snapStep;
    if(gridRef.current)alignConstructionGrid(gridRef.current,constructionInfo.frame,gridVisibleRef.current);
    invalidateViewportRef.current();
  },[constructionInfo.frame,snapStep]);
  useEffect(()=>{if(dragSessionRef.current?.isStale()){cancelDragRef.current();setStatus("工程已变化，已取消旧绘制，请重新开始。");}},[controllerState.documentId,controllerState.stateToken]);
  const [editorEpoch,setEditorEpoch]=useState(0);
  const editableOperation=activeOperation && ["primitives","surfaces","transform","boolean","pattern","patternCircular","patternRectangular","patternMirror","revolve","fillet","chamfer","draft","offsetFeature","history","projectData","bodyAppearance","generated"].includes(activeOperation);
  const editorKey=editableOperation?`${activeOperation}:${activeTool}:${projectDataMode}:${projectDataItemId}:${projectDataCopyId}:${featureToEdit}:${appearanceBodyId}:${activeOperation==="history"?treeRepairEpoch:""}:${activeOperation==="generated"?generatedKind:""}`:null;
  const editorReady=Boolean(controllerState.stateToken);
  const editorSession=useMemo(()=>editorKey && editorReady?new CommandEditSession(modelingController,{documentId:modelingController.getSnapshot().documentId,revision:modelRef.current?.revision??null,stateToken:modelRef.current?.stateToken??null}):null,[editorKey,editorEpoch,editorReady]);
  const editorSessionRef=useRef(editorSession);editorSessionRef.current=editorSession;
  const postCommand=useCallback(<TResponse extends ModelingCommandResponse=ModelData>(payload:ModelingCommandInput)=>modelingController.execute<TResponse>({...payload,...(!isReadOnlyCommand(payload.operation) && !payload.baseStateToken && modelRef.current?.stateToken?{baseStateToken:modelRef.current.stateToken}:{})}),[]);
  const postEditCommand=useCallback(<TResponse extends ModelingCommandResponse=ModelData>(payload:ModelingCommandInput)=>editorSessionRef.current?editorSessionRef.current.execute<TResponse>(payload):postCommand<TResponse>(payload),[]);
  const resetInlineEditorDrafts=useCallback(()=>{
    setTreeFeatureRepair(null);
    const origin={x:"0",y:"0",z:"0"},axis={x:"0",y:"0",z:"1"},xAxis={x:"1",y:"0",z:"0"};
    parameterInputRef.current = null;
    setParameterDraft(null);setFilletRadius(5);setChamferDistance(2);setOffsetExpression("2 mm");setOffsetReverse(false);
    setDraftAngleExpression("5 deg");setDraftNeutralOrigin(origin);setDraftNeutralNormal(axis);setDraftDirection(axis);
    setPatternCountExpression("3");setPatternSpacingExpression("50 mm");setPatternDirection(xAxis);
    setCircularCountExpression("4");setCircularAngleExpression("90 deg");setCircularOrigin(origin);setCircularAxis(axis);
    setRectangularCountXExpression("3");setRectangularCountYExpression("2");setRectangularSpacingXExpression("50 mm");setRectangularSpacingYExpression("50 mm");setRectangularDirection1(xAxis);setRectangularDirection2({x:"0",y:"1",z:"0"});
    setMirrorOrigin(origin);setMirrorNormal(xAxis);setRevolveAngleExpression("360 deg");setRevolveOrigin(origin);setRevolveAxis(axis);setError(null);
  },[]);
  const activity=controllerState.commandLog.at(-1);
  const workspace=useWorkspaceMetadata(controllerState.documentId,model?.revision,`${activity?.requestId}:${activity?.status}`);
  const commandBusy = busy || controllerState.busy;
  const commandError = error || controllerState.error?.error || null;
  const clearDocumentJournal = () => {
    const previous = modelingController.getSnapshot().error;
    modelingController.clearCommandLog(controllerState.documentId);
    if (previous && !modelingController.getSnapshot().error) setError(message => message === previous.error ? null : message);
  };
  useEffect(()=>{if(activity?.status!=='cancelled'||activity.documentId!==controllerState.documentId)return;const latest=modelingController.getSnapshot().commandLog.at(-1);if(latest?.requestId!==activity.requestId)return;setError(value=>value===activity.message?null:value);setStatus(activity.operation==='project.backup.download'?'已停止下载，后台备份仍保留。':'已取消操作，工程未提交此项修改。');},[activity?.requestId,activity?.status,activity?.documentId,activity?.message,activity?.operation,controllerState.documentId]);
  const [outputTab, setOutputTab] = useState<"messages" | "journal" | "measurements">("messages");
  const [measurement, setMeasurement] = useState<MeasurementSnapshot | null>(null);
  const [measureBodyOnly, setMeasureBodyOnly] = useState(false);
  const [outputHeight, setOutputHeight] = useState(162);
  const outputResizeRef = useRef<{ y: number; height: number } | null>(null);
  const propertySchema = usePropertySchema(model?.revision, controllerState.documentId);
  const propertySchemaKey=useMemo(()=>JSON.stringify([propertySchema.types,propertySchema.instances]),[propertySchema.types,propertySchema.instances]);
  useEffect(()=>{propertySchemaKeyRef.current=propertySchemaKey;},[propertySchemaKey]);
  const [gridVisible, setGridVisible] = useState(true);
  const gridVisibleRef = useRef(gridVisible);
  useEffect(() => {gridVisibleRef.current=gridVisible;if(gridRef.current)gridRef.current.visible=gridVisible&&Boolean(constructionFrameRef.current);invalidateViewportRef.current();},[gridVisible]);
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const menu = viewportMenuRef.current;
    const viewport = mountRef.current;
    if (!menu || !viewport) return;
    menu.style.left = `${Math.max(0, Math.min(contextMenu.left, viewport.clientWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(contextMenu.top, viewport.clientHeight - menu.offsetHeight))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [contextMenu]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".viewport-context-menu")) return;
      setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setContextMenu(null);
      mountRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [contextMenu]);
  useEffect(() => {
    const value = window.localStorage.getItem("occt.projectDockWidth");
    if (value === null) return;
    const stored = Number(value);
    if (!Number.isFinite(stored)) return;
    const frame = window.requestAnimationFrame(() => setProjectDockWidth(Math.min(420, Math.max(220, stored))));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("occt.projectDockWidth", String(projectDockWidth));
  }, [projectDockWidth]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = dockResizeRef.current;
      if (!resize) return;
      setProjectDockWidth(Math.min(420, Math.max(220, resize.startWidth + event.clientX - resize.startX)));
    };
    const stopResize = () => {
      dockResizeRef.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, []);

  const startDockResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dockResizeRef.current = { startX: event.clientX, startWidth: projectDockWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  useEffect(() => {
    modelingController.setActiveOperation(activeOperation);
  }, [activeOperation]);

  useEffect(() => {
    cancelDragRef.current();
    // A parameter/analysis window owns the interaction while it is open.
    dragModelingRef.current = dragModeling && !activeOperation && !sourceRecoveryBlocked;
  }, [dragModeling, activeOperation,sourceRecoveryBlocked]);
  useEffect(() => { cancelDragRef.current(); dragPrimitiveRef.current = dragPrimitive; }, [dragPrimitive]);
  const alignToConstruction=useCallback(()=>{
    const frame=constructionFrameRef.current,camera=cameraRef.current,controls=controlsRef.current;
    if(!frame || !camera || !controls)return;
    const distance=Math.max(camera.position.distanceTo(controls.target),10);
    controls.target.set(...frame.origin);camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...frame.z),distance);camera.up.set(...frame.y);
    camera.near=Math.max(distance/10000,.0001);camera.far=Math.max(distance*100,10000);camera.updateProjectionMatrix();controls.update();camera.updateMatrixWorld();
    setStatus("已正视构造面 · "+frame.name+" · 不修改工程");
  },[]);
  const rememberParameterInput = useCallback((kind: GridDragKind, parameters: Record<string, unknown>) => {
    parameterInputRef.current = { kind, parameters };
  }, []);
  const changeModelingMethod = useCallback((drag: boolean) => {
    if(sourceRecoveryBlocked){setStatus('来源事务待复核，暂不能开始建模，请查看恢复记录。');return;}
    if (dragCommittingRef.current || modelingController.hasPendingMutation()) return;
    if (drag && dragModelingRef.current) return;
    if (!drag && (activeOperation === "primitives" || activeOperation === "surfaces")) {
      setActiveOperation(activeOperation);
      return;
    }
    const kind = dragPrimitiveRef.current;
    let parameters = parameterInputRef.current?.kind === kind ? parameterInputRef.current.parameters : null;
    if (!drag && dragStartRef.current && dragEndRef.current) {
      const command = dragFrameRef.current?constructionDragCommand(kind, dragStartRef.current, dragEndRef.current, dragStepRef.current, dragStageRef.current === "height" ? dragHeightRef.current : 20,dragFrameRef.current):null;
      if (command) parameters = command.parameters;
    }
    if (!drag) setParameterDraft(parameters ? { kind, parameters, version: Date.now() } : null);
    cancelDragRef.current();
    setDragModeling(drag);
    const surface = kind.startsWith("surface-");
    setActiveTool(`${surface ? "surface" : "primitive"}.${kind.replace("surface-", "")}` as WorkbenchCommand);
    setActiveOperation(drag ? null : surface ? "surfaces" : "primitives");
  }, [activeOperation,setActiveOperation,sourceRecoveryBlocked]);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (shouldSwitchModelingMethod({code:event.code,altKey:event.altKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,repeat:event.repeat,isComposing:event.isComposing,
        editable:Boolean(target?.closest('input,textarea,select,[contenteditable="true"]')),
        inPrimitiveEditor:Boolean(target?.closest('[data-testid="advanced-modeling-panel"]')) && (activeOperation === "primitives" || activeOperation === "surfaces")})) {
        event.preventDefault(); changeModelingMethod(!dragModelingRef.current);
      }
    };
    window.addEventListener("keydown", toggle); return () => window.removeEventListener("keydown", toggle);
  }, [activeOperation,changeModelingMethod]);
  useEffect(()=>{const protect=(event:BeforeUnloadEvent)=>{if(busy || modelingController.hasPendingMutation() || dragStageRef.current!=="idle"){event.preventDefault();event.returnValue="";}};window.addEventListener("beforeunload",protect);return()=>window.removeEventListener("beforeunload",protect);},[busy]);

  useEffect(() => {
    if (!selectedId && !selectedBodyId) {
      modelingController.setSelection(null);
      return;
    }
    const bodyId = selectedBodyId || (selectionMode === "body" ? selectedId : model?.bodyId);
    if (!bodyId) return;
    modelingController.setSelection({
      kind: selectionMode,
      bodyId,
      ...(selectionMode === "body" ? {} : { topologyId: selectedId || undefined }),
    });
  }, [model?.bodyId, selectedBodyId, selectedId, selectionMode]);


  const removePropertyHighlight=useCallback(()=>{invalidateViewportRef.current();if(propertyHighlightRef.current){sceneRef.current?.remove(propertyHighlightRef.current);disposeObject(propertyHighlightRef.current);propertyHighlightRef.current=null;}if(mountRef.current)mountRef.current.dataset.propertyHighlightedTargets='0';},[]);
  const renderPropertySelection=useCallback(()=>{
    removePropertyHighlight();const intent=propertySelectionRef.current,scene=sceneRef.current,current=modelRef.current;
    if(!intent||!scene||!current)return;
    if(intent.documentId!==modelingController.getSnapshot().documentId){propertySelectionRef.current=null;setPropertySelectionCount({total:0,visible:0});return;}
    try{const group=makePropertyHighlight(intent.targets,current.bodyMetadata||[],bodyMeshesRef.current.map(mesh=>mesh.userData.presentation as BodyPresentation),selectionColor,selectionEmissive);if(group.children.length){scene.add(group);propertyHighlightRef.current=group;}else disposeObject(group);setPropertySelectionCount({total:intent.targets.length,visible:Number(group.userData.renderedTargets||0)});if(mountRef.current)mountRef.current.dataset.propertyHighlightedTargets=String(group.userData.renderedTargets||0);}
    catch{propertySelectionRef.current=null;setPropertySelectionCount({total:0,visible:0});}
  },[removePropertyHighlight]);
  const clearHighlight = useCallback(() => {
    propertyHighlightEpoch.current++;propertySelectionRef.current=null;removePropertyHighlight();setPropertySelectionCount({total:0,visible:0});
    bodyMeshesRef.current.forEach((mesh) => {
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.setHex(Number(mesh.userData.baseColor ?? defaultBodyColor));
      material.emissive.setHex(0x000000);
    });

    edgeLinesRef.current.forEach((line) => {
      const material = line.material as THREE.LineBasicMaterial;
      material.color.setHex(defaultEdgeColor);
      line.renderOrder = 1;
    });

    if (faceHighlightRef.current && modelGroupRef.current) {
      modelGroupRef.current.remove(faceHighlightRef.current);
      disposeObject(faceHighlightRef.current);
      faceHighlightRef.current = null;
    }
    setSelectedId(null);
    setSelectedBodyId(null);
    selectedBodyIdsRef.current = [];
    setSelectedBodyIds([]);
  }, [removePropertyHighlight]);

  useEffect(()=>{
    if(propertySelectionRef.current && propertySelectionRef.current.propertyKey!==propertySchemaKey)clearHighlight();
  },[propertySchemaKey,clearHighlight]);
  const applyBodySelection = useCallback((bodyIds: string[]) => {
    const next = [...new Set(bodyIds)];
    const selected = new Set(next);
    clearHighlight();
    bodyMeshesRef.current.forEach((mesh) => {
      const material = mesh.material as THREE.MeshStandardMaterial;
      const baseColor = Number(mesh.userData.baseColor ?? defaultBodyColor);
      if (selected.has(String(mesh.userData.bodyId))) {
        material.color.setHex(bodySelectionColor);
        material.emissive.setHex(0x000000);
      } else {
        material.color.setHex(baseColor);
        material.emissive.setHex(0x000000);
      }
    });
    selectedBodyIdsRef.current = next;
    setSelectedBodyIds(next);
    setSelectedBodyId(next[0] || null);
    setSelectedId(next[0] || null);
  }, [clearHighlight]);
  const updateOrbitLimits = useCallback((object:THREE.Object3D)=>{
    const controls=controlsRef.current;if(!controls)return;
    const box=visibleViewportBounds(object);if(box.isEmpty())return;
    const size=box.getSize(new THREE.Vector3());Object.assign(controls,viewportOrbitLimits(Math.max(size.x,size.y,size.z)));
  },[]);
  const frameViewport = useCallback((object: THREE.Object3D, direction: THREE.Vector3, up: THREE.Vector3) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const box = visibleViewportBounds(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = viewportSpan(Math.max(size.x, size.y, size.z));
    const mount = mountRef.current;
    const aspect = Math.max(1, mount?.clientWidth ?? 1) / Math.max(1, mount?.clientHeight ?? 1);
    const distance = Math.max(span * 1.25, viewportFitDistance(box, direction, up, aspect));
    const orbitLimits = viewportOrbitLimits(span);
    Object.assign(controls, orbitLimits, { maxDistance: Math.max(orbitLimits.maxDistance, distance * 2) });
    camera.near = span / 1000;
    camera.far = Math.max(span * 100, distance * 3);
    camera.position.copy(center).addScaledVector(direction.normalize(), distance);
    camera.up.copy(up);
    setViewportFrustum(camera, aspect, distance);
    controls.target.copy(center);
    controls.update();
    camera.updateMatrixWorld();
    invalidateViewportRef.current();
  }, []);
  const fitCamera = useCallback((object: THREE.Object3D) => {
    frameViewport(object, new THREE.Vector3(1.12, -1.65, 0.95), new THREE.Vector3(0, 0, 1));
  }, [frameViewport]);

  const removeMeshGroup = useCallback(() => {
    invalidateViewportRef.current();
    const scene = sceneRef.current;
    const streamed=meshWireLayerRef.current;meshWireLayerRef.current=null;streamed?.dispose();
    if (meshGroupRef.current && scene) {
      scene.remove(meshGroupRef.current);
      if(meshGroupRef.current!==streamed?.group)disposeObject(meshGroupRef.current);
    }
    meshGroupRef.current = null;
    if (mountRef.current) mountRef.current.dataset.renderedMeshGroups = "0";
  }, []);

  const removePreparationGroup=useCallback(()=>{
    invalidateViewportRef.current();
    if(preparationGroupRef.current){sceneRef.current?.remove(preparationGroupRef.current);disposeObject(preparationGroupRef.current);preparationGroupRef.current=null;}
    if(modelGroupRef.current)modelGroupRef.current.visible=true;
    if(meshGroupRef.current)meshGroupRef.current.visible=true;
    if(mountRef.current){mountRef.current.dataset.preparationPreviewState="hidden";mountRef.current.dataset.renderedPreparationTriangles="0";}
  },[]);
  const renderPreparationPreview=useCallback(()=>{
    removePreparationGroup();const selected=preparationDisplayRef.current,scene=sceneRef.current;
    if(!selected||!scene||!selected.preparation.preview)return null;
    const id=modelingController.getSnapshot().documentId;
    const visibilityChanged=modelRef.current?.bodyMetadata?.some(body=>preparationVisibilityRef.current.get(body.bodyId)!==(body.visible!==false));
    if(selected.meshJob.documentId!==id||assessMeshSource(selected.meshJob.source,modelRef.current,id).status!=="current"||visibilityChanged){preparationDisplayRef.current=null;setPreparationDisplay(null);return null;}
    let group:THREE.Group|null;try{group=createPreparationPreview(selected.preparation.preview);}catch(reason){if(!isViewportCoordinateError(reason))throw reason;setError(reason.message);return null;}if(!group)return null;
    scene.add(group);preparationGroupRef.current=group;
    if(modelGroupRef.current)modelGroupRef.current.visible=false;
    if(meshGroupRef.current)meshGroupRef.current.visible=false;
    if(mountRef.current){mountRef.current.dataset.preparationPreviewState="visible";mountRef.current.dataset.renderedPreparationTriangles=String(selected.preparation.preview.positions.length/9);}
    return group;
  },[removePreparationGroup]);
  const removeQualityGroup = useCallback(() => {
    invalidateViewportRef.current();
    if(qualityGroupRef.current){sceneRef.current?.remove(qualityGroupRef.current);disposeObject(qualityGroupRef.current);}
    qualityGroupRef.current=null;
    if(mountRef.current)mountRef.current.dataset.highlightedQualityElements="0";
    if(mountRef.current)mountRef.current.dataset.highlightedQualityFaces="0";
    if(mountRef.current)mountRef.current.dataset.highlightedQualityPeers="0";
  },[]);
  const renderQualitySelection = useCallback(() => {
    removeQualityGroup();const selection=qualitySelectionRef.current,scene=sceneRef.current;
    if(!selection||!scene||selection.jobId!==meshResultsRef.current.at(-1)?.meshJob.jobId)return null;
    const documentId=modelingController.getSnapshot().documentId;
    if(selection.documentId!==documentId||assessMeshDisplaySource(meshResultsRef.current.at(-1)!,modelRef.current,documentId).status!=="current")return null;
    if(!diagnosticCellsVisible(selection,(modelRef.current?.bodyMetadata||[]).filter(body=>body.visible!==false).map(body=>body.bodyId)))return null;
    const group=createMeshDiagnosticHighlight(selection);
    if(group){scene.add(group);qualityGroupRef.current=group;if(mountRef.current){mountRef.current.dataset.highlightedQualityElements=selection.spatial?'2':'1';mountRef.current.dataset.highlightedQualityFaces=group.getObjectByName('mesh-topology-common-face')?'1':'0';mountRef.current.dataset.highlightedQualityPeers=selection.spatial?'1':'0';}}
    return group;
  },[removeQualityGroup]);
  const handleLocateQuality = useCallback((selection:MeshQualitySelection|null) => {
    if(selection) {
      const documentId=modelingController.getSnapshot().documentId;
      const problem=diagnosticSelectionProblem(selection);if(problem){setError(problem+'，未执行定位。');return;}
      if(selection.documentId!==documentId||selection.jobId!==meshResultsRef.current.at(-1)?.meshJob.jobId||assessMeshDisplaySource(meshResultsRef.current.at(-1)!,modelRef.current,documentId).status!=="current") {setError("网格来源已变化，不能定位到当前工程。");return;}
    }
    if(selection){preparationDisplayRef.current=null;setPreparationDisplay(null);removePreparationGroup();clearHighlight();}
    qualitySelectionRef.current=selection;setQualitySelection(selection);
    const group=renderQualitySelection();if(group)fitCamera(group);
  },[fitCamera,renderQualitySelection,clearHighlight,removePreparationGroup]);
  const handlePreparationPreview=useCallback((value:MeshPreparationResult|null)=>{
    if(value){const id=modelingController.getSnapshot().documentId;if(value.meshJob.documentId!==id||assessMeshSource(value.meshJob.source,modelRef.current,id).status!=="current"){setError("预览来源已变化，请重新诊断。");return;}clearHighlight();handleLocateQuality(null);preparationVisibilityRef.current=new Map((modelRef.current?.bodyMetadata||[]).map(body=>[body.bodyId,body.visible!==false]));}
    preparationDisplayRef.current=value;setPreparationDisplay(value);renderPreparationPreview();
  },[clearHighlight,handleLocateQuality,renderPreparationPreview]);
  const resetRenderedModel = useCallback(() => {
    preparationDisplayRef.current=null;setPreparationDisplay(null);removePreparationGroup();
    qualitySelectionRef.current=null;setQualitySelection(null);removeQualityGroup();
    cancelDragRef.current();
    clearHighlight();
    bodySelectionAnchorRef.current=null;
    fullRenderLoadRef.current=null;
    meshGroupVisibilityRef.current.clear();
    for(const entry of meshBodyLoadsRef.current.values())entry.controller.abort();meshBodyLoadsRef.current.clear();setPendingMeshBodies({});
    setAssemblyProgress(null);
    const camera=cameraRef.current,controls=controlsRef.current;
    if(camera && controls){camera.position.set(260,-320,240);camera.up.set(0,0,1);camera.near=.1;camera.far=10000;camera.updateProjectionMatrix();controls.target.set(0,0,0);controls.update();viewportCameraRef.current=null;}
    const scene = sceneRef.current;
    if (modelGroupRef.current && scene) {
      scene.remove(modelGroupRef.current);
      disposeObject(modelGroupRef.current);
    }
    modelGroupRef.current = null;
    removeMeshGroup();
    bodyMeshesRef.current = [];
    edgeLinesRef.current = [];
    meshResultsRef.current = [];
    setMeshResults([]);
    setMeshGroupVisibility({});
    bodyPresentationLoadsRef.current.clear();
    assemblyPreviewLoadRef.current = null;
    modelRef.current = null;
    modelGenerationRef.current += 1;
  }, [clearHighlight, removeMeshGroup, removeQualityGroup,removePreparationGroup]);
  const renderMeshResults = useCallback((results: MeshJobPayload[]) => {
    const scene = sceneRef.current;
    if (!scene) return;
    invalidateViewportRef.current();
    const latest=results.at(-1),chunked=latest?.mesh.render;
    if(latest&&chunked?.storage){
      if(!meshWireLayerRef.current){removeMeshGroup();const layer=new MeshWireLayer({apiRoot:API_ROOT,onUpdate:state=>{
        invalidateViewportRef.current();
        if(!mountRef.current)return;mountRef.current.dataset.renderedMeshGroups=String(state.visibleChunks);mountRef.current.dataset.meshResidentBytes=String(state.residentBytes);mountRef.current.dataset.meshLoadedChunks=String(state.loadedChunks);mountRef.current.dataset.meshWantedChunks=String(state.wantedChunks);
        if(!state.error&&meshWireErrorRef.current){const previous=meshWireErrorRef.current;meshWireErrorRef.current='';setError(current=>current===previous?null:current);}
        const phase=state.wantedChunks?`${state.loadedChunks===state.wantedChunks?'ready':Math.floor(state.loadedChunks/state.wantedChunks*10)}:${state.wantedChunks}`:'hidden';
        if(phase!==meshWireProgressRef.current){const previous=meshWireProgressRef.current;meshWireProgressRef.current=phase;if(state.wantedChunks&&!state.error)setStatus(state.loadedChunks===state.wantedChunks?`网格显示已就绪 · ${state.loadedChunks} 块`:`网格按需载入 · ${Math.floor(state.loadedChunks/state.wantedChunks*100)}% · ${state.loadedChunks}/${state.wantedChunks} 块`);else if(previous&&phase==='hidden'&&!state.error)setStatus('网格当前隐藏。');}
      },onError:message=>{meshWireErrorRef.current=message;setError(message);setStatus('网格显示未完成，请检查结果或减少同时显示的 Body。');}});meshWireLayerRef.current=layer;meshGroupRef.current=layer.group;scene.add(layer.group);}
      const layer=meshWireLayerRef.current,visibleBodies=new Set((modelRef.current?.bodyMetadata||[]).filter(body=>body.visible!==false).map(body=>body.bodyId));
      const allowed=(latest.meshJob.requestedVisible??latest.meshJob.visible)&&meshAdmitted(latest.mesh.admission)&&assessMeshDisplaySource(latest,modelRef.current,modelingController.getSnapshot().documentId).status==='current';
      const roots=bodyMeshRootGroupIds(latest),keys=new Set<string>();if(allowed)for(const entry of chunked.groups?.flatMap(group=>[group,...(group.faces||[])])||[]){const visible=visibleBodies.has(entry.bodyId)&&(meshGroupVisibilityRef.current.get(entry.groupId)??roots.has(entry.groupId));if(visible&&entry.wireKey)keys.add(entry.wireKey);}
      layer.group.visible=!preparationGroupRef.current;
      try{layer.update({jobId:latest.meshJob.jobId,documentId:latest.meshJob.documentId,render:chunked,visibleKeys:[...keys]});}catch(reason){setError(reason instanceof Error?reason.message:'网格显示清单无效。');removeMeshGroup();}
      return;
    }
    removeMeshGroup();
    const group = new THREE.Group();
    group.name = "mesh-results";
    const bodyMetadata = modelRef.current?.bodyMetadata || [];
    const visibleBodyIds = new Set(bodyMetadata.filter((body) => body.visible !== false).map((body) => body.bodyId));
    results.slice(-1).filter((item) => {
      if (!(item.meshJob.requestedVisible ?? item.meshJob.visible) || !item.mesh.render || !meshAdmitted(item.mesh.admission)) return false;
      if (assessMeshDisplaySource(item, modelRef.current, modelingController.getSnapshot().documentId).status !== "current") return false;
      if (item.meshJob.selection.kind === "body" || item.meshJob.selection.kind === "face") return visibleBodyIds.has(item.meshJob.selection.bodyId || "");
      return visibleBodyIds.size > 0;
    }).forEach((item) => {
      const render = item.mesh.render;
      if (!render) return;
      if (render.kind === "surface" && render.positions.length > 0 && render.indices?.length) {
        const geometry = new THREE.BufferGeometry();
        const origin=setViewportPositions(geometry,render.positions);
        geometry.setIndex(render.indices);
        geometry.computeVertexNormals();
        const material = new THREE.MeshBasicMaterial({ color: 0x48c8e8, wireframe: true, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material);
        placeViewportObject(mesh,origin);
        mesh.renderOrder = 5;
        group.add(mesh);
      } else if (render.kind === "wire") {
        const groups = render.groups?.flatMap((solid) => [solid, ...(solid.faces || [])]) || [],roots=bodyMeshRootGroupIds(item);
        const drawn = new Set<string>();
        const renderWire = (wirePositions: number[], entityKey?: string) => {
          if (entityKey && drawn.has(entityKey)) return;
          if (!wirePositions.length) return;
          if (entityKey) drawn.add(entityKey);
          const geometry = new THREE.BufferGeometry();
          const origin=setViewportPositions(geometry,wirePositions);
          const material = new THREE.LineBasicMaterial({ color: 0x48c8e8, transparent: true, opacity: 0.82, depthWrite: false });
          const lines = new THREE.LineSegments(geometry, material);
          placeViewportObject(lines,origin);
          lines.renderOrder = 5;
          group.add(lines);
        };
        if (groups.length > 0) {
          groups.forEach((meshGroup) => {
            const bodyVisible = visibleBodyIds.has(meshGroup.bodyId);
            const defaultVisible = roots.has(meshGroup.groupId);
            const visible = bodyVisible && (meshGroupVisibilityRef.current.get(meshGroup.groupId) ?? defaultVisible);
            if (visible) renderWire(meshGroup.wirePositions||[], meshGroup.kind === "solid" ? meshGroup.solidId : meshGroup.faceId);
          });
        } else if (render.wirePositions?.length) {
          renderWire(render.wirePositions);
        }     }
    });
    if (group.children.length > 0) {
      if(preparationGroupRef.current)group.visible=false;
      scene.add(group);
      meshGroupRef.current = group;
    }
    if (mountRef.current) mountRef.current.dataset.renderedMeshGroups = String(group.children.length);
  }, [removeMeshGroup]);

  const handleMeshResult = useCallback((payload: MeshJobPayload) => {
    if (payload.meshJob.documentId !== modelingController.getSnapshot().documentId) return;
    const selectionChanged = meshResultsRef.current.at(-1)?.meshJob.jobId !== payload.meshJob.jobId;
    if(selectionChanged||!(payload.meshJob.requestedVisible??payload.meshJob.visible)){for(const entry of meshBodyLoadsRef.current.values())entry.controller.abort();meshBodyLoadsRef.current.clear();setPendingMeshBodies({});}
    if (selectionChanged||!meshAdmitted(payload.mesh.admission)) { meshGroupVisibilityRef.current.clear(); setMeshGroupVisibility({});qualitySelectionRef.current=null;setQualitySelection(null);removeQualityGroup(); }
    // Historical arrays live on disk. Keep only the selected result in browser memory.
    const next = [payload];
    meshResultsRef.current = next;
    setMeshResults(next);
    renderMeshResults(next);
  }, [renderMeshResults,removeQualityGroup]);
  const meshTasks = useProjectMeshJobs(controllerState.documentId, handleMeshResult);
  useEffect(() => {
    const latest=meshResultsRef.current.at(-1);if(latest&&assessMeshDisplaySource(latest,model,controllerState.documentId).status!=='current'){for(const entry of meshBodyLoadsRef.current.values())entry.controller.abort();meshBodyLoadsRef.current.clear();setPendingMeshBodies({});}
    renderMeshResults(meshResultsRef.current);
    renderQualitySelection();
    renderPreparationPreview();
    renderPropertySelection();
  }, [model,controllerState.documentId, renderMeshResults,renderQualitySelection,renderPreparationPreview,renderPropertySelection]);
  const meshBodyVisibility: Record<string, boolean> = {};
  meshResults.slice(-1).forEach((result) => {
    if(!meshAdmitted(result.mesh.admission))return;
    if (assessMeshDisplaySource(result, model, controllerState.documentId).status !== "current") return;
    const roots=bodyMeshRootGroupIds(result);
    result.mesh.render?.groups?.forEach((meshGroup) => {
      if (roots.has(meshGroup.groupId)) {
        const visible = (result.meshJob.requestedVisible ?? result.meshJob.visible) && (meshGroupVisibility[meshGroup.groupId] ?? true);
        meshBodyVisibility[meshGroup.bodyId] = (meshBodyVisibility[meshGroup.bodyId] ?? false) || visible;
      }
    });
  });
  for(const bodyId of Object.keys(pendingMeshBodies))if(bodyId in meshBodyVisibility)meshBodyVisibility[bodyId]=true;
  const handleMeshBodyVisibility = useCallback(async (bodyId: string, visible: boolean) => {
    const documentId=modelingController.getSnapshot().documentId,result=meshResultsRef.current.at(-1);
    const previous=meshBodyLoadsRef.current.get(bodyId);previous?.controller.abort();meshBodyLoadsRef.current.delete(bodyId);
    setPendingMeshBodies(current=>{const next={...current};delete next[bodyId];return next;});
    if(!result||assessMeshDisplaySource(result,modelRef.current,documentId).status!=='current')return;
    const entry={controller:new AbortController(),jobId:result.meshJob.jobId,documentId};
    const apply=(descriptor?:MeshJobPayload['meshJob'])=>{
      const latest=meshResultsRef.current.at(-1);if(!latest||latest.meshJob.jobId!==entry.jobId||modelingController.getSnapshot().documentId!==documentId||assessMeshDisplaySource(latest,modelRef.current,documentId).status!=='current')return;
      const next=Object.fromEntries(meshGroupVisibilityRef.current);
      if(visible&&!(latest.meshJob.requestedVisible??latest.meshJob.visible))latest.mesh.render?.groups?.forEach(group=>{next[group.groupId]=false;group.faces?.forEach(face=>{next[face.groupId]=false;});});
      const roots=bodyMeshRootGroupIds(latest),visit=(group:MeshRenderGroup)=>{if(group.bodyId!==bodyId)return;next[group.groupId]=roots.has(group.groupId)?visible:visible?(next[group.groupId]??false):false;group.faces?.forEach(visit);};latest.mesh.render?.groups?.forEach(visit);
      const results=[{...latest,meshJob:descriptor||latest.meshJob}];meshGroupVisibilityRef.current=new Map(Object.entries(next));setMeshGroupVisibility(next);meshResultsRef.current=results;setMeshResults(results);renderMeshResults(results);return true;
    };
    if(!visible){apply();if(meshBodyLoadsRef.current.size)setStatus('正在校验其他 Body 的网格显示，可再次点击其按钮取消。');else if(previous)setStatus('已取消该 Body 的网格显示校验。');return;}
    meshBodyLoadsRef.current.set(bodyId,entry);setPendingMeshBodies(current=>({...current,[bodyId]:true}));setStatus('正在校验网格显示数据，可再次点击该网格按钮取消。');
    let applied=false;
    try{const response=await fetch(`${API_ROOT}/mesh/jobs/${encodeURIComponent(entry.jobId)}/visibility`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visible:true}),signal:entry.controller.signal}),payload=await response.json() as {ok:boolean;meshJob?:MeshJobPayload['meshJob'];error?:string};
      if(meshBodyLoadsRef.current.get(bodyId)!==entry||entry.controller.signal.aborted)return;
      if(!response.ok||!payload.ok||!payload.meshJob)throw Error(payload.error||'网格显示更新失败');
      applied=Boolean(apply(payload.meshJob));
    }catch(reason){if(meshBodyLoadsRef.current.get(bodyId)===entry&&!entry.controller.signal.aborted){setError(reason instanceof Error?reason.message:'网格显示更新失败');setStatus('网格显示校验未完成，请检查结果后重试。');}}
    finally{if(meshBodyLoadsRef.current.get(bodyId)===entry){meshBodyLoadsRef.current.delete(bodyId);setPendingMeshBodies(current=>{const next={...current};delete next[bodyId];return next;});if(applied&&!meshBodyLoadsRef.current.size){const state=meshWireLayerRef.current?.status();if(state&&!state.error&&state.loadedChunks===state.wantedChunks)setStatus(state.wantedChunks?`网格显示已就绪 · ${state.loadedChunks} 块`:'网格当前隐藏。');else if(!state)setStatus('网格显示已更新。');}}}
  }, [renderMeshResults]);
  const renderModel = useCallback(
    (data: ModelData, options: { fitCamera?: boolean; notify?: boolean } = {}) => {
      if("documentId" in data && data.documentId && data.documentId!==modelingController.getSnapshot().documentId)return;
      if(!modelingController.adoptModel(data, data.revision))return;
      const scene = sceneRef.current;
      if (!scene) return;
      const notify = options.notify !== false;
      let pendingGroup:THREE.Group|null=null;
      try{

      if (data.bodyMetadata) {
        const liveBodyIds = new Set(data.bodyMetadata.map((body) => body.bodyId));
        const selection = modelingController.getSnapshot().selection;
        if (selectedBodyIdsRef.current.some((bodyId) => !liveBodyIds.has(bodyId)) || (selection && !liveBodyIds.has(selection.bodyId))) {
          applyBodySelection(selectedBodyIdsRef.current.filter((bodyId) => liveBodyIds.has(bodyId)));
          if (selection && !liveBodyIds.has(selection.bodyId)) modelingController.setSelection(null);
        }
      }

      if (data.bodyCount === 0) {
        clearHighlight();
        if (modelGroupRef.current) {
          scene.remove(modelGroupRef.current);
          disposeObject(modelGroupRef.current);
          modelGroupRef.current = null;
        }
        bodyMeshesRef.current = [];
        edgeLinesRef.current = [];
        modelRef.current = data;
        renderPreparationPreview();
        if(mountRef.current)mountRef.current.dataset.viewportCoordinates='ready';
        if (notify) setModel(data);
        return;
      }

      const presentations = data.bodyPresentations?.length
        ? data.bodyPresentations
        : Array.isArray(data.positions) ? [data] : [];
      if (presentations.length === 0) {
        modelRef.current = data;
        if (notify) setModel(data);
        return;
      }

      const bodyMetadata = new Map((data.bodyMetadata || []).map((body) => [body.bodyId, body]));
      const makeGeometry = (presentation: BodyPresentation) => {
        const geometry = new THREE.BufferGeometry();
        setViewportPositions(geometry,presentation.positions);
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(presentation.normals, 3));
        geometry.setIndex(presentation.indices);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return geometry;
      };
      const applyBodyMetadata = (mesh: THREE.Mesh, presentation: BodyPresentation) => {
        placeViewportObject(mesh,mesh.geometry.userData.viewportOrigin||[0,0,0]);
        const metadata = bodyMetadata.get(presentation.bodyId);
        const material = mesh.material as THREE.MeshStandardMaterial;
        const color = metadata?.color || defaultBodyColor;
        const baseColor = new THREE.Color(color).getHex();
        const isSelected = selectedBodyIdsRef.current.includes(presentation.bodyId);
        material.color.setHex(isSelected ? bodySelectionColor : baseColor);
        material.emissive.setHex(0x000000);
        const opacity = Math.max(0.05, Math.min(1, Number(metadata?.opacity ?? 1)));
        material.transparent = opacity < 0.999;
        material.opacity = opacity;
        material.depthWrite = opacity >= 0.999;
        material.needsUpdate = true;
        mesh.visible = metadata?.visible !== false;
        mesh.userData.bodyId = presentation.bodyId;
        mesh.userData.topologyIdentity = metadata?.topologyIdentity;
        mesh.userData.kind = "body";
        mesh.userData.baseColor = baseColor;
        mesh.userData.presentation = presentation;
        mesh.userData.viewportWireFallback = !presentation.edges.length;
        setBodyDisplay(mesh, displayModeRef.current);
      };
      const addEdges = (group: THREE.Group, presentation: BodyPresentation, visible: boolean, edgeLines: THREE.Line[]) => {
        presentation.edges.forEach((edge) => {
          const edgeGeometry = new THREE.BufferGeometry();
          const origin=setViewportPositions(edgeGeometry,edge.points);
          const line = new THREE.Line(edgeGeometry, new THREE.LineBasicMaterial({ color: defaultEdgeColor }));
          line.layers.set(edgeLayer);
          placeViewportObject(line,origin);
          line.userData.edgeId = edge.edgeId;
          line.userData.bodyId = presentation.bodyId;
          line.userData.kind = "edge";
          line.visible = visible;
          line.renderOrder = 1;
          group.add(line);
          edgeLines.push(line);
        });
      };
      const addPresentation = (group: THREE.Group, presentation: BodyPresentation, bodyMeshes: THREE.Mesh[], edgeLines: THREE.Line[]) => {
        const metadata = bodyMetadata.get(presentation.bodyId);
        const geometry=makeGeometry(presentation);
        const bodyMaterial = new THREE.MeshStandardMaterial({
          color: metadata?.color || defaultBodyColor,
          roughness: 0.72,
          metalness: 0.02,
          side: THREE.DoubleSide,
          transparent: Number(metadata?.opacity ?? 1) < 0.999,
          opacity: Math.max(0.05, Math.min(1, Number(metadata?.opacity ?? 1))),
          depthWrite: Number(metadata?.opacity ?? 1) >= 0.999,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        const bodyMesh = new THREE.Mesh(geometry, bodyMaterial);
        bodyMesh.layers.set(bodyLayer);
        applyBodyMetadata(bodyMesh, presentation);
        bodyMesh.castShadow = false;
        bodyMesh.receiveShadow = false;
        group.add(bodyMesh);
        bodyMeshes.push(bodyMesh);
        addEdges(group, presentation, bodyMesh.visible, edgeLines);
      };
      const removeEdgesForBody = (group: THREE.Group, bodyId: string, edgeLines: THREE.Line[]) => {
        const kept: THREE.Line[] = [];
        edgeLines.forEach((line) => {
          if (line.userData.bodyId === bodyId) {
            group.remove(line);
            disposeObject(line);
          } else {
            kept.push(line);
          }
        });
        return kept;
      };

      const existingGroup = modelGroupRef.current;
      const existingPresentations = modelRef.current?.bodyPresentations || [];
      if (existingGroup && existingPresentations.length > 0 && data.bodyPresentations?.length) {
        const desiredIds = new Set(presentations.map((presentation) => presentation.bodyId));
        const bodyMeshes = pruneBodyRenderables(existingGroup, bodyMeshesRef.current, desiredIds, disposeObject);
        let edgeLines = pruneBodyRenderables(existingGroup, edgeLinesRef.current, desiredIds, disposeObject);

        const meshByBodyId = new Map(bodyMeshes.map((mesh) => [String(mesh.userData.bodyId), mesh]));
        presentations.forEach((presentation) => {
          const mesh = meshByBodyId.get(presentation.bodyId);
          if (!mesh) {
            addPresentation(existingGroup, presentation, bodyMeshes, edgeLines);
            return;
          }
          const previous = mesh.userData.presentation as BodyPresentation | undefined;
          const topologyChanged = !previous
            || mesh.userData.topologyIdentity !== bodyMetadata.get(presentation.bodyId)?.topologyIdentity
            || previous.presentationQuality !== presentation.presentationQuality
            || previous.topologyRevision !== presentation.topologyRevision
            || previous.positions.length !== presentation.positions.length
            || previous.indices.length !== presentation.indices.length;
          const edgesChanged = topologyChanged || previous?.edges.length !== presentation.edges.length;
          if (topologyChanged) {
            const replacement=makeGeometry(presentation),previousGeometry=mesh.geometry;mesh.geometry=replacement;previousGeometry.dispose();
          }
          applyBodyMetadata(mesh, presentation);
          if (edgesChanged) {
            edgeLines = removeEdgesForBody(existingGroup, presentation.bodyId, edgeLines);
            addEdges(existingGroup, presentation, mesh.visible, edgeLines);
          }
          edgeLines.forEach((line) => {
            if (line.userData.bodyId === presentation.bodyId) line.visible = mesh.visible;
          });
        });

        bodyMeshesRef.current = bodyMeshes;
        edgeLinesRef.current = edgeLines;
        modelRef.current = data;
        if (options.fitCamera !== false) fitCamera(existingGroup);else updateOrbitLimits(existingGroup);
        if(mountRef.current)mountRef.current.dataset.viewportCoordinates='ready';
        if (notify) setModel(data);
        return;
      }

      clearHighlight();
      if (modelGroupRef.current) {
        scene.remove(modelGroupRef.current);
        disposeObject(modelGroupRef.current);
        modelGroupRef.current = null;
      }
      bodyMeshesRef.current = [];
      edgeLinesRef.current = [];

      const group = new THREE.Group();
      pendingGroup=group;
      group.name = "occt-model";
      const bodyMeshes: THREE.Mesh[] = [];
      const edgeLines: THREE.Line[] = [];
      presentations.forEach((presentation) => addPresentation(group, presentation, bodyMeshes, edgeLines));
      scene.add(group);
      modelGroupRef.current = group;
      pendingGroup=null;
      bodyMeshesRef.current = bodyMeshes;
      edgeLinesRef.current = edgeLines;
      if (options.fitCamera !== false) fitCamera(group);else updateOrbitLimits(group);
      modelRef.current = data;
      renderPreparationPreview();
      if (notify) setModel(data);
      if(mountRef.current)mountRef.current.dataset.viewportCoordinates='ready';
      }catch(reason){
        if(pendingGroup)disposeObject(pendingGroup);
        if(!isViewportCoordinateError(reason))throw reason;
        clearHighlight();if(modelGroupRef.current){scene.remove(modelGroupRef.current);disposeObject(modelGroupRef.current);}modelGroupRef.current=null;bodyMeshesRef.current=[];edgeLinesRef.current=[];modelRef.current=data;
        if(notify)setModel(data);if(mountRef.current)mountRef.current.dataset.viewportCoordinates='failed';setError(reason.message);setStatus('工程数据已保留，几何显示未完成；没有使用旧几何替代。');
      }finally{invalidateViewportRef.current();}
    },
    [applyBodySelection, clearHighlight, fitCamera,updateOrbitLimits,renderPreparationPreview],
  );

  const ensureBodyPresentation = useCallback(async (bodyId: string, fitCameraAfterLoad = true, notifyAfterLoad = true) => {
    const current = modelRef.current;
    if (!current) return;
    const existingPresentation = current.bodyPresentations?.find((presentation) => presentation.bodyId === bodyId);
    if (existingPresentation && existingPresentation.presentationQuality !== "preview") return;
    const existing = bodyPresentationLoadsRef.current.get(bodyId);
    if (existing) return existing;

    const generation = modelGenerationRef.current;
    const owner = modelingController.getSnapshot();
    const load = modelingController.loadBodyPresentation<BodyPresentation & ModelingCommandResponse>(bodyId).then((presentation) => {
      const active = modelingController.getSnapshot();
      if (generation !== modelGenerationRef.current || owner.documentId !== active.documentId || owner.stateToken !== active.stateToken) return;
      const latest = modelRef.current || current;
      const presentations = [
        ...(latest.bodyPresentations || []).filter((item) => item.bodyId !== bodyId),
        presentation,
      ];
      renderModel({
        ...latest,
        ...((latest.bodyId === bodyId || !latest.bodyId) ? {
          positions: presentation.positions, normals: presentation.normals, indices: presentation.indices,
          triangleFaceIds: presentation.triangleFaceIds, edges: presentation.edges, topologyRevision: presentation.topologyRevision,
          stats: presentation.stats, presentationQuality: presentation.presentationQuality,
        } : {}),
        bodyId: latest.bodyId || presentation.bodyId,
        activeBodyId: latest.activeBodyId || latest.bodyId || presentation.bodyId,
        bodyMetadata: latest.bodyMetadata,
        bodyPresentations: presentations,
      }, { fitCamera: fitCameraAfterLoad, notify: notifyAfterLoad });
    }).finally(() => {
      if (generation === modelGenerationRef.current) bodyPresentationLoadsRef.current.delete(bodyId);
    });
    bodyPresentationLoadsRef.current.set(bodyId, load);
    return load;
    }, [renderModel]);

  const ensureAssemblyPreview = useCallback(async (data: ModelData) => {
    if (data.bodyPresentations?.length) return;
    const existing = assemblyPreviewLoadRef.current;
    if (existing) return existing;

    const chunkSize = 16;
    const generation = modelGenerationRef.current;
    const load = (async () => {
      let loaded = 0;
      const total = data.bodyCount;
      let presentations: BodyPresentation[] = [];
      setAssemblyProgress(0);
      setStatus("正在加载装配体 0/" + total + "（0%）");
      for (let offset = 0; offset < total; offset += chunkSize) {
        const preview = await modelingController.loadAssemblyPreview<ModelData & { previewCount?: number; previewTotal?: number }>(offset, chunkSize);
        if (generation !== modelGenerationRef.current) return;
        const latest = modelRef.current || data;
        // Do not let a long-running preview overwrite a newer modeling revision.
        if (typeof preview.revision === "number" && preview.revision !== latest.revision) return;
        const chunk = (preview.bodyPresentations || []).map((presentation) => ({
          ...presentation,
          presentationQuality: "preview" as const,
        }));
        presentations = [...presentations, ...chunk];
        const nextLoaded = Math.min(total, offset + chunk.length);
        const progress = total > 0 ? Math.round((nextLoaded / total) * 100) : 100;
        setAssemblyProgress(progress);
        setStatus("正在加载装配体 " + nextLoaded + "/" + total + "（" + progress + "%）…");
        renderModel({
          ...latest,
          ...preview,
          bodyPresentations: presentations,
          presentationMode: "preview",
          bodyMetadata: latest.bodyMetadata || preview.bodyMetadata,
        }, { fitCamera: offset === 0, notify: true });
        loaded = nextLoaded;
        if (chunk.length === 0) break;
      }
      setAssemblyProgress(null);
      setStatus("装配体加载完成 · " + loaded + "/" + total + " 个 Body");
    })().finally(() => {
      if (generation === modelGenerationRef.current) {
        assemblyPreviewLoadRef.current = null;
        setAssemblyProgress(null);
      }
    });
    assemblyPreviewLoadRef.current = load;
    return load;
  }, [renderModel]);

  const renderAllBodies = useCallback(async (fit = true) => {
    const existing = fullRenderLoadRef.current;
    if (existing) return existing;
    const current = modelRef.current;
    const bodyIds = (current?.bodyMetadata || current?.bodyPresentations || []).map((body) => body.bodyId);
    if (!current || bodyIds.length === 0) return;

    modelGenerationRef.current += 1;
    const generation = modelGenerationRef.current;
    assemblyPreviewLoadRef.current = null;
    bodyPresentationLoadsRef.current.clear();
    const load = (async () => {
      setBusy(true);
      setAssemblyProgress(0);
      setStatus("正在全量渲染 0/" + bodyIds.length + "（0%）");
      const concurrency = 4;
      let completed = 0;
      for (let offset = 0; offset < bodyIds.length; offset += concurrency) {
        if (generation !== modelGenerationRef.current) return;
        const batch = bodyIds.slice(offset, offset + concurrency);
        await Promise.all(batch.map((bodyId) => ensureBodyPresentation(bodyId, false, true)));
        completed += batch.length;
        const progress = Math.round((completed / bodyIds.length) * 100);
        setAssemblyProgress(progress);
        setStatus("正在全量渲染 " + completed + "/" + bodyIds.length + "（" + progress + "%）…");
      }
      if (generation === modelGenerationRef.current) {
        if (fit && modelGroupRef.current) fitCamera(modelGroupRef.current);
        setAssemblyProgress(null);
        setStatus("全量渲染完成 · " + bodyIds.length + " 个 Body");
      }
    })().catch((reason) => {
      if (generation === modelGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : "全量渲染失败。");
        setStatus("全量渲染未完成");
      }
    }).finally(() => {
      if (generation === modelGenerationRef.current) {
        fullRenderLoadRef.current = null;
        setBusy(false);
        setAssemblyProgress(null);
      }
    });
    fullRenderLoadRef.current = load;
    return load;
  }, [ensureBodyPresentation, fitCamera]);
  const edgeLoadAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (selectionMode !== "edge" || !model || assemblyProgress !== null) return;
    const previewOnly = model.bodyPresentations?.some(body => body.presentationQuality === "preview");
    if (!previewOnly) return;
    const key = `${controllerState.documentId}:${controllerState.stateToken}`;
    if (edgeLoadAttempt.current === key) return;
    edgeLoadAttempt.current = key;
    void renderAllBodies(false);
  }, [assemblyProgress, controllerState.documentId, controllerState.stateToken, model, renderAllBodies, selectionMode]);
  const displayModel = useCallback((incoming: ModelData, options: { replaceScene?: boolean; fitCamera?: boolean } = {}) => {
    if(!modelingController.acceptsState(incoming))return;
    if("documentId" in incoming && incoming.documentId && incoming.documentId!==modelingController.getSnapshot().documentId)return;
    if (options.replaceScene) resetRenderedModel();
    const cached = modelRef.current;
    let data = incoming;
    const incomingHasGeometry = Array.isArray(incoming.positions);
    const cachedPresentations = cached?.bodyPresentations || [];
    const liveBodyIds = incoming.bodyMetadata ? new Set(incoming.bodyMetadata.map((body) => body.bodyId)) : null;
    if (!incoming.bodyPresentations?.length && cachedPresentations.length > 0) {
      const merged = cachedPresentations
        .filter((item) => !liveBodyIds || liveBodyIds.has(item.bodyId))
        .filter((item) => !incomingHasGeometry || item.bodyId !== incoming.bodyId)
        .concat(incomingHasGeometry ? [incoming] : []);
      data = { ...cached, ...incoming, bodyPresentations: merged };
      if (!incomingHasGeometry) {
        const active = merged.find((item) => item.bodyId === (incoming.activeBodyId || incoming.bodyId)) || merged[0];
        if (active) data = { ...data, ...active, revision:incoming.revision, stateToken:incoming.stateToken,stateSequence:incoming.stateSequence,history:incoming.history, bodyMetadata: data.bodyMetadata, bodyPresentations: merged };
      }
    }
    if (!Array.isArray(data.positions) && !data.bodyPresentations?.length && data.bodyCount > 0) {
      modelRef.current = data;
      setModel(data);
      const bodyId = data.activeBodyId || data.bodyId || data.bodyMetadata?.find((body) => body.visible !== false)?.bodyId;
      void ensureAssemblyPreview(data).catch(() => {
        if (bodyId) void ensureBodyPresentation(bodyId);
      });
      return;
    }
    renderModel(data, { fitCamera: options.fitCamera });
  }, [ensureAssemblyPreview, ensureBodyPresentation, renderModel, resetRenderedModel]);

  // Controller responses may carry only project data. Refresh the visible
  // geometry before a tree action can acquire a newer token for older pixels.
  const stateViewRefreshRef=useRef<Promise<void>|null>(null);
  useEffect(()=>{
    if(controllerState.busy || !controllerState.stateToken || !modelRef.current || modelRef.current.stateToken===controllerState.stateToken || stateViewRefreshRef.current)return;
    // Pi already fetched document.view. Its controller state can reach React
    // before the caller renders that receipt; do not fetch the same view again.
    // Data-only commands still require the normal geometry refresh below.
    const receipt=controllerState.commandLog.find(entry=>entry.requestId===controllerState.lastRequestId);
    const observedView=controllerState.model as ModelData|null;
    if(receipt?.operation==='document.view'&&receipt.status==='success'&&receipt.documentId===controllerState.documentId
      &&observedView?.stateToken===controllerState.stateToken){
      displayModel(observedView,{fitCamera:false});return;
    }
    const documentId=controllerState.documentId;
    const refresh=modelingController.execute<ModelData>({operation:"document.view"}).then(result=>{if(modelingController.getSnapshot().documentId===documentId)displayModel(result,{fitCamera:false});}).catch(()=>undefined).finally(()=>{if(stateViewRefreshRef.current===refresh)stateViewRefreshRef.current=null;});
    stateViewRefreshRef.current=refresh;
  },[controllerState.busy,controllerState.documentId,controllerState.stateToken,controllerState.commandLog,controllerState.lastRequestId,controllerState.model,displayModel]);

  const selectFace = useCallback(
    (bodyMesh: THREE.Mesh, triangleIndex: number) => {
      const data = bodyMesh.userData.presentation as BodyPresentation | undefined;
      const group = modelGroupRef.current;
      if (!data || !group || bodyMesh.visible === false) return;
      const faceId = data.triangleFaceIds[triangleIndex];
      if (!faceId) return;

      clearHighlight();
      const selectedPositions: number[] = [];
      const selectedNormals: number[] = [];
      data.triangleFaceIds.forEach((candidate, index) => {
        if (candidate !== faceId) return;
        const offset = index * 9;
        selectedPositions.push(...data.positions.slice(offset, offset + 9));
        selectedNormals.push(...data.normals.slice(offset, offset + 9));
      });

      const geometry = new THREE.BufferGeometry();
      const origin=setViewportPositions(geometry,selectedPositions);
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(selectedNormals, 3));
      const material = new THREE.MeshStandardMaterial({
        color: selectionColor,
        emissive: selectionEmissive,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const highlight = new THREE.Mesh(geometry, material);
      placeViewportObject(highlight,origin);
      highlight.renderOrder = 3;
      group.add(highlight);
      faceHighlightRef.current = highlight;
      setSelectedBodyId(data.bodyId);
      setSelectedId(faceId);
    },
    [clearHighlight],
  );
  const findBodyAtPointer = useCallback((event: PointerEvent) => {
    if(preparationGroupRef.current)return null;
    const mount = mountRef.current;
    const camera = cameraRef.current;
    if (!mount || !camera || bodyMeshesRef.current.length === 0) return null;
    const rect = mount.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = viewportRaycaster(mouse,camera,rect.height,controlsRef.current?.target??new THREE.Vector3());
    const hit = pickViewportBody(raycaster,bodyMeshesRef.current,camera);
    return hit ? String(hit.object.userData.bodyId) : null;
  }, []);

  const selectBodiesInRectangle = useCallback((start: { x: number; y: number }, end: { x: number; y: number }) => {
    const mount = mountRef.current;
    const camera = cameraRef.current;
    if (!mount || !camera) return [];
    const viewport = mount.getBoundingClientRect();
    camera.updateMatrixWorld(true);
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    const selected: string[] = [];
    const corners = [
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
    ];
    bodyMeshesRef.current.filter((mesh) => mesh.visible).forEach((mesh) => {
      const bounds = new THREE.Box3().setFromObject(mesh);
      bounds.getCenter(corners[0]);
      const projected = corners.slice(0, 1).map((point) => point.clone().project(camera));
      const points = [
        new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
        new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
        new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
        new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
        new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
        new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
        new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
        new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
      ];
      const screenPoints = points.map((point) => point.project(camera));
      const inside = screenPoints.some((point) => {
        if(point.z < -1 || point.z > 1)return false;
        const x = viewport.left + (point.x + 1) * viewport.width / 2;
        const y = viewport.top + (1 - point.y) * viewport.height / 2;
        return x >= left && x <= right && y >= top && y <= bottom;
      });
      const center = projected[0];
      const centerX = viewport.left + (center.x + 1) * viewport.width / 2;
      const centerY = viewport.top + (1 - center.y) * viewport.height / 2;
      if (inside || (center.z>=-1&&center.z<=1&&centerX >= left && centerX <= right && centerY >= top && centerY <= bottom)) selected.push(String(mesh.userData.bodyId));
    });
    return selected;
  }, []);
  const handlePick = useCallback(
    (event: PointerEvent) => {
      if(preparationGroupRef.current)return;
      const mount = mountRef.current;
      const camera = cameraRef.current;
      if (!mount || !camera || bodyMeshesRef.current.length === 0 || !modelRef.current) return;

      const rect = mount.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = viewportRaycaster(mouse,camera,rect.height,controlsRef.current?.target??new THREE.Vector3());

      if (selectionModeRef.current === "edge") {
        const hit = pickViewportEdge(raycaster,edgeLinesRef.current,bodyMeshesRef.current,camera);
        if (!hit) {
          clearHighlight();
          return;
        }
        clearHighlight();
        const line = hit.object as THREE.Line;
        (line.material as THREE.LineBasicMaterial).color.setHex(selectionColor);
        line.renderOrder = 4;
        setSelectedBodyId(String(line.userData.bodyId));
        setSelectedId(String(line.userData.edgeId));
        return;
      }

      const hit = pickViewportBody(raycaster,bodyMeshesRef.current,camera);
      if (!hit) {
        clearHighlight();
        return;
      }
      const bodyMesh = hit.object as THREE.Mesh;
      const bodyId = String(bodyMesh.userData.bodyId);

      if (selectionModeRef.current === "body") {
        const additive = event.ctrlKey || event.metaKey;
        const current = selectedBodyIdsRef.current;
        const next = additive
          ? (current.includes(bodyId) ? current.filter((id) => id !== bodyId) : [...current, bodyId])
          : [bodyId];
        applyBodySelection(next);
      } else if (hit.faceIndex != null) {
        selectFace(bodyMesh, hit.faceIndex);
      }
    },
    [applyBodySelection, clearHighlight, selectFace],
  );
  const changeSelectionMode = useCallback((mode: SelectionMode) => {
    if (selectionModeRef.current === mode) return;
    selectionModeRef.current = mode;
    setSelectionMode(mode);
    clearHighlight();
  }, [clearHighlight]);

  const selectBodyFromTree = useCallback(async (bodyId: string) => {
    handlePreparationPreview(null);
    selectionModeRef.current = "body";
    setSelectionMode("body");
    bodySelectionAnchorRef.current = bodyId;
    applyBodySelection([bodyId]);
    const owner = modelRef.current?.documentId;
    try { await ensureBodyPresentation(bodyId, false); }
    catch (reason) {
      if (modelRef.current?.documentId === owner && selectedBodyIdsRef.current.includes(bodyId)) {
        setError(reason instanceof Error ? reason.message : "无法加载选中几何体。");
      }
    }
  }, [applyBodySelection, ensureBodyPresentation,handlePreparationPreview]);

  const selectBodiesFromTree = useCallback(async (bodyId: string, options: { additive?: boolean; range?: boolean } = {}) => {
    handlePreparationPreview(null);
    selectionModeRef.current = "body";
    setSelectionMode("body");
    const allBodyIds = (modelRef.current?.bodyMetadata || []).map((body) => body.bodyId).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const anchor = bodySelectionAnchorRef.current;
    let next: string[];
    if (options.range && anchor && allBodyIds.includes(anchor)) {
      const start = allBodyIds.indexOf(anchor);
      const end = allBodyIds.indexOf(bodyId);
      const range = allBodyIds.slice(Math.min(start, end), Math.max(start, end) + 1);
      next = options.additive ? [...new Set([...selectedBodyIdsRef.current, ...range])] : range;
    } else if (options.additive) {
      next = selectedBodyIdsRef.current.includes(bodyId)
        ? selectedBodyIdsRef.current.filter((id) => id !== bodyId)
        : [...selectedBodyIdsRef.current, bodyId];
    } else {
      next = [bodyId];
    }
    bodySelectionAnchorRef.current = bodyId;
    applyBodySelection(next);
    const nextSelection = selectedBodyIdsRef.current;
    const owner = modelRef.current?.documentId;
    try { await Promise.all(next.map((id) => ensureBodyPresentation(id, false))); }
    catch (reason) {
      if (modelRef.current?.documentId === owner && selectedBodyIdsRef.current === nextSelection) {
        setError(reason instanceof Error ? reason.message : "无法加载选中几何体。");
      }
    }
  }, [applyBodySelection, ensureBodyPresentation,handlePreparationPreview]);

  const selectTargetFromProperty = useCallback((target: { kind: SelectionMode; bodyId: string; topologyId?: string } | null) => {
    if (!target) return;
    handlePreparationPreview(null);
    if (target.kind === "body") { selectBodyFromTree(target.bodyId); return; }
    selectionModeRef.current = target.kind;
    setSelectionMode(target.kind);
    clearHighlight();
    if (target.kind === "edge") {
      const line = edgeLinesRef.current.find((candidate) => candidate.visible && candidate.userData.bodyId === target.bodyId && candidate.userData.edgeId === target.topologyId);
      if (line) { (line.material as THREE.LineBasicMaterial).color.setHex(selectionColor); line.renderOrder = 4; }
      setSelectedBodyId(target.bodyId); setSelectedId(target.topologyId || null); return;
    }
    const mesh = bodyMeshesRef.current.find((candidate) => candidate.visible && candidate.userData.bodyId === target.bodyId);
    const presentation = mesh?.userData.presentation as BodyPresentation | undefined;
    const triangleIndex = presentation?.triangleFaceIds.findIndex((faceId) => faceId === target.topologyId) ?? -1;
    if (mesh && triangleIndex >= 0) selectFace(mesh, triangleIndex);
    else { setSelectedBodyId(target.bodyId); setSelectedId(target.topologyId || null); }
  }, [clearHighlight, selectBodyFromTree, selectFace,handlePreparationPreview]);
  const selectTargetsFromProperty=useCallback(async(targets:NonNullable<PropertyTarget>[])=>{
    if(!targets.length){clearHighlight();return;}
    const epoch=++propertyHighlightEpoch.current,owner=modelingController.getSnapshot(),data=modelRef.current;
    if(!data || data.stateToken!==owner.stateToken){setError('视口正在同步工程，请等待后重新定位关联。');return;}
    try{const canonical=canonicalPropertyHighlightTargets(targets,data.bodyMetadata||[]);for(const id of new Set(canonical.map(target=>target.bodyId)))await ensureBodyPresentation(id,false,false);
      if(epoch!==propertyHighlightEpoch.current || owner.documentId!==modelingController.getSnapshot().documentId || owner.stateToken!==modelingController.getSnapshot().stateToken)return;
      handlePreparationPreview(null);handleLocateQuality(null);clearHighlight();propertySelectionRef.current={documentId:owner.documentId,propertyKey:propertySchemaKeyRef.current,targets:canonical};renderPropertySelection();
      if(propertyHighlightRef.current)fitCamera(propertyHighlightRef.current);setStatus(`属性关联集合 · ${canonical.length} 项；隐藏的 Body 不绘制高亮。`);
    }catch(reason){setError(reason instanceof Error?reason.message:'无法定位关联集合。');}
  },[ensureBodyPresentation,handlePreparationPreview,handleLocateQuality,clearHighlight,renderPropertySelection,fitCamera]);
  const locateMeshSourceFace = useCallback(async (source: {bodyId:string;cadFaceId:string;bodyIdentity:string;topologyIdentity:string}) => {
    handlePreparationPreview(null);
    const documentId=modelingController.getSnapshot().documentId;
    const valid=()=>{const body=modelRef.current?.bodyMetadata?.find(item=>item.bodyId===source.bodyId);return modelingController.getSnapshot().documentId===documentId&&body?.bodyIdentity===source.bodyIdentity&&body?.topologyIdentity===source.topologyIdentity&&body.visible!==false;};
    if(!valid()){setError("面来源已变化或 Body 已隐藏，不能定位。");return;}
    try {
      await ensureBodyPresentation(source.bodyId,false,false);
      if(!valid())return;
      handleLocateQuality(null);selectTargetFromProperty({kind:"face",bodyId:source.bodyId,topologyId:source.cadFaceId});
      const highlight=faceHighlightRef.current;if(!highlight)return;
      fitCamera(highlight);
      const normal=highlight.geometry.getAttribute("normal"),direction=new THREE.Vector3();
      for(let i=0;i<normal.count;i++)direction.add(new THREE.Vector3(normal.getX(i),normal.getY(i),normal.getZ(i)));
      const camera=cameraRef.current,controls=controlsRef.current;
      if(camera&&controls&&direction.lengthSq()>1e-12){direction.normalize();const center=new THREE.Box3().setFromObject(highlight).getCenter(new THREE.Vector3()),distance=camera.position.distanceTo(center);camera.position.copy(center).addScaledVector(direction,distance);camera.up.set(0,Math.abs(direction.z)>.95?1:0,Math.abs(direction.z)>.95?0:1);camera.updateProjectionMatrix();controls.target.copy(center);controls.update();}
    }catch(reason){setError(reason instanceof Error?reason.message:"无法定位来源面。");}
  },[ensureBodyPresentation,fitCamera,handleLocateQuality,selectTargetFromProperty,handlePreparationPreview]);
  const locateDiagnostic=useCallback(async(target:MeshDiagnosticTarget)=>{
    handlePreparationPreview(null);
    if(target.kind==='face'){void locateMeshSourceFace({...target,cadFaceId:target.topologyId||''});return;}
    const id=modelingController.getSnapshot().documentId;
    try{await ensureBodyPresentation(target.bodyId,false,false);const body=modelRef.current?.bodyMetadata?.find(item=>item.bodyId===target.bodyId);if(modelingController.getSnapshot().documentId!==id||!body||body.bodyIdentity!==target.bodyIdentity||body.topologyIdentity!==target.topologyIdentity||body.visible===false){setError("诊断来源已变化或对象已隐藏，未执行定位。");return;}handleLocateQuality(null);selectTargetFromProperty(target);const object=target.kind==='edge'?edgeLinesRef.current.find(line=>line.userData.bodyId===target.bodyId&&line.userData.edgeId===target.topologyId):bodyMeshesRef.current.find(mesh=>mesh.userData.bodyId===target.bodyId);if(object)fitCamera(object);}catch(reason){setError(reason instanceof Error?reason.message:"无法定位诊断对象。");}
  },[handlePreparationPreview,locateMeshSourceFace,ensureBodyPresentation,handleLocateQuality,selectTargetFromProperty,fitCamera]);
  const activateBodyFromTree = useCallback(async (bodyId: string) => {
    const current = modelRef.current;
    if (!current || (current.activeBodyId || current.bodyId) === bodyId) {
      if (current) await selectBodyFromTree(bodyId);
      return;
    }
    setBusy(true); setError(null);
    try {
      const result = await postCommand({ operation: "body.update", baseRevision: current.revision, inputs: { bodyId }, parameters: { activate: true } });
      if (!modelingController.acceptsState(result) || (result.documentId && result.documentId !== modelingController.getSnapshot().documentId)) return;
      displayModel(result, { fitCamera: false });
      await selectBodyFromTree(bodyId);
      setStatus("已切换当前 Body · 文档版本 " + result.revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Body 激活失败。");
    } finally { setBusy(false); }
  }, [displayModel, postCommand, selectBodyFromTree]);
  const editFeatureFromTree = useCallback((bodyId: string|null, featureId: string) => {
    setTreeFeatureRepair(null);
    if(bodyId)selectBodyFromTree(bodyId);
    setFeatureToEdit(featureId);
    setActiveOperation("history");
  }, [selectBodyFromTree]);

  const deleteBodyFromTree = useCallback(async (bodyId: string) => {
    const current = modelRef.current;
    if (!current || deletingBodyId) return;
    setDeletingBodyId(bodyId);
    setBusy(true);
    setError(null);
    setStatus("正在删除 Body…");
    try {
      const result = await postCommand({
        operation: "body.delete",
        baseRevision: current.revision,
        inputs: { bodyId },
      });
      displayModel(result);
      setStatus("Body 已删除 · 文档版本 " + result.revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Body 删除失败。");
      setStatus("Body 未删除");
    } finally {
      setDeletingBodyId(null);
      setBusy(false);
    }
  }, [deletingBodyId, displayModel]);

  const updateBodyFromTree = useCallback(async (bodyId: string, changes: Record<string, unknown>, fromEditor=false) => {
    const current = modelRef.current;
    if (!current) return false;
    setBusy(true); setError(null);
    try {
      const result = await (fromEditor?postEditCommand:postCommand)({ operation: "body.update", baseRevision: current.revision, inputs: { bodyId }, parameters: changes });
      displayModel(result);
      renderMeshResults(meshResultsRef.current);
      if (changes.visible === true) void ensureBodyPresentation(bodyId);
      setStatus("Body 已更新 · 文档版本 " + result.revision);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Body 更新失败。");
      return false;
    } finally { setBusy(false); }
  }, [displayModel, ensureBodyPresentation, renderMeshResults]);
  const hideSelectedBodies = useCallback(async () => {
    const ids = [...selectedBodyIdsRef.current];
    setContextMenu(null);
    for (const bodyId of ids) await updateBodyFromTree(bodyId, { visible: false });
  }, [updateBodyFromTree]);
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const background = new THREE.Color("#e4ebf4");
    scene.background = background;
    const backgroundRgb = background.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
    const countForeground = (pixels: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - backgroundRgb.r * 255) > 5 || Math.abs(pixels[i + 1] - backgroundRgb.g * 255) > 5 || Math.abs(pixels[i + 2] - backgroundRgb.b * 255) > 5) count++;
      }
      return count;
    };

    const savedCamera=viewportCameraRef.current;
    const aspect = () => Math.max(1, mount.clientWidth) / Math.max(1, mount.clientHeight);
    let camera: ViewportCamera = savedCamera?.camera.clone() ?? new THREE.PerspectiveCamera(viewportFov, aspect(), 0.1, 10000);
    if (!savedCamera) {
      camera.up.set(0, 0, 1);
      camera.position.set(260, -320, 240);
    }
    setViewportFrustum(camera, aspect());
    setViewportDisplay(camera, displayModeRef.current, selectionModeRef.current === "edge");

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    if(savedCamera)controls.target.copy(savedCamera.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    // The actual part establishes its scale when its presentation is adopted.
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    controls.enablePan = true;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;

    let lastHealthSample=0,healthDirty=true,renderedFrames=0;
    mount.dataset.frameMode='on-demand';mount.dataset.viewportRenderFrames='0';
    const frames=createViewportFrame({draw:()=>{
      const changing=controls.update();
      renderer.render(scene,camera);
      if (axesRef.current) {
        const inverse = camera.quaternion.clone().invert();
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(([x, y, z], index) => {
          const axis = new THREE.Vector3(x, y, z).applyQuaternion(inverse);
          const line = axesRef.current?.querySelectorAll("line")[index];
          const label = axesRef.current?.querySelectorAll("text")[index];
          line?.setAttribute("x2", String(34 + axis.x * 29));
          line?.setAttribute("y2", String(34 - axis.y * 29));
          label?.setAttribute("x", String(34 + axis.x * 38));
          label?.setAttribute("y", String(34 - axis.y * 38));
        });
      }
      mount.dataset.viewportRenderFrames=String(++renderedFrames);
      if(healthDirty||!changing||performance.now()-lastHealthSample>500){
        healthDirty=false;lastHealthSample=performance.now();
        const health=viewportHealth(scene,camera,bodyMeshesRef.current);
        mount.dataset.attachedBodies=String(health.attached);mount.dataset.visibleBodies=String(health.visible);mount.dataset.frustumBodies=String(health.inFrustum);mount.dataset.renderedTriangles=String(renderer.info.render.triangles);mount.dataset.renderedLines=String(renderer.info.render.lines);
      }
      return changing;
    }});
    const invalidate=()=>{healthDirty=true;frames.invalidate();};
    invalidateViewportRef.current=invalidate;
    changeProjectionRef.current = value => {
      const isPerspective = camera instanceof THREE.PerspectiveCamera;
      if (isPerspective === (value === "perspective")) return;
      camera = changeViewportProjection(camera, value, controls.target, aspect());
      controls.object = camera;
      cameraRef.current = camera;
      controls.update();
      setProjection(value);
      invalidate();
    };
    captureViewportRef.current = () => {
      if (renderer.getContext().isContextLost()) return;
      renderer.render(scene, camera);
      renderer.domElement.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "OCCT_Web_Studio_Viewport.png";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "image/png");
    };
    const onControlsChange=()=>frames.invalidate();
    controls.addEventListener('change',onControlsChange);
    frames.setPaused(document.visibilityState==='hidden');

    scene.add(new THREE.HemisphereLight(0xcde5ff, 0x1b2430, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(180, -160, 240);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x81b7ff, 1.1);
    fillLight.position.set(-180, 80, 120);
    scene.add(fillLight);

    const grid = createConstructionGrid();
    scene.add(grid);
    grid.visible=gridVisibleRef.current;
    gridRef.current = grid;
    alignConstructionGrid(grid,constructionFrameRef.current,gridVisibleRef.current);

    const snapGridPoint = (event: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const mouse = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      // Standard-view changes can precede the next animation frame. Picking must
      // use that view immediately, not the previous frame's camera transform.
      camera.updateMatrixWorld();
      ray.setFromCamera(mouse, camera);
      const frame=dragFrameRef.current || constructionFrameRef.current;
      if(!frame)return null;
      const point = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...frame.z),new THREE.Vector3(...frame.origin)), new THREE.Vector3());
      if (!point) return null;
      return new THREE.Vector3(...snappedConstructionPoint(frame,point.toArray() as [number,number,number],dragFrameRef.current?dragStepRef.current:snapStepRef.current));
    };
    const hideSnapMarker = () => snapMarkerRef.current?.removeAttribute("data-point");
    const updateSnapMarker = (point: THREE.Vector3 | null) => {
      const marker = snapMarkerRef.current;
      const frame = dragFrameRef.current || constructionFrameRef.current;
      if (!marker || !frame || !point) { hideSnapMarker(); return; }
      const projected = new THREE.Vector3(...constructionToWorld(frame, [point.x, point.y, 0])).project(camera);
      if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1) { hideSnapMarker(); return; }
      marker.style.left = `${(projected.x + 1) * 50}%`;
      marker.style.top = `${(1 - projected.y) * 50}%`;
      marker.dataset.point = `${dragDimension(point.x)},${dragDimension(point.y)}`;
    };
    let dragPreviewKey = "";
    mount.dataset.dragPreviewBuilds = "0";
    const clearDragGhost = () => {
      hideSnapMarker();
      invalidate();
      dragPreviewKey = "";
      dragSessionRef.current=null;
      dragFrameRef.current=null;
      if (dragGhostRef.current) {
        scene.remove(dragGhostRef.current);
        disposeObject(dragGhostRef.current);
        dragGhostRef.current = null;
      }
      dragStartRef.current = null;
      dragEndRef.current = null;
      dragHeightAdjustedRef.current = false;
      dragStageRef.current = "idle"; setDragStage("idle");
      controls.enabled = true;
      setDragPreview(null);
    };
    cancelDragRef.current = clearDragGhost;
    const onDragKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearDragGhost();
      if (event.key === "Backspace" && dragModelingRef.current && dragStageRef.current === "height"
        && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]'))) {
        event.preventDefault(); reselectDragBaseRef.current();
      }
    };
    window.addEventListener("keydown", onDragKey);
    const updateDragGhost = (start: THREE.Vector3, end: THREE.Vector3) => {
      const kind = dragPrimitiveRef.current;
      const frame=dragFrameRef.current;
      if(!frame)return;
      const command = constructionDragCommand(kind, start, end, dragStepRef.current, dragStageRef.current === "base" ? dragStepRef.current : dragHeightRef.current,frame);
      if (!command) {
        if (!dragPreviewKey) return;
        invalidate();
        dragPreviewKey = "";
        if (dragGhostRef.current) { scene.remove(dragGhostRef.current); disposeObject(dragGhostRef.current); dragGhostRef.current = null; }
        setDragPreview(null);
        return;
      }
      // Grid snapping often produces the same dimensions across many pointer
      // events. Do not rebuild GPU buffers or rerender React until they change.
      const nextKey = JSON.stringify([frame.signature,kind, dragStageRef.current, command.preview]);
      if (nextKey === dragPreviewKey) return;
      dragPreviewKey = nextKey;
      invalidate();
      const { width, depth, height, x, y } = command.preview;
      // During footprint selection, show only the construction plane, not a premature solid.
      const footprint = dragStageRef.current === "base" && needsDragHeight(kind);
      const rectangular = ["box", "wedge", "pyramid"].includes(kind);
      const shape = footprint ? rectangular ? new THREE.PlaneGeometry(width, depth) : new THREE.CircleGeometry(width / 2, 48) : dragPreviewGeometry(kind, command.preview);
      const ghost = new THREE.Group();
      ghost.add(new THREE.Mesh(shape, new THREE.MeshBasicMaterial({ color: 0x159fbd, transparent: true, opacity: 0.24, depthWrite: false, side: THREE.DoubleSide })));
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(shape, 25), new THREE.LineBasicMaterial({ color: 0x08738e, depthWrite: false }));
      outline.renderOrder = 3;
      ghost.add(outline);
      ghost.position.set(x, y, footprint ? .05 : kind.replace("surface-", "") === "torus" || kind.replace("surface-", "") === "sphere" ? 0 : height / 2);
      ghost.applyMatrix4(constructionMatrix(frame));
      ghost.renderOrder = 2;
      if (dragGhostRef.current) {
        scene.remove(dragGhostRef.current);
        disposeObject(dragGhostRef.current);
      }
      dragGhostRef.current = ghost;
      scene.add(ghost);
      mount.dataset.dragPreviewBuilds = String(Number(mount.dataset.dragPreviewBuilds) + 1);
      setDragPreview({ width, depth, height: footprint ? 0 : height, x, y });
    };
    reselectDragBaseRef.current = () => {
      if (dragCommittingRef.current || dragStageRef.current !== "height" || !dragStartRef.current || !dragEndRef.current) return;
      dragStageRef.current = "base"; setDragStage("base");
      dragHeightRef.current = dragStepRef.current;
      dragHeightAdjustedRef.current = false;
      updateDragGhost(dragStartRef.current, dragEndRef.current);
      controls.enabled = false;
      setStatus("已返回底面绘制，起点保留；移动鼠标并点击重新确定底面，不提交几何。");
    };

    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    // A replacement renderer owns a new Scene. Never reuse disposed Three.js
    // objects from the previous scene, even though the CPU model cache survives.
    modelGroupRef.current=null;bodyMeshesRef.current=[];edgeLinesRef.current=[];meshGroupRef.current=null;qualityGroupRef.current=null;preparationGroupRef.current=null;
    const cachedModel=modelRef.current;
    const savedPropertySelection=propertySelectionRef.current;
    if(cachedModel){
      if(!modelingController.acceptsState(cachedModel))void modelingController.execute<ModelData>({operation:"document.view"}).then(latest=>{if(sceneRef.current===scene)displayModel(latest,{fitCamera:!savedCamera});}).catch(()=>setStatus("显示缓存已过期，请重新载入工程。"));
      else if(cachedModel.bodyPresentations?.length || Array.isArray(cachedModel.positions))renderModel(cachedModel,{fitCamera:!savedCamera});
      else displayModel(cachedModel);
      renderMeshResults(meshResultsRef.current);
      renderQualitySelection();
      renderPreparationPreview();
      propertySelectionRef.current=savedPropertySelection;renderPropertySelection();
    }
    const onContextLost=(event: Event)=>{event.preventDefault();frames.setPaused(true);cancelDragRef.current();controls.enabled=false;mount.dataset.contextState="lost";setViewerReady(false);setStatus("3D 显示连接中断，工程数据保留，正在等待恢复…");};
    const onContextRestored=()=>{setViewportEpoch(value=>value+1);setStatus("3D 显示已恢复，正在重建视口…");};
    renderer.domElement.addEventListener("webglcontextlost",onContextLost);
    renderer.domElement.addEventListener("webglcontextrestored",onContextRestored);
    const onVisible=()=>frames.setPaused(document.visibilityState==='hidden'||renderer.getContext().isContextLost());
    document.addEventListener("visibilitychange",onVisible);
    mount.dataset.contextState="ready";

    const onPointerDown = (event: PointerEvent) => {
      if (dragModelingRef.current && dragCommittingRef.current) return;
      setContextMenu(null);
      pointerStartRef.current = { x: event.clientX, y: event.clientY };
      if (event.button === 0 && event.shiftKey && !dragStartRef.current) {
        pointerStartRef.current = null;
      } else if (event.button === 0 && dragModelingRef.current) {
        if (modelingController.hasPendingMutation()) return;
        if(!constructionFrameRef.current){setStatus("当前构造坐标系无效，请先重新选择。");return;}
        const point = snapGridPoint(event);
        if (!point && dragStageRef.current === "idle") {
          setStatus("当前视线平行于构造面，请点击“正视构造面”或切换轴测视图后绘制。");
          return;
        }
        if (point && dragStageRef.current === "idle") {
          const session=new CommandEditSession(modelingController,{documentId:modelingController.getSnapshot().documentId,revision:modelRef.current?.revision??null,stateToken:modelRef.current?.stateToken??null});
          if(!session.isReady() || session.isStale()){setStatus("几何显示正在同步工程状态，请等待后再绘制。");return;}
          dragSessionRef.current=session;
          dragFrameRef.current=constructionFrameRef.current;dragStepRef.current=snapStepRef.current;
          dragStartRef.current = point;
          dragFootprintAnchorRef.current = { x: event.clientX, y: event.clientY };
          dragStageRef.current = "base"; setDragStage("base"); dragHeightRef.current = 20;
        }
        controls.enabled = false; event.preventDefault();
      } else if (event.button === 0 && selectionModeRef.current === "body" && !preparationGroupRef.current) {
        boxSelectRef.current = { startX: event.clientX, startY: event.clientY, additive: event.ctrlKey || event.metaKey, active: false };
        controls.enabled = false;
      } else if (event.button === 2) {
        controls.enabled = false;
      }
      renderer.domElement.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragModelingRef.current && dragStartRef.current) {
        if (dragStageRef.current === "height" && dragEndRef.current) {
          const rect = mount.getBoundingClientRect();
          const frame=dragFrameRef.current;
          if(!frame)return;
          const reference = gridDragHeightReference(dragPrimitiveRef.current, dragStartRef.current, dragEndRef.current);
          const center=new THREE.Vector3(...constructionToWorld(frame,[reference.x, reference.y, 0]));
          const base = center.clone().project(camera), up = center.clone().add(new THREE.Vector3(...frame.z)).project(camera);
          const ax = (up.x - base.x) * rect.width / 2, ay = -(up.y - base.y) * rect.height / 2;
          const deltaX = event.clientX - dragHeightAnchorRef.current.x, deltaY = event.clientY - dragHeightAnchorRef.current.y;
          const direction = camera.getWorldDirection(new THREE.Vector3());
          const topView = Math.abs(direction.dot(new THREE.Vector3(...frame.z))) > .95;
          dragHeightAdjustedRef.current ||= hasDragHeightAdjustment(deltaX, deltaY, topView ? 0 : ax, topView ? 0 : ay);
          if (!dragHeightAdjustedRef.current) return;
          const depth = center.clone().sub(camera.position).dot(direction);
          const pixelScale = viewportViewHeight(camera, depth) / rect.height;
          dragHeightRef.current = heightFromScreenDrag(deltaX, deltaY, topView ? 0 : ax, topView ? 0 : ay, pixelScale,dragStepRef.current);
          updateDragGhost(dragStartRef.current, dragEndRef.current);
        } else { const point = snapGridPoint(event); updateSnapMarker(point); if (point) { dragEndRef.current = point; updateDragGhost(dragStartRef.current, point); } }
        return;
      }
      if (dragModelingRef.current && !preparationGroupRef.current) updateSnapMarker(snapGridPoint(event));
      const box = boxSelectRef.current;
      if (!box || event.buttons !== 1) return;
      const distance = Math.hypot(event.clientX - box.startX, event.clientY - box.startY);
      if (!box.active && distance <= 5) return;
      box.active = true;
      const rect = mount.getBoundingClientRect();
      setSelectionRect({
        left: Math.min(box.startX, event.clientX) - rect.left,
        top: Math.min(box.startY, event.clientY) - rect.top,
        width: Math.abs(event.clientX - box.startX),
        height: Math.abs(event.clientY - box.startY),
      });
    };
    const onPointerUp = async (event: PointerEvent) => {
      if (dragModelingRef.current && dragCommittingRef.current) return;
      const start = pointerStartRef.current;
      const box = boxSelectRef.current;
      pointerStartRef.current = null;
      boxSelectRef.current = null;
      setSelectionRect(null);
      controls.enabled = !(dragModelingRef.current && dragStageRef.current !== "idle");
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      if (event.button !== 0) return;
      // A release without a matching press (e.g. after cancelling a draft or
      // releasing over the canvas from another control) must never advance it.
      if (!start) return;
      if(preparationGroupRef.current)return;
      if (dragModelingRef.current && !dragStartRef.current) return;
      if (dragStartRef.current) {
        if (dragStageRef.current === "base" && !hasDragFootprintMovement(
          event.clientX - dragFootprintAnchorRef.current.x,
          event.clientY - dragFootprintAnchorRef.current.y,
        )) {
          setStatus("起点已确定，移动鼠标绘制底面，再点击锁定；Esc 取消。");
          return;
        }
        const origin = dragStartRef.current.clone();
        const point = dragStageRef.current === "height" ? dragEndRef.current : snapGridPoint(event);
        const kind = dragPrimitiveRef.current;
        if (!point) return;
        const command = dragFrameRef.current?constructionDragCommand(kind, origin, point, dragStepRef.current, dragHeightRef.current,dragFrameRef.current):null;
        if (!command) {
          setStatus("移动鼠标确定底面，点击确认；Esc 取消");
          return;
        }
        if (dragStageRef.current === "height" && !dragHeightAdjustedRef.current) {
          setStatus("底面已锁定，请移动鼠标调整高度后再点击完成；Alt+M 可精确输入参数。");
          return;
        }
        if (dragStageRef.current === "base" && needsDragHeight(kind)) {
          hideSnapMarker();
          dragEndRef.current = point; dragStageRef.current = "height"; setDragStage("height");
          dragHeightAnchorRef.current = { x: event.clientX, y: event.clientY }; dragHeightRef.current = dragStepRef.current;
          dragHeightAdjustedRef.current = false;
          updateDragGhost(origin, point); controls.enabled = false;
          setStatus(kind === "torus" ? "底面已确定，移动鼠标调整管半径，点击完成" : "底面已确定，向上移动鼠标调整高度，点击完成"); return;
        }
        const drawingSession=dragSessionRef.current;
        clearDragGhost();
        dragCommittingRef.current = true;
        setBusy(true);
        setError(null);
        setStatus("正在根据网格拖拽创建几何…");
        try {
          if(!drawingSession)throw new Error("绘制基线已失效，请重新绘制。");
          const result = await drawingSession.execute<ModelData>({ operation: command.operation, parameters: command.parameters });
          // Keep screen-to-world placement stable for the next primitive.
          displayModel(result, { fitCamera: false });
          setStatus(`拖拽创建完成 · ${dragDimension(command.preview.width)} × ${dragDimension(command.preview.depth)} × ${kind === "disk" ? "面" : dragDimension(command.preview.height)} mm · R${result.revision}`);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "拖拽建模失败");
          setStatus("拖拽建模未完成");
        } finally { setBusy(false); dragCommittingRef.current = false; }
        return;
      }
      if (!start) return;
      if (box?.active) {
        const picked = selectBodiesInRectangle(start, { x: event.clientX, y: event.clientY });
        const next = box.additive ? [...new Set([...selectedBodyIdsRef.current, ...picked])] : picked;
        applyBodySelection(next);
        return;
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 5) handlePick(event);
    };
    const onPointerCancel = (event: PointerEvent) => {
      pointerStartRef.current = null;
      boxSelectRef.current = null;
      clearDragGhost();
      setSelectionRect(null);
      controls.enabled = true;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (dragModelingRef.current && dragStageRef.current !== "idle") {
        clearDragGhost();
        setStatus("已取消当前绘制，未创建几何。");
        return;
      }
      const pointer = event as PointerEvent;
      const bodyId = findBodyAtPointer(pointer);
      if (bodyId && !selectedBodyIdsRef.current.includes(bodyId)) {
        changeSelectionMode("body");
        applyBodySelection([bodyId]);
      }
      const rect = mount.getBoundingClientRect();
      setContextMenu({
        left: event.clientX - rect.left,
        top: event.clientY - rect.top,
      });
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener("pointerleave", hideSnapMarker);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    const resizeViewport = () => {
      // The dock can be resized while the model is loading. Keep the renderer
      // and camera valid even if the first layout pass reports 0.
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      setViewportFrustum(camera, width / height);
      renderer.setSize(width, height);
      invalidate();
    };
    const resizeObserver = new ResizeObserver(resizeViewport);
    resizeObserver.observe(mount);
    const initialResizeFrame = requestAnimationFrame(resizeViewport);

    invalidate();
    const verifyFrame = () => {
      mount.dataset.cameraPose = JSON.stringify([...camera.position.toArray(), ...controls.target.toArray(), camera.zoom]);
      camera.updateMatrixWorld(true);modelGroupRef.current?.updateMatrixWorld(true);
      mount.dataset.bodyWorldBounds=JSON.stringify(bodyMeshesRef.current.slice(0,8).map(mesh=>{const box=new THREE.Box3().setFromObject(mesh);return {bodyId:mesh.userData.bodyId,min:box.min.toArray(),max:box.max.toArray(),origin:mesh.position.toArray()};}));
      const aperture=viewportRaycaster(new THREE.Vector2(),camera,mount.clientHeight,controls.target);
      mount.dataset.edgeScreenPoints=JSON.stringify(edgeLinesRef.current.filter(line=>line.visible).slice(0,64).map(line=>{
        const positions=line.geometry.getAttribute('position'),point=new THREE.Vector3().fromBufferAttribute(positions,Math.floor((positions.count-1)/2)),next=new THREE.Vector3().fromBufferAttribute(positions,Math.min(positions.count-1,Math.floor((positions.count-1)/2)+1));point.add(next).multiplyScalar(.5).applyMatrix4(line.matrixWorld).project(camera);
        aperture.setFromCamera(new THREE.Vector2(point.x,point.y),camera);const winner=pickViewportEdge(aperture,edgeLinesRef.current,bodyMeshesRef.current,camera);
        return {edgeId:line.userData.edgeId,x:(point.x+1)*mount.clientWidth/2,y:(1-point.y)*mount.clientHeight/2,z:point.z,pickable:winner?.object===line};
      }));
      const visibility=scene.children.map(child=>[child,child.visible] as const);
      try {
        scene.children.forEach(child=>{if(child!==modelGroupRef.current && !(child instanceof THREE.Light))child.visible=false;});
        renderer.render(scene,camera);
        const gl=renderer.getContext(),pixels=new Uint8Array(renderer.domElement.width*renderer.domElement.height*4);
        gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        mount.dataset.renderedBodyPixels = String(countForeground(pixels));
      }finally{visibility.forEach(([child,visible])=>{child.visible=visible;});renderer.render(scene,camera);}
    };
    const verifyFaceSelection=()=>{
      const highlight=faceHighlightRef.current;mount.dataset.selectedFacePixels="0";if(!highlight)return;
      // Measure the final composited scene, not an isolated copy of the face.
      // Other Bodies, shells and hidden parents must continue to occlude it.
      const visible=highlight.visible,gl=renderer.getContext(),size=renderer.domElement.width*renderer.domElement.height*4;
      const without=new Uint8Array(size),withHighlight=new Uint8Array(size);
      try{
        highlight.visible=false;renderer.render(scene,camera);
        gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,without);
        highlight.visible=visible;renderer.render(scene,camera);
        gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,withHighlight);
        let count=0;for(let i=0;i<size;i+=4)if(Math.abs(without[i]-withHighlight[i])>5||Math.abs(without[i+1]-withHighlight[i+1])>5||Math.abs(without[i+2]-withHighlight[i+2])>5)count++;
        mount.dataset.selectedFacePixels=String(count);
      }finally{highlight.visible=visible;renderer.render(scene,camera);}
    };
    const verifyPropertySelection=()=>{
      const group=propertyHighlightRef.current;mount.dataset.propertyHighlightPixels='0';if(!group)return;
      const gl=renderer.getContext(),size=renderer.domElement.width*renderer.domElement.height*4,before=new Uint8Array(size),after=new Uint8Array(size),visible=group.visible;
      try{group.visible=false;renderer.render(scene,camera);gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,before);group.visible=visible;renderer.render(scene,camera);gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,after);let count=0;for(let i=0;i<size;i+=4)if(Math.abs(before[i]-after[i])>5||Math.abs(before[i+1]-after[i+1])>5||Math.abs(before[i+2]-after[i+2])>5)count++;mount.dataset.propertyHighlightPixels=String(count);}finally{group.visible=visible;renderer.render(scene,camera);}
    };
    const verifyQualityFrame=()=>{
      const visibility=scene.children.map(child=>[child,child.visible] as const);
      try{
        scene.children.forEach(child=>{if(child!==qualityGroupRef.current)child.visible=false;});renderer.render(scene,camera);
        const gl=renderer.getContext(),pixels=new Uint8Array(renderer.domElement.width*renderer.domElement.height*4);gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        mount.dataset.qualityHighlightPixels = String(countForeground(pixels));
        for(const [name,key] of [['mesh-topology-common-face','qualityTopologyFacePixels'],['mesh-spatial-peer','qualitySpatialPeerPixels']]){
          mount.dataset[key]='0';const marker=qualityGroupRef.current?.getObjectByName(name);
          if(marker){const visible=marker.visible;try{marker.visible=false;renderer.render(scene,camera);const withoutMarker=new Uint8Array(pixels.length);gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,withoutMarker);let changed=0;for(let n=0;n<pixels.length;n+=4)if(Math.abs(pixels[n]-withoutMarker[n])+Math.abs(pixels[n+1]-withoutMarker[n+1])+Math.abs(pixels[n+2]-withoutMarker[n+2])>10)changed++;mount.dataset[key]=String(changed);}finally{marker.visible=visible;}}
        }
      }finally{visibility.forEach(([child,visible])=>{child.visible=visible;});renderer.render(scene,camera);}
    };
    const verifyPreparationFrame=()=>{
      const visibility=scene.children.map(child=>[child,child.visible] as const);
      try{scene.children.forEach(child=>{if(child!==preparationGroupRef.current&&!(child instanceof THREE.Light))child.visible=false;});renderer.render(scene,camera);const gl=renderer.getContext(),pixels=new Uint8Array(renderer.domElement.width*renderer.domElement.height*4);gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);mount.dataset.preparationPreviewPixels=String(countForeground(pixels));}finally{visibility.forEach(([child,visible])=>{child.visible=visible;});renderer.render(scene,camera);}
    };
    mount.addEventListener("cad:verify-frame",verifyFrame);
    mount.addEventListener("cad:verify-selection",verifyFaceSelection);
    mount.addEventListener('cad:verify-property-selection',verifyPropertySelection);
    mount.addEventListener("cad:verify-quality",verifyQualityFrame);
    mount.addEventListener("cad:verify-preparation",verifyPreparationFrame);
    setViewerReady(true);

    return () => {
      viewportCameraRef.current={camera:camera.clone(),target:controls.target.clone()};
      changeProjectionRef.current = () => undefined;
      captureViewportRef.current = () => undefined;
      modelGenerationRef.current+=1;
      bodyPresentationLoadsRef.current.clear();assemblyPreviewLoadRef.current=null;fullRenderLoadRef.current=null;
      frames.dispose();controls.removeEventListener('change',onControlsChange);
      if(invalidateViewportRef.current===invalidate)invalidateViewportRef.current=()=>{};
      cancelAnimationFrame(initialResizeFrame);
      resizeObserver.disconnect();
      mount.removeEventListener("cad:verify-frame",verifyFrame);
      mount.removeEventListener("cad:verify-selection",verifyFaceSelection);
      mount.removeEventListener('cad:verify-property-selection',verifyPropertySelection);removePropertyHighlight();
      mount.removeEventListener("cad:verify-quality",verifyQualityFrame);
      mount.removeEventListener("cad:verify-preparation",verifyPreparationFrame);
      renderer.domElement.removeEventListener("webglcontextlost",onContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored",onContextRestored);
      document.removeEventListener("visibilitychange",onVisible);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      clearDragGhost();
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onDragKey);
      cancelDragRef.current = () => undefined;
      reselectDragBaseRef.current = () => undefined;
      renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
      renderer.domElement.removeEventListener("pointerleave", hideSnapMarker);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      controls.dispose();
      grid.dispose();
      gridRef.current = null;
      renderer.dispose();
      if (modelGroupRef.current) disposeObject(modelGroupRef.current);
      removeMeshGroup();removeQualityGroup();removePreparationGroup();modelGroupRef.current=null;bodyMeshesRef.current=[];edgeLinesRef.current=[];faceHighlightRef.current=null;
      sceneRef.current=null;cameraRef.current=null;controlsRef.current=null;
      renderer.forceContextLoss();
      mount.removeChild(renderer.domElement);
    };
  }, [applyBodySelection, changeSelectionMode, displayModel, findBodyAtPointer, handlePick, selectBodiesInRectangle, renderModel, renderMeshResults, removeMeshGroup,removeQualityGroup,renderQualitySelection,removePreparationGroup,renderPreparationPreview,removePropertyHighlight,renderPropertySelection,viewportEpoch]);

  const restoreOrCreateModel = useCallback(async function restoreOrCreateModel() {
    const documentId=modelingController.getSnapshot().documentId;
    setBusy(true);
    setError(null);
    setStatus("正在恢复 CAD 文档…");
    try {
      const current=await modelingController.readCurrentWorkspace<ModelData>();
      if(modelingController.getSnapshot().documentId!==documentId)return false;
      displayModel(current);
      setStatus(current.bodyCount ? `已恢复 CAD 文档 · 模型版本 ${current.revision}` : "工程为空，使用上方创建工具开始建模。");
      return true;
    } catch (requestError) {
      const active=modelingController.getSnapshot();
      if(active.documentId!==documentId)return false;
      if(requestError instanceof ModelingCommandError&&requestError.code==='WORKSPACE_READ_SUPERSEDED'&&active.model){displayModel(active.model as ModelData);setStatus('已显示当前工程的最新模型。');return true;}
      setError(requestError instanceof Error ? requestError.message : "无法连接几何服务。");
      if(requestError instanceof ModelingCommandError&&requestError.code==='SOURCE_RESTORE_RECOVERY_REQUIRED'){setStatus('来源事务需要复核，未加载工程；请打开来源恢复记录。');return false;}
      if(requestError instanceof Error && /恢复工程不存在|未找到持久化快照|恢复快照不可用/.test(requestError.message)){setActiveOperation("workspace");setStatus("上次工程无法自动恢复，请选择可恢复工程或打开备份文件。");return false;}
      if (requestError instanceof ModelingCommandError && ["ROUTE_NOT_FOUND", "UNSUPPORTED_OPERATION"].includes(requestError.code)) {
        const message = "几何网关缺少工程读取接口。请启动与当前前端配套的网关版本，再刷新页面。";
        setError(message);
        setStatus(message);
        return false;
      }
      setStatus("几何服务未连接，正在重试…");
      if (restoreRetryTimerRef.current == null) {
        restoreRetryTimerRef.current = window.setTimeout(() => {
          restoreRetryTimerRef.current = null;
          initialLoadStartedRef.current = false;
          void restoreOrCreateModel();
        }, 1500);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [displayModel, setActiveOperation]);

  useEffect(() => {
    if (!viewerReady || modelRef.current || initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    void restoreOrCreateModel();
  }, [viewerReady, restoreOrCreateModel]);

  useEffect(() => () => {
    if (restoreRetryTimerRef.current != null) {
      window.clearTimeout(restoreRetryTimerRef.current);
      restoreRetryTimerRef.current = null;
    }
  }, []);

  const applyFillet = async () => {
    if (!model || !selectedId?.startsWith("edge-")) return;
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在计算圆角…");
    try {
      const result = await postEditCommand<ModelData>({
        operation: "detail.fillet",
        baseRevision: model.revision,
        inputs: { edgeId: selectedId, bodyId: selectedBodyId || model.bodyId },
        parameters: { radius: filletRadius },
      });
      displayModel(result);
      setStatus(`圆角完成 · 模型版本 ${result.revision}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "圆角计算失败。");
      setStatus("圆角未完成");
    } finally {
      setBusy(false);
    }
  };

  const applyChamfer = async () => {
    if (!model || !selectedId?.startsWith("edge-")) return;
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在计算倒角…");
    try {
      const result = await postEditCommand({
        operation: "detail.chamfer",
        baseRevision: model.revision,
        inputs: { edgeId: selectedId, bodyId: selectedBodyId || model.bodyId },
        parameters: { distance: chamferDistance },
      });
      displayModel(result);
      setStatus(`倒角完成 · 模型版本 ${result.revision}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "倒角计算失败。");
      setStatus("倒角未完成");
    } finally {
      setBusy(false);
    }
  };
  const applyDraft = async () => {
    if (!model || !selectedId?.startsWith("face-")) {
      setError("Draft 需要先拾取一个 Face。");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在计算拔模…");
    try {
      const result = await postEditCommand({
        operation: "detail.draft",
        baseRevision: model.revision,
        inputs: { bodyId: selectedBodyId || model.bodyId, faceId: selectedId },
        parameters: {
          angleDegrees: draftAngleExpression,
          neutralOriginX: draftNeutralOrigin.x,
          neutralOriginY: draftNeutralOrigin.y,
          neutralOriginZ: draftNeutralOrigin.z,
          neutralNormalX: draftNeutralNormal.x,
          neutralNormalY: draftNeutralNormal.y,
          neutralNormalZ: draftNeutralNormal.z,
          directionX: draftDirection.x,
          directionY: draftDirection.y,
          directionZ: draftDirection.z,
        },
      });
      displayModel(result);
      setStatus(`拔模完成 · 模型版本 ${result.revision}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "拔模计算失败。");
      setStatus("拔模未完成");
    } finally {
      setBusy(false);
    }
  };  const applyPattern = async () => {
    if (!model) return;
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在线性阵列");
    try {
      const result = await postEditCommand({
        operation: "pattern.linear",
        baseRevision: model.revision,
        inputs: { bodyId: selectedBodyId || model.bodyId },
        parameters: {
          count: patternCountExpression,
          spacing: patternSpacingExpression,
          directionX: patternDirection.x,
          directionY: patternDirection.y,
          directionZ: patternDirection.z,
        },
      });
      displayModel(result);
      setStatus(`线性阵列完成 · 模型版本 ${result.revision}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "线性阵列计算失败。");
      setStatus("线性阵列未完成");
    } finally {
      setBusy(false);
    }
  };  const applyCircularPattern = async () => {
    if (!model) return;
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在计算环形阵列");
    try {
      const result = await postEditCommand({
        operation: "pattern.circular",
        baseRevision: model.revision,
        inputs: { bodyId: selectedBodyId || model.bodyId },
        parameters: {
          count: circularCountExpression,
          angleDegrees: circularAngleExpression,
          originX: circularOrigin.x,
          originY: circularOrigin.y,
          originZ: circularOrigin.z,
          axisX: circularAxis.x,
          axisY: circularAxis.y,
          axisZ: circularAxis.z,
        },
      });
      displayModel(result);
      setStatus("环形阵列完成 · 模型版本 " + result.revision);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "环形阵列计算失败。");
      setStatus("环形阵列未完成");
    } finally {
      setBusy(false);
    }
  };
  const applyRectangularPattern = async () => {
    if (!model) return;
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在计算矩形阵列");
    try {
      const result = await postEditCommand({
        operation: "pattern.rectangular",
        baseRevision: model.revision,
        inputs: { bodyId: selectedBodyId || model.bodyId },
        parameters: {
          countX: rectangularCountXExpression,
          countY: rectangularCountYExpression,
          spacingX: rectangularSpacingXExpression,
          spacingY: rectangularSpacingYExpression,
          directionX: rectangularDirection1.x,
          directionY: rectangularDirection1.y,
          directionZ: rectangularDirection1.z,
          direction2X: rectangularDirection2.x,
          direction2Y: rectangularDirection2.y,
          direction2Z: rectangularDirection2.z,
        },
      });
      displayModel(result);
      setStatus("矩形阵列完成 · 模型版本 " + result.revision);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "矩形阵列计算失败。");
      setStatus("矩形阵列未完成");
    } finally {
      setBusy(false);
    }
  };
  const applyMirrorPattern = async () => {
    if (!model) return;
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在计算镜像阵列");
    try {
      const result = await postEditCommand({
        operation: "pattern.mirror",
        baseRevision: model.revision,
        inputs: { bodyId: selectedBodyId || model.bodyId },
        parameters: {
          originX: mirrorOrigin.x,
          originY: mirrorOrigin.y,
          originZ: mirrorOrigin.z,
          normalX: mirrorNormal.x,
          normalY: mirrorNormal.y,
          normalZ: mirrorNormal.z,
        },
      });
      displayModel(result);
      setStatus("镜像阵列完成 · 模型版本 " + result.revision);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "镜像阵列计算失败。");
      setStatus("镜像阵列未完成");
    } finally {
      setBusy(false);
    }
  };
  const applyRevolve = async () => {
    if (!model || !selectedId?.startsWith("face-")) {
      setError("Revolve 需要先拾取一个 Face。");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("OCCT 正在计算 Revolve…");
    try {
      const result = await postEditCommand({
        operation: "detail.revolve",
        baseRevision: model.revision,
        inputs: { bodyId: selectedBodyId || model.bodyId, faceId: selectedId },
        parameters: {
          angleDegrees: revolveAngleExpression,
          originX: revolveOrigin.x,
          originY: revolveOrigin.y,
          originZ: revolveOrigin.z,
          axisX: revolveAxis.x,
          axisY: revolveAxis.y,
          axisZ: revolveAxis.z,
        },
      });
      displayModel(result);
      setStatus("Revolve 完成 · 模型版本 " + result.revision);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Revolve 计算失败。");
      setStatus("Revolve 未完成");
    } finally {
      setBusy(false);
    }
  };
  const applyOffsetFeature = async () => {
    if (!model) return;
    const requiresFace = offsetFeatureKind !== "offset";
    if (requiresFace && !selectedId?.startsWith("face-")) {
      setError("Shell 和 Thicken 需要先拾取一个 Face。");
      return;
    }
    setBusy(true);
    setError(null);
    const label = offsetFeatureKind === "shell" ? "壳体" : offsetFeatureKind === "thicken" ? "加厚" : "偏置";
    setStatus(`OCCT 正在计算${label}…`);
    try {
      const parameterName = offsetFeatureKind === "offset" ? "distance" : "thickness";
      const result = await postEditCommand({
        operation: `detail.${offsetFeatureKind}`,
        baseRevision: model.revision,
        inputs: {
          bodyId: selectedBodyId || model.bodyId,
          faceId: requiresFace ? selectedId : "",
        },
        parameters: {
          [parameterName]: offsetExpression,
          ...(offsetFeatureKind === "shell" ? { inward: !offsetReverse } : {}),
          ...(offsetFeatureKind === "thicken" ? { reverse: offsetReverse } : {}),
        },
      });
      displayModel(result);
      setStatus(`${label}完成 · 模型版本 ${result.revision}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `${label}计算失败。`);
      setStatus(`${label}未完成`);
    } finally {
      setBusy(false);
    }
  };
  const runShapeCheck = async () => {
    const bodyId = selectedBodyId || model?.bodyId;
    if (!bodyId || commandBusy) return;
    const { documentId, stateToken } = modelingController.getSnapshot();
    setBusy(true);
    setError(null);
    setShapeCheckResult(null);
    try {
      const result = await postCommand({ operation: "geometry.check", inputs: { bodyId } }) as ModelData & { valid: boolean; faceCount: number; edgeCount: number; solidCount: number };
      const current = modelingController.getSnapshot();
      if (current.documentId !== documentId || current.stateToken !== stateToken) return;
      setShapeCheckResult({ documentId, bodyId, stateToken, valid: result.valid, faceCount: result.faceCount, edgeCount: result.edgeCount, solidCount: result.solidCount });
      setStatus(result.valid ? "Shape Check 通过" : "Shape Check 发现无效几何");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Shape Check 失败");
    } finally {
      setBusy(false);
    }
  };
  const handleDirectModel = useCallback((data: ModelData) => {
    if (!modelingController.acceptsState(data) || (data.documentId && data.documentId !== modelingController.getSnapshot().documentId)) return;
    displayModel(data);
    setError(null);
    setStatus(`OCCT 已连接 · 模型版本 ${data.revision}`);
  }, [displayModel]);
  const handleProjectRevision = useCallback((result: { revision: number; variables: ScalarVariableData[]; coordinateSystems: CoordinateSystemData[]; materials: MaterialData[]; positions?: number[] }) => {
    if("documentId" in result && result.documentId && result.documentId!==modelingController.getSnapshot().documentId)return;
    if (result.positions) {
      displayModel(result as ModelData);
      setStatus("工程参数已保存并完成依赖重算 · 文档版本 " + result.revision);
      return;
    }
    const current = modelRef.current;
    if (!current) return;
    const next = { ...current, revision: result.revision, variables: result.variables, coordinateSystems: result.coordinateSystems, materials: result.materials };
    modelRef.current = next;
    setModel(next);
    setStatus("工程参数已保存 · 文档版本 " + result.revision);
  }, [displayModel]);

  const setStandardView = useCallback((view: StandardView) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const object = modelGroupRef.current;
    if (!camera || !controls || !object) return;
    if (view === "iso") {
      fitCamera(object);
      return;
    }
    const directions: Record<Exclude<StandardView, "iso">, THREE.Vector3> = {
      top: new THREE.Vector3(0, 0, 1),
      front: new THREE.Vector3(0, -1, 0),
      right: new THREE.Vector3(1, 0, 0),
      back: new THREE.Vector3(0, 1, 0),
    };
    frameViewport(object, directions[view], view === "top" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
  }, [fitCamera, frameViewport]);

  const moveHistory = useCallback(async (direction: "undo" | "redo") => {
    setBusy(true);
    setError(null);
    setStatus(direction === "undo" ? "正在撤销…" : "正在重做…");
    try {
      const result = await postCommand({ operation: `document.${direction}` });
      displayModel(result);
      setStatus(result.warnings?.length?`${direction === "undo" ? "撤销" : "重做"}完成 · ${result.warnings[0]}`:`${direction === "undo" ? "撤销" : "重做"}完成 · 几何与属性已同步 · 模型版本 ${result.revision}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "历史操作失败。");
    } finally {
      setBusy(false);
    }
  }, [displayModel]);

  const downloadFile = useCallback((blobOrUrl: Blob | string, filename: string) => {
    const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (typeof blobOrUrl !== "string") URL.revokeObjectURL(url);
  }, []);

  const createNewProject = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus("正在创建新工程…");
    try {
      const result = await modelingController.createNewProject<ModelData>();
      displayModel(result, { replaceScene: true });
      setActiveOperation(null);
      setStatus("新工程已创建");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新工程创建失败。");
      setStatus("新建流程未切换页面，请核对任务状态");
    } finally {
      setBusy(false);
    }
  }, [displayModel]);

  const openProjectFromMenu = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setStatus("正在打开工程…");
    try {
      const result = await modelingController.openProject(file);
      displayModel(result as ModelData, { replaceScene: true });
      setActiveOperation(null);
      setStatus(`已打开 ${file.name}${result.warnings?.length ? ` · ${result.warnings.join("；")}` : ""}`);
    } catch (reason) {
      setError(reason instanceof ModelingCommandError&&reason.modelingTask?.phase==='cancelled'?null:reason instanceof Error ? reason.message : "工程打开失败。");
      setStatus(reason instanceof ModelingCommandError&&reason.code==='WORKSPACE_TRANSFER_SUPERSEDED'?"目标工程已打开，页面未切换":reason instanceof ModelingCommandError&&reason.modelingTask?.phase==='cancelled'?"工程打开已取消":"工程打开流程已停止，请核对任务状态");
    } finally {
      setBusy(false);
      if (menuProjectInputRef.current) menuProjectInputRef.current.value = "";
    }
  }, [displayModel]);

  const saveProjectFromMenu = useCallback(async (nameInput?: string) => {
    if (savingProjectRef.current || modelingController.hasPendingMutation()) return;
    const documentId = modelingController.getSnapshot().documentId;
    if (nameInput !== undefined && saveNameOwner !== documentId) return;
    savingProjectRef.current = true;
    setBusy(true);
    setError(null);
    let naming = nameInput !== undefined;
    try {
      let project = await modelingController.getWorkspaceMetadata(documentId);
      if (modelingController.getSnapshot().documentId !== documentId) return;
      if (nameInput === undefined && (!project.name.trim() || project.name.trim() === "未命名工程")) {
        setSaveName("");
        setSaveNameError(null);
        setSaveNameOwner(documentId);
        setActiveOperation("nameBeforeSave");
        return;
      }
      if (nameInput !== undefined) {
        const name = nameInput.trim();
        if (!name || name === "未命名工程") return;
        setSaveNameError(null);
        project = await modelingController.renameWorkspace(name);
        if (modelingController.getSnapshot().documentId !== documentId) return;
        workspace.refresh();
        setActiveOperation(null);
        naming = false;
      }
      setStatus("正在生成工程备份…");
      const blob = await modelingController.saveProject();
      startBackupDownload(blob, workspaceFileName(project.name));
      workspace.refresh();
      setStatus("备份已校验并交给浏览器下载，请确认本地文件保存情况");
    } catch (reason) {
      if (naming) { setSaveNameError(reason instanceof Error ? reason.message : "工程命名失败。"); return; }
      const cancelled=reason instanceof ModelingCommandError&&(reason.modelingTask?.phase==='cancelled'||reason.code==='PROJECT_BACKUP_DOWNLOAD_CANCELLED');
      setError(cancelled?null:reason instanceof Error ? reason.message : "备份生成或下载结果待核对。");
      setStatus(cancelled?reason.code==='PROJECT_BACKUP_DOWNLOAD_CANCELLED'?"已停止下载，后台备份仍保留":"备份生成已取消，工程未修改":reason instanceof ModelingCommandError&&(reason.modelingTask?.phase==='succeeded'||reason.code.startsWith('PROJECT_BACKUP_')||reason.code==='WORKSPACE_TRANSFER_SUPERSEDED')?"备份已生成，未完成下载；可从原任务继续":"保存结果待核对，请检查原任务");
    } finally {
      setBusy(false);
      savingProjectRef.current = false;
    }
  }, [saveNameOwner, setActiveOperation, workspace.refresh]);

  const importStepFromMenu = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setStatus("正在导入 STEP…");
    try {
      const result = await modelingController.importStep(file);
      displayModel(result as ModelData, { replaceScene: true });
      setActiveOperation(null);
      setStatus(`已导入 ${file.name}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "STEP 导入失败。");
      const phase=modelingController.getSnapshot().stepImportStatus?.phase;
      setStatus(phase==='complete'?"STEP 导入已完成，请核对当前工程。":phase==='unknown'?"STEP 导入结果尚未确认，请核对记录与工程。":"STEP 未导入");
    } finally {
      setBusy(false);
      if (menuStepInputRef.current) menuStepInputRef.current.value = "";
    }
  }, [displayModel]);

  const exportStepFromMenu = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus("正在导出 STEP…");
    try {
      const url = await modelingController.exportStep();
      downloadFile(url, "model.step");
      setStatus("STEP 已导出");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "STEP 导出失败。");
      setStatus("STEP 未导出");
    } finally {
      setBusy(false);
    }
  }, [downloadFile]);
  const commandAvailability = useCallback((id: WorkbenchCommand) => {
    if(sourceRecoveryBlocked&&!id.startsWith('view.')&&!['project.sources','project.workspaces','project.backups','model.agent','model.agentSettings','window.closeOperation','select.body','select.face','select.edge'].includes(id))return {enabled:false,reason:'来源事务待复核，请先打开来源恢复记录。'};
    if (id.startsWith("primitive.") || id.startsWith("surface.")) return { enabled: !busy, active: activeTool === id && (dragModeling || activeOperation === "primitives" || activeOperation === "surfaces"), reason: "几何服务正在计算" };
    if (id.startsWith("transform.") || id === "feature.history") return { enabled: Boolean(model?.bodyCount) && !busy, reason: "请先创建或选择 Body" };
    if (id.startsWith("boolean.")) return { enabled: (model?.bodyCount || 0) >= 2 && !busy, reason: "布尔运算至少需要两个 Body" };
    if (["feature.shell", "feature.thicken", "feature.offsetOnly", "feature.sweep", "feature.pipe", "feature.loft"].includes(id)) return { enabled: Boolean(model?.bodyCount) && !busy, reason: "请先创建几何" };
    if (id === "file.new" || id === "file.open" || id === "file.importStep") return { enabled: !busy, reason: "几何服务正在计算" };
    if (id === "file.save" || id === "file.exportStep") return { enabled: Boolean(model) && !busy, reason: "请先创建或打开工程" };
    if (id === "edit.undo") return { enabled: Boolean(controllerState.history?.canUndo??model?.canUndo) && !commandBusy, reason: commandBusy?"当前命令尚未完成":"当前没有可撤销的操作" };
    if (id === "edit.redo") return { enabled: Boolean(controllerState.history?.canRedo??model?.canRedo) && !commandBusy, reason: commandBusy?"当前命令尚未完成":"当前没有可重做的操作" };
    if (id === "edit.properties") return { enabled: Boolean(model), reason: "请先创建或打开工程" };
    if (id === "model.transform") return { enabled: Boolean(model) && !busy, reason: "当前文档没有可变换的 Body" };
    if (id === "model.boolean") return { enabled: (model?.bodyCount || 0) >= 2 && !busy, reason: "Boolean 至少需要两个 Body" };
    if (id === "model.pattern") return { enabled: Boolean(model && (selectedBodyId || model.bodyId)) && !busy, reason: "请先选择一个 Body" };
    if (id === "model.patternCircular") return { enabled: Boolean(model && (selectedBodyId || model.bodyId)) && !busy, reason: "请先选择一个 Body" };
    if (id === "model.patternRectangular") return { enabled: Boolean(model && (selectedBodyId || model.bodyId)) && !busy, reason: "请先选择一个 Body" };
    if (id === "model.patternMirror") return { enabled: Boolean(model && (selectedBodyId || model.bodyId)) && !busy, reason: "请先选择一个 Body" };
    if (id === "feature.revolve") return { enabled: Boolean(model && selectedId?.startsWith("face-")) && !busy, reason: "请先选择一个 Face" };
    if (id === "analysis.shapeCheck") return { enabled: Boolean(model && (selectedBodyId || model.bodyId)) && !busy, reason: "请先选择一个 Body" };
    if (id === "analysis.measure" || id === "analysis.volume") return { enabled: Boolean(model && (selectedBodyId || model.bodyId)) && !commandBusy, reason: "请先选择可测量的几何体" };
    if (id === "feature.fillet") return { enabled: Boolean(model && selectedId?.startsWith("edge-")) && !busy, reason: "请切换到边选择并拾取一条 Edge" };
    if (id === "feature.chamfer") return { enabled: Boolean(model && selectedId?.startsWith("edge-")) && !busy, reason: "请切换到边选择并拾取一条 Edge" };
    if (id === "feature.draft") return { enabled: Boolean(model && selectedId?.startsWith("face-")) && !busy, reason: "请切换到面选择并拾取一个 Face" };
    if (id === "feature.offset") return { enabled: Boolean(model) && !busy, reason: "当前文档没有可操作的 Body" };
    if (["view.fit", "view.iso", "view.top", "view.front", "view.right", "view.back"].includes(id)) return { enabled: Boolean(model), reason: "当前没有可显示的几何" };
    if (id === "view.screenshot") return { enabled: viewerReady, reason: "三维视口尚未就绪" };
    if (id === "view.panels" || id === "view.restorePanels" || id === "view.messages" || id === "view.measurements") return { enabled: true };
    if (id === "view.shaded" || id === "view.wire" || id === "view.edges") return { enabled: viewerReady, active: id.slice(5) === displayMode };
    if (id === "window.closeOperation") return { enabled: Boolean(activeOperation), reason: "当前没有打开的操作窗口" };
    if (id === "select.body") return { enabled: true, active: selectionMode === "body" };
    if (id === "select.face") return { enabled: true, active: selectionMode === "face" };
    if (id === "select.edge") return { enabled: true, active: selectionMode === "edge" };
    if (id === "view.grid") return { enabled: true, active: gridVisible };
    return { enabled: !busy, reason: busy ? "几何服务正在计算" : undefined };
  }, [activeOperation, activeTool, busy, commandBusy, controllerState.history, displayMode, dragModeling, gridVisible, model, selectedBodyId, selectedId, selectionMode, sourceRecoveryBlocked, viewerReady]);

  const handleCommand = useCallback(async (id: WorkbenchCommand) => {
    if(id==="project.workspaces"){setActiveOperation("workspace");return;}
    if(id==="project.backups"){setActiveOperation("backups");return;}
    if(id==="project.sources"){setSourcePanelView('audit');setActiveOperation("sources");return;}
    if (id.startsWith("primitive.") || id.startsWith("surface.")) {
      setActiveTool(id);
      setDragPrimitive((id.startsWith("surface.") ? `surface-${id.slice(8)}` : id.slice(10)) as GridDragKind);
      setParameterDraft(null);
      parameterInputRef.current = null;
      if (dragModeling) { cancelDragRef.current(); setActiveOperation(null); }
      else setActiveOperation(id.startsWith("primitive.") ? "primitives" : "surfaces");
      return;
    }
    if (id.startsWith("transform.")) { setActiveTool(id); setActiveOperation("transform"); return; }
    if (id.startsWith("boolean.")) { setActiveTool(id); setActiveOperation("boolean"); return; }
    if (id === "model.agent") { setAgentOpen((current) => !current); return; }
    if (id === "analysis.measure" || id === "analysis.volume") {
      setMeasureBodyOnly(id === "analysis.volume");
      setActiveOperation("measure");
      return;
    }
    if (id === "view.messages" || id === "view.measurements") {
      changePanel("console", true);
      setMessagesExpanded(true);
      setOutputTab(id === "view.measurements" ? "measurements" : "messages");
      return;
    }
    if (id === "view.panels") { setPanelMenuOpen(true); return; }
    if (id === "view.restorePanels") { restorePanels(); return; }
    if (id === "view.screenshot") { captureViewportRef.current(); return; }
    if (id === "view.shaded" || id === "view.wire" || id === "view.edges") { changeDisplayMode(id.slice(5) as ViewportDisplay); return; }
    if (id === "view.renderAll") { await renderAllBodies(); return; }
    if (id === "feature.history") { setTreeFeatureRepair(null); setFeatureToEdit(null); setActiveOperation("history"); return; }
    if (id === "feature.sweep" || id === "feature.pipe" || id === "feature.loft") { setGeneratedKind(id.slice(8) as "sweep" | "pipe" | "loft"); if (id !== "feature.loft") changeSelectionMode("face"); setActiveOperation("generated"); return; }
    if (id === "feature.shell" || id === "feature.thicken" || id === "feature.offsetOnly") { setOffsetFeatureKind(id === "feature.shell" ? "shell" : id === "feature.thicken" ? "thicken" : "offset"); if (id !== "feature.offsetOnly") changeSelectionMode("face"); setActiveOperation("offsetFeature"); return; }
    if (id === "edit.properties") { setPropertyInstanceId(undefined); setInstanceTypeId(null); }
    if (id === "project.propertyTypes") setPropertyTypeId(undefined);
    if (id.startsWith("project.")) setProjectDataCopyId(null);
    if (id === "select.body" || id === "select.face" || id === "select.edge") {
      changeSelectionMode(id.slice("select.".length) as SelectionMode);
      return;
    }
    if (id === "file.new") { await createNewProject(); return; }
    if (id === "file.open") { menuProjectInputRef.current?.click(); return; }
    if (id === "file.save") { await saveProjectFromMenu(); return; }
    if (id === "file.importStep") { menuStepInputRef.current?.click(); return; }
    if (id === "file.exportStep") { await exportStepFromMenu(); return; }
    if (id === "view.fit") {
      const camera = cameraRef.current, controls = controlsRef.current, group = modelGroupRef.current;
      if (camera && controls && group) frameViewport(group, camera.position.clone().sub(controls.target), camera.up);
      return;
    }
    if (id === "view.iso") {
      setStandardView("iso");
      return;
    }
    if (id === "view.top" || id === "view.front" || id === "view.right" || id === "view.back") {
      setStandardView(id.slice("view.".length) as StandardView);
      return;
    }
    if (id === "view.grid") {
      setGridVisible((current) => {
        const next = !current;
        if (gridRef.current) gridRef.current.visible = next && Boolean(constructionFrameRef.current);
        invalidateViewportRef.current();
        return next;
      });
      return;
    }
    if (id === "edit.undo" || id === "edit.redo") {
      await moveHistory(id === "edit.undo" ? "undo" : "redo");
      return;
    }
    const operationByCommand: Partial<Record<CadCommandId, OperationKind>> = {
      "file.exchange": "exchange",
      "edit.properties": "properties",
      "project.propertyTypes": "propertyTypes",
      "model.primitives": "primitives",
      "model.surfaces": "surfaces",
      "model.transform": "transform",
      "model.boolean": "boolean",
      "model.agent": "agent",
      "model.agentSettings": "agentSettings",
      "model.pattern": "pattern",
      "model.patternCircular": "patternCircular",
      "model.patternRectangular": "patternRectangular",
      "model.patternMirror": "patternMirror",
      "feature.revolve": "revolve",
      "analysis.shapeCheck": "shapeCheck",
      "analysis.mesh": "mesh",
      "feature.fillet": "fillet",
      "feature.chamfer": "chamfer",
      "feature.draft": "draft",
      "feature.offset": "offsetFeature",
      "project.variables": "projectData",
      "project.coordinates": "projectData",
      "project.materials": "projectData",
      "help.capabilities": "capabilities",
    };
    if (id === "feature.draft" || id === "feature.offset") changeSelectionMode("face");
    if (id === "model.pattern" || id === "model.patternCircular" || id === "model.patternRectangular" || id === "model.patternMirror") changeSelectionMode("body");
    if (id === "feature.revolve") changeSelectionMode("face");
    if (id === "project.variables") { setProjectDataMode("variables"); setProjectDataItemId(null); }
    if (id === "project.coordinates") { setProjectDataMode("coordinates"); setProjectDataItemId(null); }
    if (id === "project.materials") { setProjectDataMode("materials"); setProjectDataItemId(null); }
    if (id === "window.closeOperation") setActiveOperation(null);
    else if (operationByCommand[id as CadCommandId]) setActiveOperation(operationByCommand[id as CadCommandId] || null);
  }, [dragModeling, changeDisplayMode, changePanel, changeSelectionMode, createNewProject, exportStepFromMenu, frameViewport, moveHistory, restorePanels, saveProjectFromMenu, setActiveOperation, setStandardView, renderAllBodies]);

  const openProjectData = (mode: ProjectDataMode, id?: string | null, copy = false) => { setProjectDataMode(mode); setProjectDataItemId(copy ? null : id || null); setProjectDataCopyId(copy ? id || null : null); setActiveOperation("projectData"); };
  const deleteProjectData = async (mode: ProjectDataMode, id: string) => {
    if (busy || !modelRef.current) return; setBusy(true); setError(null);
    try { const result = await postCommand({ operation: mode === "variables" ? "variable.delete" : mode === "materials" ? "material.delete" : "coordinate.delete", baseRevision: modelRef.current.revision, inputs: mode === "coordinates" ? { id } : { name: id } }); handleProjectRevision(result as ModelData & { variables: ScalarVariableData[]; materials: MaterialData[]; coordinateSystems: CoordinateSystemData[] }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "数据删除失败"); } finally { setBusy(false); }
  };
  const featureActionFromTree = async (featureId: string, action: "suppress" | "restore" | "delete", ownerBodyId?:string) => {
    if (busy || modelingController.hasPendingMutation() || !modelRef.current) return; setBusy(true); setError(null);
    const request:ModelingCommandInput={operation:`feature.${action}`,inputs:{featureId},baseRevision:modelRef.current.revision};
    const repairOwner={documentId:modelingController.getSnapshot().documentId,stateToken:modelRef.current.stateToken};
    try {const result=await postCommand(request);if(modelingController.getSnapshot().documentId!==repairOwner.documentId)return;displayModel(result); setStatus("特征已更新"); }
    catch (reason) {
      if(modelingController.getSnapshot().documentId!==repairOwner.documentId)return;
      const failed=failedSelectionTarget(reason);
      if(failed){if(ownerBodyId)selectBodyFromTree(ownerBodyId);setFeatureToEdit(featureId);setTreeFeatureRepair({request,...failed,...repairOwner});setTreeRepairEpoch(value=>value+1);setActiveOperation("history");setStatus("特征变化导致引用失效，请在历史输入中修复后整体提交。");}
      else setError(reason instanceof Error ? reason.message : "特征操作失败");
    } finally { setBusy(false); }
  };
  const operationContent = () => {
    if (activeOperation === "nameBeforeSave") return <form className="panel-section" onSubmit={event => { event.preventDefault(); void saveProjectFromMenu(saveName); }}>
      <label className="single-field"><span>工程名称</span><input autoFocus required maxLength={120} value={saveName} onChange={event => setSaveName(event.target.value)} disabled={busy} /></label>
      {saveNameError && <p className="property-error" role="alert">{saveNameError}</p>}
      <div className="exchange-actions"><button type="submit" disabled={busy || saveNameOwner !== controllerState.documentId || !saveName.trim() || saveName.trim() === "未命名工程"}>命名并保存</button><button type="button" disabled={busy} onClick={() => setActiveOperation(null)}>取消</button></div>
    </form>;
    if(activeOperation==='backups')return <ProjectBackupPanel key={controllerState.documentId} documentId={controllerState.documentId} busy={controllerState.busy}/>;
    if(activeOperation==='sources')return <SourceAuditPanel key={controllerState.documentId+':'+sourcePanelView} documentId={controllerState.documentId} stateToken={model?.stateToken??null} initialView={sourcePanelView} geometry={model} blocked={sourceRecoveryBlocked} onModel={result=>{displayModel(result as ModelData,{fitCamera:false});setStatus('工程引用已核对 · R'+result.revision);}} onHistory={featureId=>{setTreeFeatureRepair(null);setFeatureToEdit(featureId??null);setActiveOperation('history');}}/>;
    if(activeOperation==="workspace")return <WorkspacePanel key={controllerState.documentId} current={workspace.project} onChanged={workspace.refresh} onRestore={async id=>{setBusy(true);try{const restored=await modelingController.restoreWorkspace<ModelData>(id);displayModel(restored,{replaceScene:true});setError(null);setStatus("已恢复工程 · R"+restored.revision);setActiveOperation(null);}finally{setBusy(false);}}}/>;
    if (activeOperation === "projectData" && !model) return <p className="panel-copy">请先新建或打开工程，几何服务就绪后即可管理变量、材料和坐标系。</p>;
    if (activeOperation === "generated") return <GeneratedModelingPanel key={generatedKind} kind={generatedKind} model={model} bodyId={selectedBodyId || model?.bodyId || null} faceId={selectedId?.startsWith("face-") ? selectedId : null} onModel={handleDirectModel} />;
    if (activeOperation === "bodyAppearance") { const body = model?.bodyMetadata?.find((item) => item.bodyId === appearanceBodyId); return body ? <BodyAppearancePanel key={body.bodyId} body={{ ...body, topologyRevision: body.topologyRevision || 0 }} materials={(model?.materials || []).map((item) => item.name)} onSave={(id,changes)=>updateBodyFromTree(id,changes,true)} /> : <p className="panel-copy">该 Body 已不存在。</p>; }
    if (activeOperation === "agentSettings") return <AgentProviderSettingsPanel />;
    if (activeOperation === "mesh") return <MeshWorkbenchPanel documentId={controllerState.documentId} geometry={model} revision={model?.revision ?? null} selectedBodyId={selectedBodyId || model?.bodyId || null} selectedFaceId={selectionMode === "face" && selectedId?.startsWith("face-") ? selectedId : null} latestResult={meshResults.at(-1)} onMeshResult={handleMeshResult} tasks={meshTasks} qualitySelection={qualitySelection} onLocateQuality={handleLocateQuality} onLocateCadFace={source=>void locateMeshSourceFace(source)} preparationPreviewId={preparationDisplay?.meshJob.jobId||null} onPreparationPreview={handlePreparationPreview} onLocateDiagnostic={target=>void locateDiagnostic(target)} />;
    if (activeOperation === "agent") return <PiModelingAgentPanel revision={model?.revision ?? null} selection={selectedId && (selectedBodyId || model?.bodyId) ? { kind: selectionMode, bodyId: selectedBodyId || model?.bodyId || "", topologyId: selectionMode === "body" ? undefined : selectedId } : null} onCommitted={(result) => handleDirectModel(result as ModelData)} onOpenSettings={() => setActiveOperation("agentSettings")} />;
    if (activeOperation === "primitives") return <AdvancedModelingPanel key={`${activeTool}:${parameterDraft?.version}`} initialParameters={parameterDraft?.kind === dragPrimitive ? parameterDraft.parameters : {coordinateSystemId:constructionId}} mode="primitive" fixedKind={activeTool?.startsWith("primitive.")} initialPrimitive={activeTool?.startsWith("primitive.") ? activeTool.slice(10) as PrimitiveKind : "box"} model={model} onModel={handleDirectModel} onProjectRevision={handleProjectRevision} onDraftChange={rememberParameterInput} onSwitchToDrag={() => changeModelingMethod(true)} />;
    if (activeOperation === "surfaces") return <AdvancedModelingPanel key={`${activeTool}:${parameterDraft?.version}`} initialParameters={parameterDraft?.kind === dragPrimitive ? parameterDraft.parameters : {coordinateSystemId:constructionId}} mode="surface" fixedKind={activeTool?.startsWith("surface.")} initialSurface={activeTool?.startsWith("surface.") ? activeTool.slice(8) as SurfaceKind : "rectangle"} model={model} onModel={handleDirectModel} onProjectRevision={handleProjectRevision} onDraftChange={rememberParameterInput} onSwitchToDrag={() => changeModelingMethod(true)} />;
    if (activeOperation === "transform") return <AdvancedModelingPanel key={activeTool} mode="transform" initialTransform={activeTool?.startsWith("transform.") ? activeTool.slice(10) as TransformKind : "translate"} model={model ? { ...model, bodyId: selectedBodyId ?? model.bodyId, bodyName: model.bodyMetadata?.find((body) => body.bodyId === (selectedBodyId ?? model.bodyId))?.name } : null} onModel={handleDirectModel} onProjectRevision={handleProjectRevision} />;
    if (activeOperation === "boolean") return <AdvancedBooleanPanel key={activeTool} initialOperation={activeTool?.startsWith("boolean.") ? activeTool.slice(8) as BooleanKind : "cut"} model={model} onModel={handleDirectModel} />;
    if (activeOperation === "fillet") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">FEATURE</span><h2>边圆角</h2></div><span className="feature-badge amber">Fillet</span></div>
        <p className="panel-copy">保持窗口打开，在视口中继续拾取 Edge，然后执行精确圆角。</p>
        <p className="property-target">{selectedId || "尚未选择 Edge"}</p>
        <label className="single-field"><span>圆角半径</span><div className="number-field"><input aria-label="圆角半径" type="number" min="0.1" max="1000" step="0.5" value={filletRadius} onChange={(event) => setFilletRadius(Number(event.target.value))} /><em>mm</em></div></label>
        <button className="secondary-action" onClick={() => void applyFillet()} disabled={busy || !selectedId?.startsWith("edge-")} data-testid="apply-fillet">执行圆角</button>
      </section>
    );
    if (activeOperation === "chamfer") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">FEATURE</span><h2>边倒角</h2></div><span className="feature-badge amber">Chamfer</span></div>
        <p className="panel-copy">保持窗口打开，在视口中拾取 Edge，然后按对称距离创建精确倒角。</p>
        <p className="property-target">{selectedId || "尚未选择 Edge"}</p>
        <label className="single-field"><span>倒角距离</span><div className="number-field"><input aria-label="倒角距离" type="number" min="0.1" max="1000" step="0.5" value={chamferDistance} onChange={(event) => setChamferDistance(Number(event.target.value))} /><em>mm</em></div></label>
        <button className="secondary-action" onClick={() => void applyChamfer()} disabled={busy || !selectedId?.startsWith("edge-")} data-testid="apply-chamfer">执行倒角</button>
      </section>
    );
    if (activeOperation === "measure") {
      const bodyId = selectedBodyId || model?.bodyId;
      const selectionType = measureBodyOnly ? "body" : selectedId?.startsWith("face-") ? "face" : selectedId?.startsWith("edge-") ? "edge" : "body";
      return <MeasurementPanel key={controllerState.documentId} disabled={commandBusy} target={bodyId ? { documentId: controllerState.documentId, bodyId, selectionType, selectionId: selectionType === "body" ? bodyId : selectedId! } : null} onResult={setMeasurement} />;
    }
    if (activeOperation === "shapeCheck") {
      const bodyId = selectedBodyId || model?.bodyId;
      const result = shapeCheckResult?.documentId === controllerState.documentId && shapeCheckResult.bodyId === bodyId && shapeCheckResult.stateToken === controllerState.stateToken ? shapeCheckResult : null;
      return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">ANALYSIS</span><h2>Shape Check</h2></div><span className="feature-badge amber">OCCT</span></div>
        <p className="panel-copy">检查当前 Body 的几何有效性，并统计 Face、Edge 和 Solid 数量。</p>
        <p className="property-target">{bodyId || "尚未选择 Body"}</p>
        <button className="secondary-action" onClick={() => void runShapeCheck()} disabled={commandBusy || !bodyId} data-testid="run-shape-check">运行 Shape Check</button>
        {result && <dl className="model-info"><div><dt>有效性</dt><dd>{result.valid ? "通过" : "失败"}</dd></div><div><dt>Faces</dt><dd>{result.faceCount}</dd></div><div><dt>Edges</dt><dd>{result.edgeCount}</dd></div><div><dt>Solids</dt><dd>{result.solidCount}</dd></div></dl>}
      </section>
      );
    }
    if (activeOperation === "patternMirror") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">MODEL</span><h2>镜像阵列</h2></div><span className="feature-badge amber">Mirror Pattern</span></div>
        <p className="panel-copy">以指定平面为基准镜像当前 Body，保留源 Body 和镜像 Body。</p>
        <p className="property-target">{selectedBodyId || model?.bodyId || "尚未选择 Body"}</p>
        <p className="subsection-label">镜像平面原点</p>
        <div className="compact-fields"><label><span>X</span><input value={mirrorOrigin.x} onChange={(event) => setMirrorOrigin({ ...mirrorOrigin, x: event.target.value })} /></label><label><span>Y</span><input value={mirrorOrigin.y} onChange={(event) => setMirrorOrigin({ ...mirrorOrigin, y: event.target.value })} /></label><label><span>Z</span><input value={mirrorOrigin.z} onChange={(event) => setMirrorOrigin({ ...mirrorOrigin, z: event.target.value })} /></label></div>
        <p className="subsection-label">镜像平面法向</p>
        <div className="compact-fields"><label><span>X</span><input value={mirrorNormal.x} onChange={(event) => setMirrorNormal({ ...mirrorNormal, x: event.target.value })} /></label><label><span>Y</span><input value={mirrorNormal.y} onChange={(event) => setMirrorNormal({ ...mirrorNormal, y: event.target.value })} /></label><label><span>Z</span><input value={mirrorNormal.z} onChange={(event) => setMirrorNormal({ ...mirrorNormal, z: event.target.value })} /></label></div>
        <button className="secondary-action" onClick={() => void applyMirrorPattern()} disabled={busy || !(selectedBodyId || model?.bodyId)} data-testid="apply-pattern-mirror">执行镜像阵列</button>
      </section>
    );
    if (activeOperation === "patternRectangular") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">MODEL</span><h2>矩形阵列</h2></div><span className="feature-badge amber">Rectangular Pattern</span></div>
        <p className="panel-copy">沿两条方向生成二维网格 Body。设置 X/Y 实例数、间距和方向向量。</p>
        <p className="property-target">{selectedBodyId || model?.bodyId || "尚未选择 Body"}</p>
        <div className="compact-fields"><label><span>X 数量</span><input aria-label="矩形阵列 X 数量" value={rectangularCountXExpression} onChange={(event) => setRectangularCountXExpression(event.target.value)} /></label><label><span>Y 数量</span><input aria-label="矩形阵列 Y 数量" value={rectangularCountYExpression} onChange={(event) => setRectangularCountYExpression(event.target.value)} /></label></div>
        <div className="compact-fields"><label><span>X 间距</span><input aria-label="矩形阵列 X 间距" value={rectangularSpacingXExpression} onChange={(event) => setRectangularSpacingXExpression(event.target.value)} /></label><label><span>Y 间距</span><input aria-label="矩形阵列 Y 间距" value={rectangularSpacingYExpression} onChange={(event) => setRectangularSpacingYExpression(event.target.value)} /></label></div>
        <p className="subsection-label">第一方向</p>
        <div className="compact-fields"><label><span>X</span><input value={rectangularDirection1.x} onChange={(event) => setRectangularDirection1({ ...rectangularDirection1, x: event.target.value })} /></label><label><span>Y</span><input value={rectangularDirection1.y} onChange={(event) => setRectangularDirection1({ ...rectangularDirection1, y: event.target.value })} /></label><label><span>Z</span><input value={rectangularDirection1.z} onChange={(event) => setRectangularDirection1({ ...rectangularDirection1, z: event.target.value })} /></label></div>
        <p className="subsection-label">第二方向</p>
        <div className="compact-fields"><label><span>X</span><input value={rectangularDirection2.x} onChange={(event) => setRectangularDirection2({ ...rectangularDirection2, x: event.target.value })} /></label><label><span>Y</span><input value={rectangularDirection2.y} onChange={(event) => setRectangularDirection2({ ...rectangularDirection2, y: event.target.value })} /></label><label><span>Z</span><input value={rectangularDirection2.z} onChange={(event) => setRectangularDirection2({ ...rectangularDirection2, z: event.target.value })} /></label></div>
        <button className="secondary-action" onClick={() => void applyRectangularPattern()} disabled={busy || !(selectedBodyId || model?.bodyId)} data-testid="apply-pattern-rectangular">执行矩形阵列</button>
      </section>
    );
    if (activeOperation === "patternCircular") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">MODEL</span><h2>环形阵列</h2></div><span className="feature-badge amber">Circular Pattern</span></div>
        <p className="panel-copy">绕指定轴复制当前 Body。输入总实例数量、每个实例的旋转角度、旋转中心和轴方向。</p>
        <p className="property-target">{selectedBodyId || model?.bodyId || "尚未选择 Body"}</p>
        <label className="single-field"><span>实例数量</span><div className="number-field"><input aria-label="环形阵列实例数量" value={circularCountExpression} onChange={(event) => setCircularCountExpression(event.target.value)} /><em>count</em></div></label>
        <label className="single-field"><span>实例角度</span><div className="number-field"><input aria-label="环形阵列实例角度" value={circularAngleExpression} onChange={(event) => setCircularAngleExpression(event.target.value)} /><em>deg</em></div></label>
        <p className="subsection-label">旋转中心</p>
        <div className="compact-fields"><label><span>X</span><input value={circularOrigin.x} onChange={(event) => setCircularOrigin({ ...circularOrigin, x: event.target.value })} /></label><label><span>Y</span><input value={circularOrigin.y} onChange={(event) => setCircularOrigin({ ...circularOrigin, y: event.target.value })} /></label><label><span>Z</span><input value={circularOrigin.z} onChange={(event) => setCircularOrigin({ ...circularOrigin, z: event.target.value })} /></label></div>
        <p className="subsection-label">旋转轴方向</p>
        <div className="compact-fields"><label><span>X</span><input value={circularAxis.x} onChange={(event) => setCircularAxis({ ...circularAxis, x: event.target.value })} /></label><label><span>Y</span><input value={circularAxis.y} onChange={(event) => setCircularAxis({ ...circularAxis, y: event.target.value })} /></label><label><span>Z</span><input value={circularAxis.z} onChange={(event) => setCircularAxis({ ...circularAxis, z: event.target.value })} /></label></div>
        <button className="secondary-action" onClick={() => void applyCircularPattern()} disabled={busy || !(selectedBodyId || model?.bodyId)} data-testid="apply-pattern-circular">执行环形阵列</button>
      </section>
    );
    if (activeOperation === "pattern") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">MODEL</span><h2>线性阵列</h2></div><span className="feature-badge amber">Pattern</span></div>
        <p className="panel-copy">沿指定方向复制当前 Body。当前版本支持参数化数量、间距与方向，并在几何树中生成多个 Body。</p>
        <p className="property-target">{selectedBodyId || model?.bodyId || "尚未选择 Body"}</p>
        <label className="single-field"><span>实例数量</span><div className="number-field"><input aria-label="阵列实例数量" list="pattern-count-options" value={patternCountExpression} onChange={(event) => setPatternCountExpression(event.target.value)} /><em>count</em></div></label>
        <datalist id="pattern-count-options">{(model?.variables || []).filter((item) => item.type === "dimensionless").map((item) => <option key={item.name} value={item.name}>{item.expression}</option>)}</datalist>
        <label className="single-field"><span>实例间距</span><div className="number-field"><input aria-label="阵列实例间距" list="pattern-spacing-options" value={patternSpacingExpression} onChange={(event) => setPatternSpacingExpression(event.target.value)} /><em>expr</em></div></label>
        <datalist id="pattern-spacing-options">{(model?.variables || []).filter((item) => item.type === "length").map((item) => <option key={item.name} value={item.name}>{item.expression}</option>)}</datalist>
        <p className="subsection-label">阵列方向</p>
        <div className="compact-fields"><label><span>X</span><input value={patternDirection.x} onChange={(event) => setPatternDirection({ ...patternDirection, x: event.target.value })} /></label><label><span>Y</span><input value={patternDirection.y} onChange={(event) => setPatternDirection({ ...patternDirection, y: event.target.value })} /></label><label><span>Z</span><input value={patternDirection.z} onChange={(event) => setPatternDirection({ ...patternDirection, z: event.target.value })} /></label></div>
        <button className="secondary-action" onClick={() => void applyPattern()} disabled={busy || !(selectedBodyId || model?.bodyId)} data-testid="apply-pattern">执行线性阵列</button>
      </section>
    );
    if (activeOperation === "draft") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">FEATURE</span><h2>拔模</h2></div><span className="feature-badge amber">Draft</span></div>
        <p className="panel-copy">选择可拔模的平面、圆柱面或圆锥面，设置中性面和拔模方向。</p>
        <p className="property-target">{selectedId?.startsWith("face-") ? selectedId : "尚未选择 Face"}</p>
        <label className="single-field"><span>拔模角度</span><div className="number-field"><input aria-label="拔模角度" list="draft-variable-options" value={draftAngleExpression} onChange={(event) => setDraftAngleExpression(event.target.value)} placeholder="数值、单位或变量表达式" /><em>deg</em></div></label>
        <datalist id="draft-variable-options">{(model?.variables || []).filter((item) => item.type === "angle").map((item) => <option key={item.name} value={item.name}>{item.expression}</option>)}</datalist>
        <p className="subsection-label">中性面原点</p>
        <div className="compact-fields"><label><span>X</span><input value={draftNeutralOrigin.x} onChange={(event) => setDraftNeutralOrigin({ ...draftNeutralOrigin, x: event.target.value })} /></label><label><span>Y</span><input value={draftNeutralOrigin.y} onChange={(event) => setDraftNeutralOrigin({ ...draftNeutralOrigin, y: event.target.value })} /></label><label><span>Z</span><input value={draftNeutralOrigin.z} onChange={(event) => setDraftNeutralOrigin({ ...draftNeutralOrigin, z: event.target.value })} /></label></div>
        <p className="subsection-label">中性面法向</p>
        <div className="compact-fields"><label><span>X</span><input value={draftNeutralNormal.x} onChange={(event) => setDraftNeutralNormal({ ...draftNeutralNormal, x: event.target.value })} /></label><label><span>Y</span><input value={draftNeutralNormal.y} onChange={(event) => setDraftNeutralNormal({ ...draftNeutralNormal, y: event.target.value })} /></label><label><span>Z</span><input value={draftNeutralNormal.z} onChange={(event) => setDraftNeutralNormal({ ...draftNeutralNormal, z: event.target.value })} /></label></div>
        <p className="subsection-label">拔模方向</p>
        <div className="compact-fields"><label><span>X</span><input value={draftDirection.x} onChange={(event) => setDraftDirection({ ...draftDirection, x: event.target.value })} /></label><label><span>Y</span><input value={draftDirection.y} onChange={(event) => setDraftDirection({ ...draftDirection, y: event.target.value })} /></label><label><span>Z</span><input value={draftDirection.z} onChange={(event) => setDraftDirection({ ...draftDirection, z: event.target.value })} /></label></div>
        <button className="secondary-action" onClick={() => void applyDraft()} disabled={busy || !selectedId?.startsWith("face-")} data-testid="apply-draft">执行 Draft</button>
      </section>
    );    if (activeOperation === "revolve") return (
      <section className="panel-section">
        <div className="section-heading compact"><div><span className="eyebrow">FEATURE</span><h2>旋转体</h2></div><span className="feature-badge amber">Revolve</span></div>
        <p className="panel-copy">选择一个 Face，绕指定轴旋转生成新的 Body；角度支持数值、单位和变量表达式。</p>
        <p className="property-target">{selectedId?.startsWith("face-") ? selectedId : "尚未选择 Face"}</p>
        <label className="single-field"><span>旋转角度</span><div className="number-field"><input aria-label="旋转角度" list="revolve-angle-options" value={revolveAngleExpression} onChange={(event) => setRevolveAngleExpression(event.target.value)} placeholder="360 deg" /><em>deg</em></div></label>
        <datalist id="revolve-angle-options">{(model?.variables || []).filter((item) => item.type === "angle").map((item) => <option key={item.name} value={item.expression}>{item.name}</option>)}</datalist>
        <p className="subsection-label">旋转轴原点</p>
        <div className="compact-fields"><label><span>X</span><input value={revolveOrigin.x} onChange={(event) => setRevolveOrigin({ ...revolveOrigin, x: event.target.value })} /></label><label><span>Y</span><input value={revolveOrigin.y} onChange={(event) => setRevolveOrigin({ ...revolveOrigin, y: event.target.value })} /></label><label><span>Z</span><input value={revolveOrigin.z} onChange={(event) => setRevolveOrigin({ ...revolveOrigin, z: event.target.value })} /></label></div>
        <p className="subsection-label">旋转轴方向</p>
        <div className="compact-fields"><label><span>X</span><input value={revolveAxis.x} onChange={(event) => setRevolveAxis({ ...revolveAxis, x: event.target.value })} /></label><label><span>Y</span><input value={revolveAxis.y} onChange={(event) => setRevolveAxis({ ...revolveAxis, y: event.target.value })} /></label><label><span>Z</span><input value={revolveAxis.z} onChange={(event) => setRevolveAxis({ ...revolveAxis, z: event.target.value })} /></label></div>
        <button className="secondary-action" onClick={() => void applyRevolve()} disabled={busy || !selectedId?.startsWith("face-")} data-testid="apply-revolve">执行 Revolve</button>
      </section>
    );    if (activeOperation === "offsetFeature") {
      const requiresFace = offsetFeatureKind !== "offset";
      return (
        <section className="panel-section">
          <div className="section-heading compact"><div><span className="eyebrow">FEATURE</span><h2>壳体与偏置</h2></div><span className="feature-badge amber">Offset</span></div>
          <label><span>操作类型</span><select className="operation-select" aria-label="壳体与偏置类型" value={offsetFeatureKind} onChange={(event) => {
            const next = event.target.value as "shell" | "thicken" | "offset";
            setOffsetFeatureKind(next);
            if (next !== "offset") changeSelectionMode("face");
          }}><option value="shell">Shell（抽壳）</option><option value="thicken">Thicken（面加厚为新 Body）</option><option value="offset">Offset（整体偏置）</option></select></label>
          <p className="panel-copy">{offsetFeatureKind === "shell" ? "移除所选 Face，并向内或向外生成实体壁厚。" : offsetFeatureKind === "thicken" ? "将所选 Face 加厚为新 Body，源 Body 保持不变。" : "对当前 Body 执行有符号整体偏置；负值向内。"}</p>
          <p className="property-target">{requiresFace ? (selectedId?.startsWith("face-") ? selectedId : "尚未选择 Face") : (selectedBodyId || model?.bodyId || "尚未选择 Body")}</p>
          <label className="single-field"><span>{offsetFeatureKind === "offset" ? "偏置距离" : "厚度"}</span><div className="number-field"><input aria-label="壳体偏置参数" list="offset-variable-options" value={offsetExpression} onChange={(event) => setOffsetExpression(event.target.value)} placeholder="数值、单位或变量表达式" /><em>expr</em></div></label>
          <datalist id="offset-variable-options">{(model?.variables || []).filter((item) => item.type === "length").map((item) => <option key={item.name} value={item.name}>{item.expression}</option>)}</datalist>
          {offsetFeatureKind !== "offset" && <label className="check-field"><input type="checkbox" checked={offsetReverse} onChange={(event) => setOffsetReverse(event.target.checked)} />{offsetFeatureKind === "shell" ? "向外生成壁厚" : "反向加厚"}</label>}
          <button className="secondary-action" onClick={() => void applyOffsetFeature()} disabled={busy || (requiresFace && !selectedId?.startsWith("face-"))} data-testid="apply-offset-feature">执行 {offsetFeatureKind === "shell" ? "Shell" : offsetFeatureKind === "thicken" ? "Thicken" : "Offset"}</button>
        </section>
      );
    }    if (activeOperation === "exchange") return <StepExchangePanel projectSaveBusy={commandBusy} hasModel={Boolean(model)} onImported={(data) => displayModel(data as ModelData, { replaceScene: true })} onImport={(file) => modelingController.importStep(file)} onExport={() => modelingController.exportStep()} onProjectSave={saveProjectFromMenu} onProjectOpen={(file) => modelingController.openProject(file)} />;
    if (activeOperation === "propertyTypes") return <PropertyTypeManagerPanel key={propertyTypeId === undefined ? "manage" : propertyTypeId === null ? "new" : propertyTypeId} initialTypeId={propertyTypeId} />;
    if (activeOperation === "properties") return (
      <>
        <PropertySchemaPanel key={`${instanceTypeId}:${propertyInstanceId}`} initialTypeId={instanceTypeId} initialInstanceId={propertyInstanceId} selectedTarget={selectedId && (selectedBodyId || model?.bodyId) ? { kind: selectionMode, bodyId: selectedBodyId || model?.bodyId || "", ...(selectionMode === "body" ? {} : { topologyId: selectedId }) } : null} onSelectTarget={selectTargetFromProperty} onSelectTargets={targets=>void selectTargetsFromProperty(targets)} onOpenTypeManager={() => { setPropertyTypeId(undefined); setActiveOperation("propertyTypes"); }} />
        <section className="panel-section model-info">
          <div className="section-heading compact"><div><span className="eyebrow">TOPOLOGY</span><h2>当前拓扑</h2></div></div>
          <dl><div><dt>实体</dt><dd>{model?.bodyCount ?? 0}</dd></div><div><dt>面</dt><dd data-testid="face-count">{model?.stats?.faceCount ?? 0}</dd></div><div><dt>边</dt><dd data-testid="edge-count">{model?.stats?.edgeCount ?? 0}</dd></div><div><dt>三角形</dt><dd>{model?.stats?.triangleCount ?? 0}</dd></div></dl>
        </section>
      </>
    );
    if (activeOperation === "projectData" && model) return <AdvancedProjectDataPanel key={`${projectDataMode}:${projectDataItemId ?? "new"}:${projectDataCopyId}`} mode={projectDataMode} initialItemId={projectDataItemId} copyFromId={projectDataCopyId} editorOnly revision={model.revision} variables={model.variables || []} coordinateSystems={model.coordinateSystems || []} selectedBodyId={selectedBodyId ?? model.bodyId} selectedTopologyId={selectedId} materials={model.materials || []} onRevision={handleProjectRevision} />;
    if (activeOperation === "history") return <FeatureHistoryControls key={`${selectedBodyId ?? model?.bodyId ?? "none"}:${featureToEdit ?? "default"}:${treeRepairEpoch}`} model={model} bodyId={selectedBodyId ?? model?.bodyId ?? null} initialFeatureId={featureToEdit} initialRepair={treeFeatureRepair} onRepairFinished={()=>setTreeFeatureRepair(null)} onModel={handleDirectModel} />;
    return (
      <section className="panel-section capability-list">
        <p><strong>基础体</strong><span>Box、Cylinder、Cone、Sphere、Torus、Wedge、Prism、Pyramid、Tube</span></p>
        <p><strong>基础面</strong><span>Rectangle、Disk、Cylinder、Cone、Sphere（Sheet Body）</span></p>
        <p><strong>变换</strong><span>Translate、Rotate、Mirror Point/Axis/Plane、Uniform/Non-uniform Scale、Coordinate、Align、Copy</span></p>
        <p><strong>Boolean</strong><span>Fuse、Cut、Common、Section、Split、Partition、Fragments、Imprint</span></p>
        <p><strong>特征与数据</strong><span>Fillet、Feature Update、Undo/Redo、STEP、属性实例</span></p>
      </section>
    );
  };

  const body = model?.bodyMetadata?.find(item => item.bodyId === selectedBodyId);
  const selectedPresentation = model?.bodyPresentations?.find(item => item.bodyId === selectedBodyId) ?? (selectedBodyId === model?.bodyId ? model : undefined);
  const details: SelectionDetails = {
    body: body ? { ...body, topologyRevision: body.topologyRevision ?? 0 } : undefined,
    selectionId: selectedId,
    dimensions: boxDimensions(model?.features.findLast(feature => feature.outputBodies.includes(selectedBodyId ?? ""))),
    stats: selectedPresentation?.stats,
  };
  const projectName = workspace.project?.name || "未命名工程";
  const operationDocked = activeOperation !== null && dockedOperations.has(activeOperation);
  const operationEditor = activeOperation && (
    <OperationWindow docked={operationDocked} key={`${activeOperation}:${projectDataMode}`} title={activeOperation === "projectData" ? (projectDataMode === "variables" ? "变量" : projectDataMode === "materials" ? "材料" : "坐标系") : (["primitives", "surfaces", "transform", "boolean"].includes(activeOperation) ? WORKBENCH_TABS.flatMap((tab) => tab.groups.flatMap((group) => group.tools)).find((tool) => tool.id === activeTool)?.label || OPERATION_META[activeOperation].title : OPERATION_META[activeOperation].title)} subtitle={activeOperation === "projectData" ? "工程数据 · 独立编辑窗口" : OPERATION_META[activeOperation].subtitle} onClose={() => setActiveOperation(null)}>
                <CommandEditScope key={editorEpoch} enabled={Boolean(editableOperation)} session={editorSession} onReload={async()=>{const result=await modelingController.execute<ModelData>({operation:"document.view"});if(!modelingController.acceptsState(result))throw new Error("工程又发生了变化，请再次载入。");displayModel(result,{fitCamera:false});resetInlineEditorDrafts();if(["fillet","chamfer","draft","offsetFeature","revolve","generated"].includes(activeOperation)){clearHighlight();setSelectedId(null);setSelectedBodyId(null);setStatus("已重新载入，请在视口中重新选择输入面或边。");}setEditorEpoch(value=>value+1);}}>{operationContent()}</CommandEditScope>
              </OperationWindow>
  );
  const currentMeasurement = measurement?.target.documentId === controllerState.documentId ? measurement : null;
  const documentLog = controllerState.commandLog.filter(entry => entry.documentId === controllerState.documentId);
  const failedCommands = documentLog.filter(entry => entry.status === "error").length;
  const logEntries = documentLog.filter(entry => entry.status === "error" || !["property.type.list", "mesh.strategy.list"].includes(entry.operation)).slice(-12).toReversed();
  const activeSelection = selectedBodyIds.length > 1 ? (selectedBodyIds.length + " 个几何体") : selectionMode === "body" && body ? body.name : selectedId;

  return (
    <main className="cad-shell" data-document-id={controllerState.documentId}>
      <header className="desktop-titlebar">
        <div className="app-identity"><span className="app-mark" aria-hidden="true"><StudioIcon name="box" size={18} /></span><strong>OCCT Web Studio</strong></div>
        <div className="window-document"><button type="button" className="workspace-identity" aria-label="工程名称与恢复" onClick={()=>setActiveOperation("workspace")}><strong>{projectName}{workspace.project?.hasChangesSinceExport ? "*" : ""}</strong><small title={workspace.error || workspace.project?.recoveryWarning || "操作成功后的工程数据可由后台恢复；下载备份是独立文件。"}>R{model?.revision ?? "—"} · {workspace.error ? "工程状态不可用" : workspace.project && !workspace.project.recoverable ? "恢复快照不可用 · 请打开备份" : workspace.project?.recoveryWarning ? "工程已执行异常恢复 · 请核对数据" : workspace.project?.hasChangesSinceExport ? "后台恢复可用 · 有更改未生成备份" : workspace.project ? "备份包已生成 · 此后无新更改" : "正在读取工程状态"}</small></button></div>
        <div className="titlebar-actions" aria-label="常用操作"><button title="保存工程" aria-label="保存工程" disabled={!commandAvailability("file.save").enabled} onClick={() => void handleCommand("file.save")}><StudioIcon name="save" /></button><button title="撤销" aria-label="撤销" disabled={!commandAvailability("edit.undo").enabled} onClick={() => void handleCommand("edit.undo")}><StudioIcon name="undo" /></button><button title="重做" aria-label="重做" disabled={!commandAvailability("edit.redo").enabled} onClick={() => void handleCommand("edit.redo")}><StudioIcon name="redo" /></button><button className={agentOpen ? "active" : ""} aria-pressed={agentOpen} onClick={() => setAgentOpen(!agentOpen)}>AI 助手</button><button aria-label="大模型设置" title="大模型设置" onClick={() => setActiveOperation("agentSettings")}><StudioIcon name="settings" /></button><button aria-label="当前能力" title="当前能力" onClick={() => setActiveOperation("capabilities")}><StudioIcon name="help" /></button></div>
        <div className="window-state" role="status"><span className={`service-led${commandBusy ? " busy" : commandError ? " failed" : ""}`} />{commandBusy ? "正在处理" : commandError ? "操作未完成" : model ? "工作区就绪" : "等待模型"}</div>
      </header>

      <CommandChrome availability={commandAvailability} onCommand={(id) => void handleCommand(id)} />
      <input ref={menuProjectInputRef} type="file" accept=".cadproj,.xbf,application/vnd.webcad.project,application/x-occt-xbf" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void openProjectFromMenu(file); }} />
      <input ref={menuStepInputRef} type="file" accept=".step,.stp,application/step" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importStepFromMenu(file); }} />

      <section className={"workbench" + (agentOpen ? " with-agent" : "")} data-left-dock={panelVisibility.tree || panelVisibility.properties} data-right-dock={agentOpen || panelVisibility.commands} style={{ "--project-dock-width": projectDockWidth + "px" } as React.CSSProperties}>
        <aside className="project-dock split-tree-dock" aria-label="工程树与属性" hidden={!panelVisibility.tree && !panelVisibility.properties}>
          <div className="studio-tree-dock" hidden={!panelVisibility.tree}>
            <ProjectTree projectName={projectName} variables={model?.variables || []} materials={model?.materials || []} coordinates={model?.coordinateSystems || []} types={propertySchema.types} instances={propertySchema.instances} stateToken={propertySchema.stateToken} features={model?.features || []} bodies={model?.bodyMetadata || []} busy={busy} error={propertySchema.error}
            onEditData={openProjectData} onDeleteData={deleteProjectData}
            onEditType={(typeId) => { setPropertyTypeId(typeId); setActiveOperation("propertyTypes"); }}
            onEditInstance={(typeId, instanceId) => { setInstanceTypeId(typeId); setPropertyInstanceId(instanceId); setActiveOperation("properties"); }}
            onSelectTarget={selectTargetFromProperty} onSelectTargets={targets=>void selectTargetsFromProperty(targets)} onError={setError} query={treeQuery} onQuery={setTreeQuery} onHide={() => changePanel("tree", false)} geometry={
              <FeatureTree query={treeQuery} features={model?.features ?? []} bodies={(model?.bodyMetadata || []).map((body) => ({ ...body, topologyRevision: body.topologyRevision || 0 }))}
              activeBodyId={model?.activeBodyId || model?.bodyId || null} selectedBodyId={selectedBodyId} selectedBodyIds={selectedBodyIds}
              onSelectBody={selectBodiesFromTree} onActivateBody={activateBodyFromTree} onEditFeature={editFeatureFromTree} onFeatureAction={featureActionFromTree}
              onDeleteBody={deleteBodyFromTree} deletingBodyId={deletingBodyId} onUpdateBody={updateBodyFromTree}
              onEditBody={(bodyId) => { setAppearanceBodyId(bodyId); setActiveOperation("bodyAppearance"); }}
              onEditMaterial={(name) => openProjectData("materials", name)}
              onManageProperties={(bodyId) => { void selectBodiesFromTree(bodyId); setInstanceTypeId(null); setPropertyInstanceId(undefined); setActiveOperation("properties"); }}
              meshBodyVisibility={meshBodyVisibility} meshBodyPending={pendingMeshBodies} onMeshBodyVisibility={handleMeshBodyVisibility} busy={commandBusy} />
            } />
          </div>
          <PropertiesDock details={details} hidden={!panelVisibility.properties} onClose={() => changePanel("properties", false)} />
        </aside>
        <div
          className="dock-resizer"
          hidden={!panelVisibility.tree && !panelVisibility.properties}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize project tree width"
          aria-valuemin={220}
          aria-valuemax={420}
          aria-valuenow={Math.round(projectDockWidth)}
          tabIndex={0}
          title="Drag to resize; double-click to reset"
          onPointerDown={startDockResize}
          onDoubleClick={() => setProjectDockWidth(302)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); setProjectDockWidth((current) => Math.max(220, current - 16)); }
            if (event.key === "ArrowRight") { event.preventDefault(); setProjectDockWidth((current) => Math.min(420, current + 16)); }
            if (event.key === "Home") { event.preventDefault(); setProjectDockWidth(220); }
            if (event.key === "End") { event.preventDefault(); setProjectDockWidth(420); }
          }}
        />

        <section className={"center-stage" + (!panelVisibility.console ? " messages-hidden" : messagesExpanded ? " messages-expanded" : " messages-collapsed")} style={{ "--output-dock-height": `${outputHeight}px` } as React.CSSProperties}>
          <div className="viewport-toolbar">
            <div className="view-tabs">
              <strong>视图</strong>
              <select className="studio-view-select" aria-label="投影方式" value={projection} disabled={!viewerReady} onChange={event => changeProjectionRef.current(event.target.value as ViewportProjection)}>
                <option value="perspective">透视</option><option value="orthographic">正交</option>
              </select>
              <select className="studio-view-select" aria-label="模型显示模式" value={displayMode} disabled={!viewerReady} onChange={event => changeDisplayMode(event.target.value as ViewportDisplay)}>
                <option value="edges">着色 + 边线</option><option value="shaded">着色</option><option value="wire">线框</option>
              </select>
              <div className="viewport-selection-tools" aria-label="选择过滤器">{(["body", "face", "edge"] as const).map((mode) => <button key={mode} aria-pressed={selectionMode === mode} onClick={() => changeSelectionMode(mode)}>{mode === "body" ? "体" : mode === "face" ? "面" : "边"}</button>)}</div>
              <div className="viewport-selection-tools" aria-label="建模方式">
                <button type="button" aria-keyshortcuts="Alt+M" title={sourceRecoveryBlocked ? "来源事务待复核，请先查看恢复记录" : "拖拽建模 · Alt+M 切换"} aria-pressed={dragModeling} disabled={busy || sourceRecoveryBlocked} onClick={() => changeModelingMethod(true)}>拖拽建模</button>
                <button type="button" aria-keyshortcuts="Alt+M" title={sourceRecoveryBlocked ? "来源事务待复核，请先查看恢复记录" : "参数建模 · Alt+M 切换；保留已拖拽的尺寸"} aria-pressed={!dragModeling} disabled={busy || sourceRecoveryBlocked} onClick={() => changeModelingMethod(false)}>参数建模</button>
              </div>
              {dragModeling && <select className="drag-modeling-kind" aria-label="拖拽建模类型" value={dragPrimitive} disabled={busy || sourceRecoveryBlocked} onChange={(event) => { parameterInputRef.current = null; setParameterDraft(null); setDragPrimitive(event.target.value as GridDragKind); }}>{[["box","长方体"],["cylinder","圆柱体"],["cone","圆锥体"],["sphere","球体"],["torus","圆环体"],["wedge","楔体"],["prism","棱柱"],["pyramid","棱台"],["tube","圆管"],["surface-rectangle","矩形面"],["surface-disk","圆面"],["surface-cylinder","圆柱面"],["surface-cone","圆锥面"],["surface-sphere","球面"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>}
              <ConstructionControls coordinates={constructionCoordinates} selectedId={constructionId} frame={constructionInfo.frame} error={constructionInfo.error} step={snapStep} disabled={commandBusy || sourceRecoveryBlocked || Boolean(activeOperation)} onCoordinate={id=>{cancelDragRef.current();parameterInputRef.current=null;setParameterDraft(null);setConstructionSelection({documentId:controllerState.documentId,id});}} onStep={step=>{cancelDragRef.current();setParameterDraft(null);setSnapStep(step);}} onAlign={alignToConstruction}/>
            </div>
            <div className="view-tools" aria-label="视口工具">
              <button onClick={() => void handleCommand("view.fit")} aria-label="适应窗口" title="适应窗口"><StudioIcon name="fit" /></button>
              <button onClick={() => void handleCommand("view.iso")} aria-label="轴测视图" title="轴测视图"><StudioIcon name="iso" /></button>
              <button onClick={() => void handleCommand("view.screenshot")} disabled={!viewerReady} aria-label="截图" title="保存视口截图 PNG"><StudioIcon name="camera" /></button>
              <button className="render-all-button" onClick={() => void renderAllBodies()} disabled={busy || !model} title="加载全部 Body 的高精度 BRep">全量</button>
              <div className="studio-panel-popover" ref={panelMenuRef}>
                <button type="button" aria-expanded={panelMenuOpen} aria-controls={panelMenuOpen ? "studio-panel-menu" : undefined} aria-label="面板设置" title="显示或隐藏面板" onClick={() => setPanelMenuOpen(open => !open)}><StudioIcon name="columns" /></button>
                {panelMenuOpen && <div id="studio-panel-menu" className="studio-panel-menu">
                  <strong>显示 / 隐藏面板</strong>
                  {Object.entries(studioPanels).map(([id, label]) => <label key={id}><input type="checkbox" checked={panelVisibility[id as StudioPanel] && (id !== "commands" || !agentOpen)} onChange={event => {
                    changePanel(id as StudioPanel, event.target.checked);
                    if (id === "commands" && event.target.checked) setAgentOpen(false);
                  }} />{label}</label>)}
                  <button type="button" className="secondary-action" onClick={restorePanels}>恢复全部面板</button>
                </div>}
              </div>
            </div>
          </div>
          <section className="viewport-panel">
            <SourceRecoveryBanner onBlocked={setSourceRecoveryBlocked} onOpen={()=>{setSourcePanelView('restores');setActiveOperation('sources');}} onReload={async()=>{if(!await restoreOrCreateModel())throw Error('工程尚未成功载入，请先核对后台状态。');}}/>
            <ProjectLoadStatus documentId={controllerState.documentId} active={!sourceRecoveryBlocked&&(!model || commandBusy&&controllerState.pendingOperation==='document.view')}/>
            <div ref={mountRef} className="viewport" tabIndex={0} aria-label="3D 视口" data-testid="cad-viewport" data-projection={projection} data-display-mode={displayMode} onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              if (!dragModeling || dragStage === "idle") setContextMenu({ left: 12, top: 12 });
            }} />
            <span ref={snapMarkerRef} className="construction-snap-marker" aria-hidden="true" />
            <div className="studio-view-cube" aria-label="标准视图">
              <button type="button" onClick={() => void handleCommand("view.top")} aria-label="顶视图" title="顶视图"><StudioIcon name="viewTop" /></button>
              <button type="button" onClick={() => void handleCommand("view.front")} aria-label="前视图" title="前视图"><StudioIcon name="viewFront" /></button>
              <button type="button" onClick={() => void handleCommand("view.right")} aria-label="右视图" title="右视图"><StudioIcon name="viewRight" /></button>
            </div>
            <svg ref={axesRef} className="studio-view-axes" viewBox="-11 -11 90 90" aria-hidden="true">
              {(["X", "Y", "Z"] as const).map(axis => <g key={axis} className={`axis-${axis.toLowerCase()}`}><line x1="34" y1="34" /><text>{axis}</text></g>)}
              <circle cx="34" cy="34" r="3" />
            </svg>
            {preparationDisplay&&<div className="preparation-preview-banner" role="status" aria-label="修复快照预览"><strong>只读修复快照 · 全部几何（含隐藏体）</strong><button type="button" onClick={()=>handlePreparationPreview(null)}>退出预览，返回工程</button></div>}
            {selectionRect && <div className="selection-marquee" style={{ left: selectionRect.left, top: selectionRect.top, width: selectionRect.width, height: selectionRect.height }} aria-hidden="true" />}
            <div className="selection-readout" data-testid="selection-readout"><strong>几何体 {model?.bodyCount ?? 0}</strong><small>面 {model?.stats?.faceCount ?? 0}　边 {model?.stats?.edgeCount ?? 0}</small><span>{selectionMode === "body" ? "体" : selectionMode === "face" ? "面" : "边"}拾取 · {selectedBodyIds.length > 1 ? `${selectedBodyIds.length} 个 Body` : selectedId ?? "未选择"}</span></div>
            {propertySelectionCount.total>0&&<div className="property-selection-readout" role="status" aria-label="属性集合定位"><span>属性关联 · {propertySelectionCount.total} 项 / {propertySelectionCount.visible} 项可见</span><button type="button" onClick={clearHighlight}>清除集合高亮</button></div>}
            {qualitySelection&&<div className="quality-selection-readout" role="status" aria-label="单元定位">
              <div><strong>{qualitySelection.spatial?`空间重叠 · A ${qualitySelection.cell.elementId} ↔ B ${qualitySelection.spatial.peer.elementId}`:`${qualitySelection.topology?meshTopologyLabels[qualitySelection.topology.kind]:'网格单元'} · ${qualitySelection.cell.elementId}`}</strong>
                <span>{assessMeshSource(qualitySelection.source,model,controllerState.documentId).status!=="current"?"来源已过期，定位已隐藏":!diagnosticCellsVisible(qualitySelection,(model?.bodyMetadata||[]).filter(body=>body.visible!==false).map(body=>body.bodyId))?(qualitySelection.spatial?"部分所属 Body 已隐藏，定位已暂停":"所属 Body 已隐藏"):qualitySelection.spatial?"A 红色 · B 黄色 · 不改变几何显示":"透视高亮 · 不改变几何显示"}</span>
              </div><button type="button" onClick={()=>handleLocateQuality(null)}>清除单元定位</button>
            </div>}
            {dragPreview && <div className="drag-modeling-feedback" aria-label="拖拽建模进度">
              <ol className="drag-modeling-steps" aria-label="绘制步骤">{gridDragSteps(dragPrimitive).map((step, index) => <li key={step.stage} aria-current={step.stage === dragStage ? "step" : undefined} data-complete={index < gridDragSteps(dragPrimitive).findIndex(item => item.stage === dragStage)}><span aria-hidden="true">{index + 1}</span>{step.label}</li>)}</ol>
              <div className="drag-dimension-readout" role="status">{gridDragDimensionText(dragPrimitive, dragStage, dragPreview)}</div>
              <span>{gridDragInstruction(dragPrimitive, dragStage)}</span>
              <div><button type="button" onClick={() => changeModelingMethod(false)} title="Alt+M，保留当前尺寸与位置">参数输入</button>{dragStage === "height" && <button type="button" onClick={() => reselectDragBaseRef.current()} title="Backspace，保留起点，重新绘制底面">重选底面</button>}<button type="button" onClick={() => cancelDragRef.current()} title="Esc，不创建几何">取消绘制</button></div>
            </div>}
            <div className="viewport-hint">{dragModeling ? `${constructionInfo.error || gridDragInstruction(dragPrimitive, dragStage)} · ${constructionInfo.frame?.name || constructionId} XY · ${snapStep} mm 吸附 · Alt+M 参数输入 · Esc 取消${dragPrimitive === "tube" ? " · 内半径默认外半径的 60%" : dragPrimitive === "prism" ? " · 默认六棱柱" : ["pyramid", "wedge"].includes(dragPrimitive) ? " · 顶部尺寸默认底部的 50%" : ""}` : "左键点选 / 框选 · 中键旋转 · Shift + 拖动平移 · 滚轮缩放"}</div>
            {contextMenu && <div ref={viewportMenuRef} className="viewport-context-menu" role="menu" aria-label="视口操作" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
              const { key } = event;
              if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return;
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = key === "Home" ? 0 : key === "End" ? items.length - 1 : (current + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}>
              <button type="button" role="menuitem" disabled={commandBusy || !model?.bodyCount} onClick={() => { setContextMenu(null); void renderAllBodies(); }}>全量渲染</button>
              <button type="button" role="menuitem" disabled={!viewerReady || !model?.bodyCount} onClick={() => { setContextMenu(null); void handleCommand("view.fit"); }}>适应窗口</button>
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); changeSelectionMode("body"); }}>体选择 / 框选</button>
              {selectedBodyIds.length > 0 && <button type="button" role="menuitem" disabled={commandBusy || sourceRecoveryBlocked} onClick={() => void hideSelectedBodies()}>隐藏所选 Body</button>}
              <button type="button" role="menuitem" onClick={() => { setContextMenu(null); applyBodySelection([]); }}>清除选择</button>
            </div>}
            {!operationDocked && operationEditor}
          </section>
          <div className="import-output-slot">
            <ModelingTaskStatus key={`task-${controllerState.documentId}`} documentId={controllerState.documentId} tasks={controllerState.modelingTasks} notice={controllerState.modelingTaskNotice} importStatus={controllerState.stepImportStatus} onReconciled={result=>handleDirectModel(result as ModelData)}/>
            <StepImportStatus key={controllerState.documentId} documentId={controllerState.documentId} status={controllerState.stepImportStatus} notice={controllerState.stepImportNotice} stateToken={controllerState.stateToken} onReconciled={result=>handleDirectModel(result as ModelData)}/>
          </div>
          <section className="output-dock studio-pane" aria-label="消息与状态" hidden={!panelVisibility.console}>
            {messagesExpanded && <div className="output-resizer" role="separator" aria-label="调整消息面板高度" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={400} aria-valuenow={outputHeight} tabIndex={0} onPointerDown={(event) => { outputResizeRef.current = {y:event.clientY,height:outputHeight}; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const start=outputResizeRef.current; if(start) setOutputHeight(Math.max(120,Math.min(400, start.height + start.y-event.clientY))); }} onPointerUp={(event) => { outputResizeRef.current=null; if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => {outputResizeRef.current=null;}} onKeyDown={(event) => {if(["ArrowUp","ArrowDown","Home","End"].includes(event.key)){event.preventDefault();setOutputHeight((current) => event.key === "Home" ? 120 : event.key === "End" ? 400 : Math.max(120,Math.min(400,current+(event.key === "ArrowUp"?20:-20))));}}}/>}
            <div className="output-tabs studio-pane-tabs">
              <button type="button" aria-pressed={outputTab === "messages"} aria-expanded={messagesExpanded && outputTab === "messages"} aria-controls="workbench-messages" onClick={() => { setOutputTab("messages"); setMessagesExpanded(outputTab !== "messages" || !messagesExpanded); }}>消息</button>
              <button type="button" aria-pressed={outputTab === "journal"} aria-expanded={messagesExpanded && outputTab === "journal"} aria-controls="workbench-command-log" onClick={() => { setOutputTab("journal"); setMessagesExpanded(outputTab !== "journal" || !messagesExpanded); }}>命令日志{failedCommands > 0 ? ` · ${failedCommands} 条失败记录` : ""}</button>
              <button type="button" aria-pressed={outputTab === "measurements"} aria-expanded={messagesExpanded && outputTab === "measurements"} aria-controls="workbench-measurements" onClick={() => { setOutputTab("measurements"); setMessagesExpanded(outputTab !== "measurements" || !messagesExpanded); }}>测量结果</button>
              {!messagesExpanded && <span className={error ? "message-summary error" : "message-summary"} title={error ?? status}>{error ?? status}</span>}
              <button type="button" className="studio-close-output" title="隐藏消息面板" aria-label="隐藏消息面板" onClick={() => changePanel("console", false)}><StudioIcon name="close" /></button>
            </div>
            <div id="workbench-command-log" hidden={!messagesExpanded || outputTab !== "journal"}><CommandJournal key={controllerState.documentId} entries={documentLog} onClear={clearDocumentJournal} onClearTasks={() => modelingController.clearCompletedModelingTasks()} /></div>
            <div id="workbench-messages" className="studio-messages" hidden={!messagesExpanded || outputTab !== "messages"}>
              <table><thead><tr><th scope="col">时间</th><th scope="col">类型</th><th scope="col">描述</th></tr></thead><tbody>
                <tr><td>—</td><td className={commandError ? "error" : ""}>{commandError ? "失败" : commandBusy ? "处理中" : "信息"}</td><td>{commandError ?? status}{assemblyProgress !== null && <progress aria-label="几何装载进度" value={assemblyProgress} max={100} />}</td></tr>
                {logEntries.map(entry => <tr key={entry.requestId}><td>{new Date(entry.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}</td><td className={entry.status}>{entry.status === "error" ? "失败" : entry.status === "running" ? "执行中" : entry.status === "cancelled" ? "已取消" : "完成"}</td><td>{entry.message ?? entry.operation}</td></tr>)}
              </tbody></table>
            </div>
            <div id="workbench-measurements" className="studio-messages" hidden={!messagesExpanded || outputTab !== "measurements"}>
              {currentMeasurement ? <table><caption>{currentMeasurement.target.selectionId} · R{currentMeasurement.result.revision ?? "—"}{currentMeasurement.stateToken !== controllerState.stateToken ? " · 已过期" : ""}</caption><tbody>{measurementRows(currentMeasurement.result).map(row => <tr key={row.key}><th scope="row">{row.label}</th><td>{row.vector && Array.isArray(row.value) ? row.value.map(value => engineeringNumber(value)).join(", ") : row.text ? String(row.value ?? "—") : engineeringNumber(row.value)} {row.unit}</td></tr>)}</tbody></table> : <p className="studio-empty">使用“测量体 / 面 / 边”获得 BRep 测量结果。</p>}
            </div>
          </section>
        </section>
        <aside className="studio-right-dock" aria-label="右侧工作区" hidden={!agentOpen && !panelVisibility.commands}>
          <CommandDock version={commandTabVersion} details={details} help={activeOperation ? OPERATION_META[activeOperation].subtitle : "从 Ribbon 选择命令。按 Alt+M 在拖拽和参数建模之间切换。"} hidden={!panelVisibility.commands || agentOpen} onClose={() => changePanel("commands", false)}>
            {operationDocked ? operationEditor : activeOperation ? <p className="studio-empty">正在使用 {OPERATION_META[activeOperation].title}。</p> : <div className="studio-command-empty">
              <button type="button" disabled={!commandAvailability("primitive.box").enabled} onClick={() => void handleCommand("primitive.box")}><StudioIcon name="box" size={22} />长方体</button>
              <p>从 Ribbon 选择命令设置参数。</p>
            </div>}
          </CommandDock>
          {agentOpen && <aside className="assistant-dock" aria-label="AI 建模助手"><div className="studio-pane-header"><strong>建模助手</strong><button aria-label="关闭 AI 助手" onClick={() => setAgentOpen(false)}><StudioIcon name="close" /></button></div><PiModelingAgentPanel revision={model?.revision ?? null} selection={selectedId && (selectedBodyId || model?.bodyId) ? { kind: selectionMode, bodyId: selectedBodyId || model?.bodyId || "", topologyId: selectionMode === "body" ? undefined : selectedId } : null} onCommitted={(result) => handleDirectModel(result as ModelData)} onOpenSettings={() => setActiveOperation("agentSettings")} /></aside>}
        </aside>
      </section>

      <footer className="status-bar">
        <span className={`ready-state${commandError && !commandBusy ? " failed" : ""}`}><i />{commandBusy ? "处理中" : commandError ? "操作未完成" : model ? "就绪" : "等待模型"}</span><span>选择: {activeSelection ?? "无"}</span>
        <span>几何体 {model?.bodyCount ?? 0}</span><span>面 {model?.stats?.faceCount ?? 0}</span><span>边 {model?.stats?.edgeCount ?? 0}</span><span>单位: mm</span>
        <span className="status-spacer" /><span>Global · Z 向上</span><span>R{model?.revision ?? 0}</span>
      </footer>
    </main>
  );
}
