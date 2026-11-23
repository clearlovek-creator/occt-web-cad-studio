import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("viewer disables cast shadows and uses a depth-safe face highlight", async () => {
  const source = await readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8");
  assert.match(source, /renderer\.shadowMap\.enabled = false/);
  assert.doesNotMatch(source, /castShadow = true/);
  assert.match(source, /depthWrite: false/);
  assert.match(source, /polygonOffsetFactor: -2/);
  assert.match(source, /const selectionColor = 0xffb14a/);
  assert.match(source, /const selectionEmissive = 0x3a1b00/);
  assert.doesNotMatch(source, /0x63a9d8|0x10283a/);
  assert.match(source, /color: selectionColor/);
  assert.match(source, /setHex\(selectionColor\)/);
});


test("mesh visibility follows Body presentation while topology and used materials invalidate stale meshes", async () => {
  const source = await readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8");
  const policy = await readFile(new URL("../app/model/mesh-display-source.ts", import.meta.url), "utf8");
  assert.match(source, /assessMeshDisplaySource\(item,/);
  assert.match(source, /assessMeshDisplaySource\(latest,/);
  assert.match(policy, /assessMeshSource\(result.meshJob.source,view,documentId\)/);
  assert.match(policy, /assessMeshMaterialSource\(result.derivedMaterialSource,view,result.meshJob.source\)/);
  assert.match(policy, /geometry.status!=='current'/);
  assert.doesNotMatch(source, /item\.meshJob\.revision === modelRef\.current\?\.revision/);
  assert.match(source, /renderedMeshGroups/);
  assert.match(source, /renderMeshResults\(next\)/);
});

test("Geometry tree exposes one Body-level mesh visibility control", async () => {
  const [source, tree, css] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /meshBodyVisibility=\{meshBodyVisibility\}/);
  assert.match(source, /onMeshBodyVisibility=\{handleMeshBodyVisibility\}/);
  assert.match(tree, /body-mesh-visibility-button/);
  assert.match(tree, /meshBodyVisibility/);
  assert.doesNotMatch(tree, /body-mesh-tree/);
  assert.match(css, /body-mesh-visibility-button/);
});
test("workbench uses command chrome and modeless operation windows without a right inspector", async () => {
  const [source, css, operationWindow, commandChrome, registry] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench/OperationWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench/CommandChrome.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
  ]);
  for (const region of ["desktop-titlebar", "project-dock", "center-stage", "output-dock", "status-bar"]) {
    assert.match(source, new RegExp(region));
    assert.match(css, new RegExp("\\." + region + "\\b"));
  }
  assert.match(source, /<CommandChrome/);
  assert.match(source, /<OperationWindow/);
  assert.doesNotMatch(source, /className="inspector-dock"/);
  assert.match(operationWindow, /aria-modal="false"/);
  assert.match(operationWindow, /setPointerCapture/);
  assert.doesNotMatch(commandChrome, /CAD_MENUS|menu-bar/);
  assert.match(commandChrome, /WORKBENCH_TABS/);
  assert.match(registry, /model\.primitives/);
  assert.match(registry, /model\.surfaces/);
  assert.match(registry, /model\.boolean/);
  assert.match(registry, /edit\.undo/);
});
test("primitive buttons open a fixed type and the workbench has no classic menus", async () => {
  const [source, primitivePanel, commandChrome] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AdvancedModelingPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench/CommandChrome.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(primitivePanel, /type Primitive = "box"/);
  assert.match(primitivePanel, /initialPrimitive/);
  assert.match(primitivePanel, /hidden=\{fixedKind\}/);
  assert.doesNotMatch(source, /data-testid="create-box"/);
  assert.match(commandChrome, /className="ribbon-tools"/);
  assert.doesNotMatch(commandChrome, /menu-bar|setOpenMenu/);
});
test("project and geometry trees expand and scope feature history by body", async () => {
  const [source, metadataPanels, featureGraph, historyControls] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/FeatureHistoryControls.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<ProjectTree/);
  assert.match(source, /split-tree-dock/);
  assert.match(source, /onSelectBody=\{selectBodiesFromTree\}/);
  assert.match(source, /renderAllBodies/);
  assert.match(metadataPanels, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(metadataPanels, /data-body-id=\{body\.bodyId\}/);
  assert.match(metadataPanels, /bodyExpanded && renderHistory\(history, body\.bodyId\)/);
  assert.match(metadataPanels, /aria-expanded=\{bodyExpanded\}/);
  assert.match(metadataPanels, /onDoubleClick=\{\(\) => onEditFeature\(ownerBodyId, feature\.id\)\}/);
  assert.match(metadataPanels, /featureTypeLabel\(feature\.type\)/);
  assert.match(metadataPanels, /bodyDisplayName\(body\.bodyId, features\)/);
  assert.match(metadataPanels, /onDeleteBody\(body\.bodyId\)/);
  assert.match(metadataPanels, /label: "删除 Body", danger: true/);
  assert.match(featureGraph, /feature\.outputBodies\.includes\(bodyId\)/);
  assert.match(featureGraph, /feature\.inputFeatures\.forEach\(visit\)/);
  assert.match(historyControls, /traceBodyFeatures\(model\?\.features \|\| \[\], bodyId\)/);
  assert.match(historyControls, /initialFeatureId/);
});
test("workbench typography keeps tree, form and status text readable", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /body \{ font-size: 13px; \}/);
  assert.match(css, /\.tree-row \{ min-height: 25px; font-size: 12px; \}/);
  assert.match(css, /\.section-heading h2 \{ font-size: 14px; \}/);
  assert.match(css, /\.number-field, \.property-form input/);
  assert.match(css, /\.status-bar \{ font-size: 10px; \}/);
});
test("geometry tree uses readable contrast for Body, Feature and action states", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.body-tree-node\.selected\s*\{[\s\S]*background: #245064/);
  assert.match(css, /\.body-tree-label strong\s*\{[\s\S]*font-size: 12px/);
  assert.match(css, /\.body-tree-actions button\s*\{[\s\S]*background: #1b3442/);
  assert.match(css, /\.feature-tree \.body-feature-list strong\s*\{[\s\S]*font-size: 10px/);
});test("Body names and property editors use current light control tokens", async () => {
  const css = await readFile(new URL("../app/workbench/workbench.css", import.meta.url), "utf8");
  assert.match(css, /color-scheme: light/);
  assert.match(css, /--cad-text: #202c3a/);
  assert.match(css, /background: var\(--cad-inset\); color: var\(--cad-text\)/);
  assert.match(css, /\.body-tree-label strong/);
  assert.match(css, /\.schema-value-field/);
});test("material library is exposed in project data and body assignment uses it", async () => {
  const [source, projectDataPanel, metadataPanels, registry, appearance] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AdvancedProjectDataPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench/BodyAppearancePanel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /project\.materials/);
  assert.match(source, /materials=\{model\.materials/);
  assert.match(projectDataPanel, /material\.set/);
  assert.match(projectDataPanel, /material\.delete/);
  assert.match(projectDataPanel, /mode === "materials"/);
  assert.match(metadataPanels, /export \{BodyAppearancePanel\} from '.\/workbench\/BodyAppearancePanel'/);
  assert.match(appearance, /\.\.\.materials/);
  assert.match(appearance, /aria-label="Body 材料"/);
  assert.match(registry, /project\.materials/);
});
test("project data uses separate dialogs, guarded edit sessions and expandable data nodes without silent revision retry", async () => {
  const [source, projectDataPanel] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AdvancedProjectDataPanel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /setProjectDataMode\("variables"\)/);
  assert.match(source, /setProjectDataMode\("coordinates"\)/);
  assert.match(source, /mode=\{projectDataMode\}/);
  const tree = await readFile(new URL("../app/workbench/ProjectTree.tsx", import.meta.url), "utf8");
  assert.match(tree, /<Branch label="变量"/);
  assert.match(tree, /<Branch label="材料"/);
  assert.match(tree, /<Branch label="坐标系"/);
  assert.match(source, /model\?\.variables \|\| \[\]/);
  assert.match(tree, /materials\.map/);
  assert.match(source, /model\?\.coordinateSystems \|\| \[\]/);
  assert.match(projectDataPanel, /mode: ProjectDataMode/);
  assert.match(projectDataPanel, /useEditorCommands/);
  assert.match(projectDataPanel, /editorCommands\.executeBatch<ProjectResult>/);
  assert.match(source, /<CommandEditScope/);
  assert.doesNotMatch(projectDataPanel,/mutationWithFreshRevision|operation: "document\.summary"/);
  assert.doesNotMatch(projectDataPanel, /const \[tab, setTab\]/);
});
test("tree node double click opens a record-specific editor with restored data", async () => {
  const [source, projectDataPanel, metadataPanels, css] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AdvancedProjectDataPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /const \[projectDataItemId, setProjectDataItemId\]/);
  const tree = await readFile(new URL("../app/workbench/ProjectTree.tsx", import.meta.url), "utf8");
  assert.match(tree, /onDoubleClick=\{\(\) => onEditData\(mode, id\)\}/);
  assert.match(source, /onEditData=\{openProjectData\}/);
  assert.match(source, /initialItemId=\{projectDataItemId\}/);
  assert.match(projectDataPanel, /const initialVariable =/);
  assert.match(projectDataPanel, /const initialMaterial =/);
  assert.match(projectDataPanel, /const initialCoordinate =/);
  assert.match(projectDataPanel, /project-data-edit-mode/);
  assert.match(metadataPanels, /onDoubleClick=\{\(\) => onEditBody/);
  assert.match(css, /\.project-data-edit-mode \.project-data-list/);
});
test("Boolean inputs are mounted as expandable Body nodes below the Boolean feature", async () => {
  const [featureGraph, metadataPanels, css] = await Promise.all([
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(featureGraph, /buildStructuredBodyHistory/);
  assert.match(featureGraph, /feature\.inputFeatures\.slice\(1\)/);
  assert.match(featureGraph, /inputBodies/);
  assert.match(metadataPanels, /className="boolean-input-list"/);
  assert.match(metadataPanels, /bodyDisplayName\(inputBody\.bodyId, features\)/);
  assert.match(metadataPanels, /renderHistory\(inputBody\.features, ownerBodyId, true\)/);
  assert.doesNotMatch(metadataPanels, />Tool:/);
  assert.match(css, /\.boolean-input-body/);
});
test("Boolean feature editor restores operation, roles and immutable output options", async () => {
  const source = await readFile(new URL("../app/FeatureHistoryControls.tsx", import.meta.url), "utf8");
  assert.match(source, /feature\.type\.startsWith\("boolean\."\)/);
  assert.match(source, /aria-label="Boolean 特征操作"/);
  assert.match(source, /operationType: selectedBooleanDraft\.operation/);
  assert.match(source, /targetBodies: selectedBooleanDraft\.targets\.join/);
  assert.match(source, /toolBodies: selectedBooleanDraft\.tools\.join/);
  assert.match(source, /assignBooleanRole/);
  assert.match(source, /保留 Target（只读）/);
  assert.match(source, /拆分结果（只读）/);
  assert.match(source, /disabled checked=\{selected\.stringParameters\.keepTool/);
});
test("Feature lifecycle actions are exposed with safe type restrictions and confirmation", async () => {
  const [source, css, demo] = await Promise.all([
    readFile(new URL("../app/FeatureHistoryControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "feature\." \+ action/);
  assert.match(source, /"suppress" \| "restore" \| "delete"/);
  assert.match(source, /selected\.type\.startsWith\("transform\."\)/);
  assert.match(source, /selected\.type !== "transform\.copy"/);
  assert.match(source, /selected\.type === "detail\.fillet"/);
  assert.match(source, /selected\.type === "detail\.chamfer"/);
  assert.match(source, /selected\.type === "detail\.shell"/);
  assert.match(source, /selected\.type === "detail\.thicken"/);
  assert.match(source, /selected\.type === "detail\.offset"/);
  assert.match(source, /selected\.type\.startsWith\("boolean\."\)/);
  assert.match(source, /onConfirmDelete\(selected\.id, bodyId/);
  assert.match(demo, /onConfirmDelete=\{confirmFeatureDeletion\}/);
  assert.match(demo, /确认删除/);
  for(const kind of ['sweep','pipe','loft'])assert.ok(source.includes(`selected.type === "detail.${kind}"`));
  assert.match(source, /此类特征暂不支持独立生命周期操作/);
  assert.match(css, /\.feature-lifecycle-actions/);
});
test("Chamfer is exposed from edge selection through the workbench and feature tree", async () => {
  const [source, registry, featureGraph] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
  ]);
  assert.match(registry, /feature\.chamfer/);
  assert.match(source, /operation: "detail\.chamfer"/);
  assert.match(source, /data-testid="apply-chamfer"/);
  assert.match(featureGraph, /"detail\.chamfer": "Chamfer"/);
});test("Shell, Thicken and Offset share a Face-aware expression dialog", async () => {
  const [source, registry, featureGraph] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
  ]);
  assert.match(registry, /feature\.offset/);
  assert.match(source, /"shell" \| "thicken" \| "offset"/);
  assert.match(source, /operation: `detail\.\$\{offsetFeatureKind\}`/);
  assert.match(source, /placeholder="数值、单位或变量表达式"/);
  assert.match(source, /data-testid="apply-offset-feature"/);
  assert.match(featureGraph, /"detail\.shell": "Shell"/);
  assert.match(featureGraph, /"detail\.thicken": "Thicken"/);
  assert.match(featureGraph, /"detail\.offset": "Offset"/);
});
test("Feature editor restores scalar expressions and exposes project variables", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/FeatureHistoryControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /feature\.stringParameters\["expr\." \+ key\]/);
  assert.match(source, /Record<string, string>/);
  assert.match(source, /placeholder="数值、单位或变量表达式"/);
  assert.match(source, /model\?\.variables/);
  assert.match(source, /工程变量/);
  assert.match(source, /aria-label="创建缺失变量"/);
  assert.match(source, /创建并重试/);
  assert.doesNotMatch(source, /aria-label=\{["]特征参数 ["].*type="number"/);
  assert.match(css, /\.feature-expression-input/);
  assert.match(css, /\.feature-variable-reference/);
});
test("Feature parameters are opened from the geometry tree without a duplicate ribbon command", async () => {
  const [registry, source, metadataPanels] = await Promise.all([
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(registry, /feature\.history/);
  assert.doesNotMatch(registry, /label: "参数与历史"/);
  assert.doesNotMatch(source, /"feature\.history": "history"/);
  assert.match(metadataPanels, /onDoubleClick=\{\(\) => onEditFeature\(ownerBodyId, feature\.id\)\}/);
  assert.match(source, /setActiveOperation\("history"\)/);
});
test("surface creation uses one dropdown and geometry tree distinguishes Sheet Body", async () => {
  const [source, panel, metadataPanels, featureGraph, historyControls] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AdvancedModelingPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/FeatureHistoryControls.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /activeOperation === "surfaces"/);
  assert.match(panel, /aria-label="基础面类型"/);
  assert.match(panel, /const createSurface/);
  assert.match(panel, /coordinateSystemId/);
  assert.match(metadataPanels, /body\.kind === "sheet"/);
  assert.match(featureGraph, /surface\.sphere/);
  assert.match(historyControls, /feature\.type\.startsWith\("surface\."\)/);
});
test("Draft is exposed from Face selection through the feature workbench", async () => {
  const [source, registry, graph] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "detail\.draft"/);
  assert.match(source, /data-testid="apply-draft"/);
  assert.match(registry, /feature\.draft/);
  assert.match(graph, /"detail\.draft": "Draft"/);
});
test("Linear Pattern is exposed from Body selection through the modeling workbench", async () => {
  const [source, registry, graph] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "pattern\.linear"/);
  assert.match(source, /data-testid="apply-pattern"/);
  assert.match(source, /activeOperation === "pattern"/);
  assert.match(registry, /model\.pattern/);
  assert.match(graph, /"pattern\.linear": "Linear Pattern"/);
});

test("Circular Pattern is exposed from Body selection through the modeling workbench", async () => {
  const [source, registry, graph] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "pattern\.circular"/);
  assert.match(source, /data-testid="apply-pattern-circular"/);
  assert.match(source, /activeOperation === "patternCircular"/);
  assert.match(registry, /model\.patternCircular/);
  assert.match(graph, /"pattern\.circular": "Circular Pattern"/);
});


test("Rectangular Pattern is exposed from Body selection through the modeling workbench", async () => {
  const [source, registry, graph] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "pattern\.rectangular"/);
  assert.match(source, /data-testid="apply-pattern-rectangular"/);
  assert.match(source, /activeOperation === "patternRectangular"/);
  assert.match(registry, /model\.patternRectangular/);
  assert.match(graph, /"pattern\.rectangular": "Rectangular Pattern"/);
});


test("Mirror Pattern is exposed from Body selection through the modeling workbench", async () => {
  const [source, registry, graph] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "pattern\.mirror"/);
  assert.match(source, /data-testid="apply-pattern-mirror"/);
  assert.match(source, /activeOperation === "patternMirror"/);
  assert.match(registry, /model\.patternMirror/);
  assert.match(graph, /"pattern\.mirror": "Mirror Pattern"/);
});





test("property instances replace the free Key/Value editor", async () => {
  const [source, legacy] = await Promise.all([
    readFile(new URL("../app/PropertySchemaPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ModelMetadataPanels.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /新增属性实例/);
  assert.match(source, /property\.instance\.create/);
  assert.match(source, /onSelectTarget/);
  assert.doesNotMatch(legacy, /export function PropertyEditor/);
});test("Material custom properties are exposed in the project data editor", async () => {
  const [source, types] = await Promise.all([
    readFile(new URL("../app/AdvancedProjectDataPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ProjectDataPanel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /customProperties/);
  assert.match(source, /data-testid="material-custom-properties"/);
  assert.match(source, /Expression/);
  assert.match(types, /MaterialPropertyData/);
});test("Measure supports Body, Face and Edge selections in the workbench", async () => {
  const [source, panel, presentation] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MeasurementPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/modeling/measurement.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<MeasurementPanel/);
  assert.match(source, /selectedId\?\.startsWith\("face-"\)/);
  assert.match(source, /selectedId\?\.startsWith\("edge-"\)/);
  assert.match(panel, /measurementRows\(snapshot.result\)/);
  assert.match(presentation, /selectionType === "body"/);
  assert.match(presentation, /selectionType === "face"/);
  assert.match(presentation, /perimeter/);
  assert.match(presentation, /curveType/);
});test("Shape Check is exposed as a body analysis command", async () => {
  const [source, registry] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "geometry\.check"/);
  assert.match(source, /data-testid="run-shape-check"/);
  assert.match(registry, /analysis\.shapeCheck/);
});


test("Measure is exposed as a read-only analysis command through the measurement panel", async () => {
  const [source, registry, panel] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MeasurementPanel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<MeasurementPanel/);
  assert.match(panel, /operation: "geometry\.measure"/);
  assert.match(panel, /data-testid="run-measure"/);
  assert.match(panel, /measurementMatches\(result, owner, token\)/);
  assert.match(registry, /analysis\.measure/);
});

test("Revolve is exposed from Face selection through the modeling workbench", async () => {
  const [source, registry, graph, history] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model/feature-graph.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/FeatureHistoryControls.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /operation: "detail\.revolve"/);
  assert.match(source, /data-testid="apply-revolve"/);
  assert.match(source, /activeOperation === "revolve"/);
  assert.match(registry, /feature\.revolve/);
  assert.match(graph, /"detail\.revolve": "Revolve"/);
  assert.match(history, /feature\.type === "detail\.revolve"/);
});
test("dialogs and coordinate selects remain legible in the dark workbench", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.inline-dialog input, \.inline-dialog select/);
  assert.match(css, /appearance: none/);
  assert.match(css, /\.project-data-panel select option/);
  assert.match(css, /--cad-border-focus/);
});
test("the assistant has no obsolete plan or confirmation surface", async () => {
  const {renderPiPanel}=await import('./helpers/render-pi-panel.mjs');const html=await renderPiPanel();
  assert.doesNotMatch(html,/agent-plan-table|abandon-agent-plan|confirm-agent-plan|确认执行/);assert.match(html,/pi-agent-composer/);
});
test("the old assistant import cannot expose a second Plan/Edit implementation", async () => {
  const {legacyPiAlias,renderPiPanel}=await import('./helpers/render-pi-panel.mjs');assert.equal(await legacyPiAlias(),true);
  const html=await renderPiPanel();assert.match(html,/工具和思考默认折叠/);assert.match(html,/压缩 Pi 会话上下文/);assert.doesNotMatch(html,/agent-plan-mode|agent-edit-mode/);
});
test("geometry tree mirrors project tree row and branch styling", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /Geometry tree aligned with Project tree rows and branches/);
  assert.match(css, /\.feature-tree \.body-feature-tree > li > \.body-feature-list[\s\S]*border-left: 1px dotted/);
  assert.match(css, /\.feature-tree \.body-tree-node:hover[\s\S]*background: rgba\(95,194,220,.08\)/);
});
test("Boolean input branches inherit the active workbench palette instead of forcing pale text", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.feature-tree \.boolean-input-list\s*\{[^}]*background: transparent !important/);
  assert.match(css, /\.feature-tree \.boolean-input-header\s*\{[^}]*background: var\(--cad-inset\)/);
  assert.match(css, /\.feature-tree \.boolean-input-header strong\s*\{[^}]*color: var\(--cad-text\)/);
  assert.doesNotMatch(css, /\.feature-tree \.boolean-input-header strong\s*\{[^}]*color:\s*#[\da-f]+\s*!important/i);
});
test("project tree dock supports pointer and keyboard resizing", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench/studio.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /className="dock-resizer"/);
  assert.match(source, /onPointerDown=\{startDockResize\}/);
  assert.match(source, /aria-valuemin=\{220\}/);
  assert.match(source, /setProjectDockWidth\(302\)/);
  assert.match(source, /event\.key === "ArrowLeft"/);
  assert.match(css, /--studio-left-track: min\(var\(--project-dock-width, 302px\)/);
  assert.match(css, /grid-template-columns: var\(--studio-left-track\) var\(--studio-resizer\)/);
});
test("viewport keeps a valid renderer size and retries an unavailable document", async () => {
  const source = await readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8");
  assert.match(source, /Math\.max\(1, mount\.clientWidth\)/);
  assert.match(source, /Math\.max\(1, mount\.clientHeight\)/);
  assert.match(source, /requestAnimationFrame\(resizeViewport\)/);
  assert.match(source, /几何服务未连接，正在重试/);
  assert.match(source, /restoreRetryTimerRef\.current = window\.setTimeout/);
});
test("Agent messages are copyable and Tool results render as summaries", async () => {
  const {flattenMessages,piToolSummary}=await import('../app/modeling/pi-messages.ts');
  const original=[{role:'assistant',content:[{type:'toolCall',id:'one',name:'primitive__box',arguments:{parameters:{width:'W'}}}]},{role:'toolResult',toolCallId:'one',toolName:'primitive__box',content:[{type:'text',text:JSON.stringify({ok:true,bodyId:'body-1'})}]}];
  const before=JSON.stringify(original),messages=flattenMessages(original);assert.equal(messages.length,1);assert.match(piToolSummary(messages[0]),/完成.*body-1/);assert.match(messages[0].content,/"width": "W"/);assert.equal(JSON.stringify(original),before);
});
test("file menu separates project and STEP actions and exposes one-click new project", async () => {
  const [registry, demo, controller] = await Promise.all([
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/modeling/modeling-controller.ts", import.meta.url), "utf8"),
  ]);
  assert.match(registry, /file\.new/);
  assert.match(registry, /file\.open/);
  assert.match(registry, /file\.save/);
  assert.match(registry, /file\.importStep/);
  assert.match(registry, /file\.exportStep/);
  assert.match(registry, /commands: \["file\.new", "file\.open", "file\.save", "file\.importStep", "file\.exportStep"/);
  assert.match(demo, /createNewProject/);
  assert.match(demo, /menuProjectInputRef/);
  const create=controller.slice(controller.indexOf('  async createNewProject<'),controller.indexOf('  async importStep<'));
  assert.match(create,/beginWorkspaceTransfer\('project\.create'/);
  assert.match(create,/normalizeProjectCreateInput/);
  assert.match(create,/project\/create/);
  assert.doesNotMatch(create,/operation:\s*["']document\.create["']/);
});

test("mesh workbench routes mesh requests through the configured geometry gateway", async () => {
  const source = await readFile(new URL("../app/MeshWorkbenchPanel.tsx", import.meta.url), "utf8");
  const {ProjectMeshTaskStore}=await import('../app/model/project-mesh-task-store.ts');const requests=[];
  const store=new ProjectMeshTaskStore({documentId:'configured',apiRoot:'http://fixture/api',fetchImpl:async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({ok:true,jobs:[],...(init.method==='POST'?{meshJob:{jobId:'job',documentId:'configured',state:'queued'}}:{})}));}});
  store.start();try{await store.refresh();await store.create({baseRevision:1,repairMode:'none',qualityThreshold:.2});assert.ok(requests.every(request=>request.url==='http://fixture/api/documents/configured/mesh/jobs'));const submitted=JSON.parse(requests.find(request=>request.init.method==='POST').init.body);assert.equal(submitted.background,true);assert.equal(submitted.selection,null);}finally{store.stop();}
  assert.match(source, /import \{ API_ROOT \} from "\.\/api-config\.ts";/);
  assert.match(source, /tasks\.create/);
  assert.match(source, /fetch\(API_ROOT \+ "\/mesh\/jobs\/"/);
  assert.match(source, /href=\{API_ROOT \+ "\/mesh\/outputs\/"/);
  assert.match(source, /setVisible/);
  assert.doesNotMatch(source, /mesh-entity|toggleGroup|onMeshGroupVisibility/);
  assert.doesNotMatch(source, /fetch\("\/api\/documents\/[^"]*mesh\/jobs/);
});
test("hidden geometry is excluded from picking", async () => {
  const source = await readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8");
  const picking = await readFile(new URL('../app/model/viewport-picking.ts',import.meta.url),'utf8');
  assert.match(source,/pickViewportBody\(raycaster,bodyMeshesRef\.current,camera\)/);
  assert.match(source,/pickViewportEdge\(raycaster,edgeLinesRef\.current,bodyMeshesRef\.current,camera\)/);
  assert.match(picking,/meshes\.filter\(mesh=>mesh\.visible\)/);
  assert.match(picking,/lines\.filter\(line=>line\.visible\)/);
  assert.match(source, /bodyMesh\.visible === false/);
  assert.match(source, /candidate\.visible && candidate\.userData\.bodyId/);
});

test('symbol-only viewport commands have explicit accessible names',async()=>{
  const source=await readFile(new URL('../app/CadDemo.tsx',import.meta.url),'utf8');
  for(const label of ['轴测视图','顶视图','前视图','右视图','适应窗口'])assert.ok(source.includes(`aria-label="${label}" title="${label}"`),label);
});
