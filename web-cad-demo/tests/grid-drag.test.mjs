import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../app/modeling/grid-drag.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { makeGridDragCommand, needsDragHeight, heightFromScreenDrag, hasDragFootprintMovement, hasDragHeightMovement, hasDragHeightAdjustment, shouldSwitchModelingMethod, gridDragInstruction, gridDragSteps, gridDragHeightReference, gridDragDimensionLabel, gridDragDimensionText } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("height confirmation ignores perpendicular motion, negative height and top-view horizontal motion", () => {
  for (const [dx,dy] of [[80,0],[0,80],[2,-3],[NaN,-20]]) assert.equal(hasDragHeightAdjustment(dx,dy,0,0),false);
  assert.equal(hasDragHeightAdjustment(80,-4,0,0),true);
  // Projected construction Z points diagonally right/up; motion orthogonal to
  // that axis is not evidence that the user selected a height.
  assert.equal(hasDragHeightAdjustment(80,60,.6,-.8),false);
  assert.equal(hasDragHeightAdjustment(-30,40,.6,-.8),false);
  assert.equal(hasDragHeightAdjustment(3,-4,.6,-.8),true);
  assert.equal(hasDragHeightAdjustment(3,-4,6,-8),true,'Zoom must not change the screen-distance threshold');
  assert.equal(hasDragHeightAdjustment(0,-20,Infinity,0),false);
});

test("landing-click jitter cannot lock a footprint even if snapping crosses a grid cell", () => {
  for (const [x,y] of [[0,0],[1,1],[2,3],[NaN,10],[10,Infinity]]) assert.equal(hasDragFootprintMovement(x,y),false);
  for (const [x,y] of [[0,4],[4,0],[-4,0],[3,-3]]) assert.equal(hasDragFootprintMovement(x,y),true);
});

test("visible construction steps match the two- or three-stage tool lifecycle", () => {
  assert.deepEqual(gridDragSteps("box"), [{stage:"idle",label:"起点"},{stage:"base",label:"底面"},{stage:"height",label:"高度"}]);
  assert.deepEqual(gridDragSteps("surface-disk"), [{stage:"idle",label:"中心"},{stage:"base",label:"半径"}]);
  assert.equal(gridDragSteps("torus").at(-1).label, "管半径");
  assert.equal(gridDragSteps("surface-rectangle").length, 2);
});

test("height confirmation requires intentional movement, not double-click jitter", () => {
  for (const [x,y] of [[0,0],[1,1],[0,3.99],[NaN,10],[10,Infinity]]) assert.equal(hasDragHeightMovement(x,y),false);
  for (const [x,y] of [[0,4],[4,0],[-4,0],[3,-3]]) assert.equal(hasDragHeightMovement(x,y),true);
});

test("Alt+M works inside primitive inputs, but never steals IME or unrelated text editing", () => {
  const event={code:"KeyM",altKey:true,ctrlKey:false,metaKey:false,repeat:false,isComposing:false,editable:false,inPrimitiveEditor:false};
  assert.equal(shouldSwitchModelingMethod(event),true);
  assert.equal(shouldSwitchModelingMethod({...event,editable:true,inPrimitiveEditor:true}),true);
  for (const change of [{editable:true},{isComposing:true},{repeat:true},{ctrlKey:true},{metaKey:true},{altKey:false},{code:"KeyN"}]) assert.equal(shouldSwitchModelingMethod({...event,...change}),false);
});

test("drag dimension labels match the active construction stage and shape", () => {
  for (const kind of ["sphere", "surface-sphere", "disk", "surface-disk"]) assert.equal(gridDragDimensionLabel(kind, "base"), "半径");
  assert.equal(gridDragDimensionLabel("surface-rectangle", "base"), "平面范围");
  assert.equal(gridDragDimensionLabel("box", "base"), "底面");
  assert.equal(gridDragDimensionLabel("box", "height"), "高度");
  assert.equal(gridDragDimensionLabel("torus", "height"), "管半径");
});

test("radial readouts show the actual radius, not a diameter labelled as radius", () => {
  const preview = { width: 40, depth: 40, height: 3 };
  assert.equal(gridDragDimensionText("sphere", "base", preview), "半径 · 20 mm");
  assert.equal(gridDragDimensionText("surface-disk", "base", preview), "半径 · 20 mm");
  assert.equal(gridDragDimensionText("surface-rectangle", "base", preview), "平面范围 · 40 × 40 mm");
  assert.equal(gridDragDimensionText("torus", "height", preview), "管半径 · 3 mm · 主半径 20 mm");
  assert.equal(gridDragDimensionText("box", "height", preview), "高度 · 40 × 40 × 3 mm");
});

test("height projects through the rectangular center or radial origin, never the radius midpoint", () => {
  const start = {x: 10, y: 20}, end = {x: 90, y: 60};
  for (const kind of ["box", "wedge", "pyramid", "surface-rectangle"]) {
    assert.deepEqual(gridDragHeightReference(kind, start, end), {x: 50, y: 40});
  }
  for (const kind of ["cylinder", "cone", "tube", "torus", "prism", "surface-cylinder", "surface-cone"]) {
    assert.deepEqual(gridDragHeightReference(kind, start, end), start);
  }
  const reference = gridDragHeightReference("cylinder", start, end);
  reference.x = 0;
  assert.equal(start.x, 10, "Reference calculation must not mutate the drawing anchor");
});

