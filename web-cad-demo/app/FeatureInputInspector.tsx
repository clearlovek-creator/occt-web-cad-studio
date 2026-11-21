"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { inputEdgeSegments, topologyIndex, type InputPresentation } from "./modeling/feature-input";
import {localizePositions,setViewportPositions,placeViewportObject,viewportSpan} from './model/viewport-coordinates';
import {createViewportFrame} from './model/viewport-frame';

/** A separate historical scene: its temporary topology IDs never enter live CAD selection. */
export function FeatureInputInspector({ presentation, kind, initialIndex = 0, disabled, onSelect, label, highlightedEdges }: {
  presentation: InputPresentation;
  kind?: "face" | "edge";
  initialIndex?: number;
  disabled?: boolean;
  onSelect?: (index: number) => void;
  label?: string;
  highlightedEdges?: string[];
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect), disabledRef = useRef(disabled);
  const loopEdges=useRef<string[]>([]),showLoop=useRef<(edges:string[])=>void>(()=>{}),loopKey=(highlightedEdges||[]).join(',');
  useEffect(()=>{loopEdges.current=loopKey?loopKey.split(','):[];showLoop.current(loopEdges.current);},[loopKey]);
  useEffect(() => { selectRef.current = onSelect; disabledRef.current = disabled; }, [onSelect, disabled]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let local:ReturnType<typeof localizePositions>,localEdges:ReturnType<typeof localizePositions>,segments:ReturnType<typeof inputEdgeSegments>;
    try{const points=presentation.positions.length?presentation.positions:presentation.edges.find(edge=>edge.points.length>=3)?.points||[];const origin=points.length?[points[0],points[1],points[2]] as const:[0,0,0] as const;local=localizePositions(presentation.positions,origin);segments=inputEdgeSegments(presentation.edges);localEdges=localizePositions(segments.positions,origin);}
    // eslint-disable-next-line react-hooks/set-state-in-effect
    catch{setError('历史输入的显示坐标无效或局部跨度过大；工程未修改。');return;}
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    // The renderer is an external GPU resource and cannot be constructed during render.
    catch { setError("无法创建临时几何视图，请关闭其他占用显卡的页面后重试。"); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe5e9ee);
    const camera = new THREE.PerspectiveCamera(40, 1, .01, 100000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    let renderedFrames=0;
    mount.dataset.frameMode='on-demand';mount.dataset.viewportRenderFrames='0';
    const frames=createViewportFrame({draw:()=>{const changing=controls.update();renderer.render(scene,camera);mount.dataset.viewportRenderFrames=String(++renderedFrames);return changing;}});
    const invalidate=()=>frames.invalidate();
    controls.addEventListener('change',invalidate);
    frames.setPaused(document.visibilityState==='hidden');
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(local.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(presentation.normals, 3));
    geometry.setIndex(presentation.indices);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!.clone();
    // Imported path Bodies can contain only Edges. Frame their real polylines
    // instead of an empty Face bounding box (Infinity/NaN camera coordinates).
    if(box.isEmpty())for(const edge of presentation.edges)for(let i=0;i<edge.points.length;i+=3)box.expandByPoint(new THREE.Vector3(edge.points[i]-local.origin[0],edge.points[i+1]-local.origin[1],edge.points[i+2]-local.origin[2]));
    box.translate(new THREE.Vector3(...local.origin));
    const center = box.getCenter(new THREE.Vector3());
    const extent = viewportSpan(box.getSize(new THREE.Vector3()).length());
    camera.position.copy(center).add(new THREE.Vector3(1.3, -1.7, 1.2).normalize().multiplyScalar(extent * 1.8));
    camera.near = Math.max(extent / 10000, 1e-12); camera.far = extent * 100;
    camera.updateProjectionMatrix(); controls.target.copy(center); controls.update();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({color: 0x8196ad, roughness: .8, side: THREE.DoubleSide}));
    placeViewportObject(mesh,local.origin);
    scene.add(mesh, new THREE.AmbientLight(0xffffff, 2.4));
    const light = new THREE.DirectionalLight(0xffffff, 2.7); light.position.copy(center).add(new THREE.Vector3(extent, -extent, extent * 2)); scene.add(light);
    const edgeGeometry = new THREE.BufferGeometry();edgeGeometry.setAttribute('position',new THREE.BufferAttribute(localEdges.positions,3));
    const lines = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({color: 0x34495e}));placeViewportObject(lines,local.origin);scene.add(lines);
    let highlight: THREE.Mesh | THREE.LineSegments | null = null;
    let loopHighlight:THREE.LineSegments|null=null;
    const disposeLoop=()=>{if(!loopHighlight)return;scene.remove(loopHighlight);loopHighlight.geometry.dispose();(loopHighlight.material as THREE.Material).dispose();loopHighlight=null;};
    const renderLoop=(edges:string[])=>{
      invalidate();
      disposeLoop();const wanted=new Set(edges.map(topologyIndex)),points:number[]=[];
      segments.topology.forEach((id,index)=>{if(wanted.has(id))points.push(...segments.positions.slice(index*6,index*6+6));});
      mount.dataset.highlightedLoopEdges=String(wanted.size);if(!points.length)return;
      const selectedGeometry=new THREE.BufferGeometry();setViewportPositions(selectedGeometry,points,local.origin);
      const accent=getComputedStyle(mount).getPropertyValue('--cad-accent').trim()||'#0067b8';
      loopHighlight=new THREE.LineSegments(selectedGeometry,new THREE.LineBasicMaterial({color:accent,depthTest:false}));placeViewportObject(loopHighlight,local.origin);loopHighlight.renderOrder=6;scene.add(loopHighlight);
    };
    showLoop.current=renderLoop;renderLoop(loopEdges.current);
    const disposeHighlight = () => { if (!highlight) return; scene.remove(highlight); highlight.geometry.dispose(); (highlight.material as THREE.Material).dispose(); highlight = null; };
    const select = (index: number) => {
      invalidate();
      disposeHighlight(); mount.dataset.selectedIndex = String(index);
      if (!index) return;
      const points: number[] = [];
      if (kind === "face") {
        presentation.triangleFaceIds.forEach((id, triangle) => {
          if (topologyIndex(id) !== index) return;
          for (const vertex of presentation.indices.slice(triangle * 3, triangle * 3 + 3)) points.push(...presentation.positions.slice(vertex * 3, vertex * 3 + 3));
        });
        const selectedGeometry = new THREE.BufferGeometry();setViewportPositions(selectedGeometry,points,local.origin);
        highlight = new THREE.Mesh(selectedGeometry, new THREE.MeshBasicMaterial({color: 0xffb941, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: .8}));
      } else {
        segments.topology.forEach((id, segment) => { if (id === index) points.push(...segments.positions.slice(segment * 6, segment * 6 + 6)); });
        const selectedGeometry = new THREE.BufferGeometry();setViewportPositions(selectedGeometry,points,local.origin);
        highlight = new THREE.LineSegments(selectedGeometry, new THREE.LineBasicMaterial({color: 0xffa000, depthTest: false}));
      }
      placeViewportObject(highlight,local.origin);highlight.renderOrder = 5; scene.add(highlight);
    };
    select(initialIndex);
    const ray = new THREE.Raycaster();
    let contextLost = false;
    const pick = (event: PointerEvent) => {
      if (event.button !== 0 || contextLost || disabledRef.current || !kind) return;
      const rect = renderer.domElement.getBoundingClientRect();
      camera.updateMatrixWorld(); scene.updateMatrixWorld(true);
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      const faceHit = ray.intersectObject(mesh, false)[0];
      let index = 0;
      if (kind === "face" && faceHit?.faceIndex != null) index = topologyIndex(presentation.triangleFaceIds[faceHit.faceIndex]);
      if (kind === "edge") {
        const pixelSize = 2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / rect.height;
        ray.params.Line.threshold = pixelSize * 5;
        const hit = ray.intersectObject(lines, false).find(item => !faceHit || item.distance <= faceHit.distance + pixelSize * 6);
        if (hit?.index != null) index = segments.topology[Math.floor(hit.index / 2)] || 0;
      }
      if (index) { select(index); selectRef.current?.(index); }
    };
    const candidates = [...new Set(kind === "face" ? presentation.triangleFaceIds.map(topologyIndex) : segments.topology)].sort((a,b)=>a-b);
    const keyboardPick = (event: KeyboardEvent) => {
      if (!kind || contextLost || disabledRef.current || !["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const previous = candidates.indexOf(Number(mount.dataset.selectedIndex || 0));
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const index = candidates[previous < 0 ? (direction > 0 ? 0 : candidates.length - 1) : (previous + direction + candidates.length) % candidates.length];
      if (index) {select(index); selectRef.current?.(index);}
    };
    const resize = () => {
      const width = Math.max(mount.clientWidth, 1), height = Math.max(mount.clientHeight, 1);
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height);
      invalidate();
    };
    mount.appendChild(renderer.domElement); resize();
    const observer = new ResizeObserver(resize); observer.observe(mount);
    renderer.domElement.addEventListener("pointerup", pick);
    renderer.domElement.addEventListener("contextmenu", event => event.preventDefault());
    const lost = (event: Event) => { event.preventDefault(); contextLost = true;frames.setPaused(true); selectRef.current?.(0); mount.dataset.contextState = "lost"; setError("临时视图已中断，请重新读取历史输入；未修改工程。"); };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    mount.dataset.contextState = "ready";
    const onVisible=()=>frames.setPaused(document.visibilityState==='hidden'||contextLost);
    document.addEventListener('visibilitychange',onVisible);
    invalidate();
    const verify = () => {
      // The same projection/pixels as the real canvas, used by browser acceptance tests.
      camera.updateMatrixWorld();
      const candidates = presentation.edges.map(edge => { const point = new THREE.Vector3(); for(let n=0;n<edge.points.length;n+=3)point.add(new THREE.Vector3(edge.points[n],edge.points[n+1],edge.points[n+2]));point.divideScalar(edge.points.length/3).project(camera); return {index: topologyIndex(edge.edgeId), x:(point.x+1)*mount.clientWidth/2, y:(1-point.y)*mount.clientHeight/2}; });
      mount.dataset.edgeScreenPoints = JSON.stringify(candidates);
      const faces = new Map<number,{point:THREE.Vector3;count:number}>();
      presentation.triangleFaceIds.forEach((id,triangle)=>{const index=topologyIndex(id),entry=faces.get(index)||{point:new THREE.Vector3(),count:0};for(const vertex of presentation.indices.slice(triangle*3,triangle*3+3)){entry.point.add(new THREE.Vector3(...presentation.positions.slice(vertex*3,vertex*3+3) as [number,number,number]));entry.count++;}faces.set(index,entry);});
      mount.dataset.faceScreenPoints = JSON.stringify([...faces.entries()].map(([index,entry])=>{const point=entry.point.divideScalar(entry.count).project(camera);return {index,x:(point.x+1)*mount.clientWidth/2,y:(1-point.y)*mount.clientHeight/2};}));
      const wasVisible=highlight?.visible;
      const loopWasVisible=loopHighlight?.visible;
      try {
        if(highlight)highlight.visible=false;if(loopHighlight)loopHighlight.visible=false;renderer.render(scene,camera);
        const gl = renderer.getContext(), pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
        gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if(highlight)highlight.visible=wasVisible ?? true;if(loopHighlight)loopHighlight.visible=loopWasVisible??true;renderer.render(scene,camera);
        const selected=new Uint8Array(pixels.length);gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,selected);
        let count=0;for(let n=0;n<pixels.length;n+=4)if(Math.abs(selected[n]-pixels[n])+Math.abs(selected[n+1]-pixels[n+1])+Math.abs(selected[n+2]-pixels[n+2])>30)count++;
        mount.dataset.highlightPixels = String(count);
        // Verify the inner-loop overlay independently of the selected Face.
        // A large amber Face must not make a missing blue loop look tested.
        let loopPixels=0;
        if(loopHighlight && loopWasVisible){
          loopHighlight.visible=false;renderer.render(scene,camera);
          const withoutLoop=new Uint8Array(pixels.length);gl.readPixels(0,0,renderer.domElement.width,renderer.domElement.height,gl.RGBA,gl.UNSIGNED_BYTE,withoutLoop);
          for(let n=0;n<selected.length;n+=4)if(Math.abs(selected[n]-withoutLoop[n])+Math.abs(selected[n+1]-withoutLoop[n+1])+Math.abs(selected[n+2]-withoutLoop[n+2])>30)loopPixels++;
        }
        mount.dataset.loopHighlightPixels=String(loopPixels);
      } finally { if(highlight)highlight.visible=wasVisible ?? true;if(loopHighlight)loopHighlight.visible=loopWasVisible??true;renderer.render(scene,camera); }
    };
    mount.addEventListener("cad:verify-feature-input", verify);
    mount.addEventListener("keydown", keyboardPick);
    return () => {
      frames.dispose();document.removeEventListener('visibilitychange',onVisible);controls.removeEventListener('change',invalidate);observer.disconnect();controls.dispose();
      mount.removeEventListener("cad:verify-feature-input", verify); mount.removeEventListener("keydown", keyboardPick); renderer.domElement.removeEventListener("pointerup", pick); renderer.domElement.removeEventListener("webglcontextlost", lost);
      if(showLoop.current===renderLoop)showLoop.current=()=>{};
      disposeLoop();disposeHighlight(); geometry.dispose(); edgeGeometry.dispose(); (mesh.material as THREE.Material).dispose(); (lines.material as THREE.Material).dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [presentation, kind, initialIndex]);
  return <div className="feature-input-canvas" ref={mountRef} tabIndex={kind ? 0 : -1} data-testid="feature-input-canvas" data-presentation-body={presentation.bodyId} aria-label={label || (kind ? `历史输入${kind === "face" ? "面" : "边"}选择视图；方向键切换候选` : "重算结果预览")}>{error && <p role="alert">{error}</p>}</div>;
}