test("drag instructions distinguish footprint, planar/radial completion and torus tube radius", () => {
  assert.match(gridDragInstruction("box", "idle"), /1\/3.*起点/);
  assert.match(gridDragInstruction("box", "base"), /2\/3.*底面.*锁定/);
  assert.match(gridDragInstruction("box", "height"), /3\/3.*高度/);
  assert.match(gridDragInstruction("torus", "height"), /管半径/);
  assert.match(gridDragInstruction("surface-rectangle", "base"), /2\/2.*平面范围.*完成/);
  assert.match(gridDragInstruction("sphere", "base"), /2\/2.*半径.*完成/);
});

test("grid drag makes a box at the footprint corner with snapped dimensions and stable default height", () => {
  const command = makeGridDragCommand("box", { x: 40, y: -20 }, { x: -40, y: 60 });
  assert.equal(command.operation, "primitive.box");
  assert.deepEqual(command.parameters, { width: 80, depth: 80, height: 20, x: -40, y: -20, z: 0, coordinateSystemId: "global", reset: false });
  assert.deepEqual(command.preview, { width: 80, depth: 80, x: 0, y: 20, height: 20 });
});

test("height follows the projected Z axis and remains usable in top view", () => {
  assert.equal(heightFromScreenDrag(0, -80, 0, -2, 1), 40);
  assert.equal(heightFromScreenDrag(30, -40, .6, -.8, 1), 50);
  assert.equal(heightFromScreenDrag(0, -40, 0, 0, 2), 80);
  assert.equal(heightFromScreenDrag(0, 40, 0, 0, 2), 1);
  assert.equal(makeGridDragCommand("box", {x:0,y:0}, {x:NaN,y:2}), null);
});

test("round primitives use a center-to-rim radius and an independently chosen height", () => {
  const command = makeGridDragCommand("cylinder", { x: 20, y: 40 }, { x: 80, y: 40 }, 1, 55);
  assert.equal(command.operation, "primitive.cylinder");
  assert.deepEqual(command.parameters, { radius: 60, height: 55, x: 20, y: 40, z: 0, coordinateSystemId: "global", reset: false });
  assert.deepEqual(command.preview, { width: 120, depth: 120, x: 20, y: 40, height: 55 });
});

test("grid drag rejects zero or sub-grid footprints", () => {
  assert.equal(makeGridDragCommand("box", { x: 0, y: 0 }, { x: 20, y: 0 }), null);
  assert.equal(makeGridDragCommand("disk", { x: 0, y: 0 }, { x: 0, y: 0 }), null);
  assert.equal(makeGridDragCommand("disk", { x: 0, y: 0 }, { x: 20, y: 0 })?.parameters.radius, 20);
});

test("adjacent decimal grid points create a one-step footprint", () => {
  const command = makeGridDragCommand("box", {x: .2, y: -.5}, {x: .3, y: -.4}, .1, .1);
  assert.equal(command.parameters.width, .1);
  assert.equal(command.parameters.depth, .1);
});

test("an exact geometry anchor survives a mixed grid footprint and permits sub-grid geometry dimensions", () => {
  const start = { x: .25, y: .625, snap: "endpoint" };
  const end = { x: 3, y: 2 };
  const box = makeGridDragCommand("box", start, end, 1, 2);
  assert.equal(box.parameters.x, .25);
  assert.equal(box.parameters.y, .625);
  assert.equal(box.parameters.width, 2.75);
  assert.equal(box.parameters.depth, 1.375);
  assert.equal(box.preview.width, box.parameters.width);
  assert.equal(box.preview.depth, box.parameters.depth);
  const disk = makeGridDragCommand("surface-disk", start, { x: .5, y: .625, snap: "midpoint" }, 1);
  assert.equal(disk.parameters.radius, .25);
  assert.equal(makeGridDragCommand("box", start, { ...start, x: 5 }, 1), null);
});

test("center-based rectangle and pyramid constructors keep the same footprint as their drag preview",()=>{
  for(const kind of ["surface-rectangle","pyramid"]){const command=makeGridDragCommand(kind,{x:40,y:50},{x:-20,y:-10});assert.equal(command.parameters.x,10);assert.equal(command.parameters.y,20);assert.equal(command.preview.x,10);assert.equal(command.preview.y,20);}
});

test("all nine solids and five surfaces produce valid drag commands", () => {
  for (const kind of ["box", "cylinder", "cone", "sphere", "torus", "wedge", "prism", "pyramid", "tube", "surface-rectangle", "surface-disk", "surface-cylinder", "surface-cone", "surface-sphere"]) {
    const command = makeGridDragCommand(kind, { x: -40, y: -30 }, { x: 20, y: 10 }, 1, 35);
    assert.ok(command, kind); assert.equal(command.parameters.reset, false);
    assert.equal(command.operation, kind.startsWith("surface-") ? kind.replace("-", ".") : `primitive.${kind}`);
    for (const [key, value] of Object.entries(command.parameters)) if (typeof value === "number") assert.ok(Number.isFinite(value), `${kind}.${key}`);
  }
  assert.equal(needsDragHeight("sphere"), false); assert.equal(needsDragHeight("surface-disk"), false); assert.equal(needsDragHeight("box"), true);
  assert.equal(makeGridDragCommand("box", {x:0,y:0}, {x:10,y:12}, 1, 64).parameters.height, 64);
});
