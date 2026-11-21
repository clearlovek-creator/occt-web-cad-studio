export type CadCommandId =
  | "file.exchange"
  | "file.new"
  | "file.open"
  | "file.save"
  | "file.importStep"
  | "file.exportStep"
  | "edit.undo"
  | "edit.redo"
  | "edit.properties"
  | "project.propertyTypes"
  | "project.variables"
  | "project.coordinates"
  | "project.materials"
  | "view.fit"
  | "view.iso"
  | "view.top"
  | "view.front"
  | "view.right"
  | "view.grid"
  | "select.body"
  | "select.face"
  | "select.edge"
  | "model.primitives"
  | "model.surfaces"
  | "model.transform"
  | "model.boolean"
  | "model.agent"
  | "model.agentSettings"
  | "model.pattern"
  | "model.patternCircular"
  | "model.patternRectangular"
  | "model.patternMirror"
  | "feature.revolve"
  | "feature.sweep"
  | "feature.loft"
  | "analysis.shapeCheck"
  | "analysis.measure"
  | "analysis.mesh"
  | "feature.fillet"
  | "feature.chamfer"
  | "feature.draft"
  | "feature.offset"
  | "window.closeOperation"
  | "help.capabilities";

export type CadCommandDefinition = {
  id: CadCommandId;
  label: string;
  icon: string;
  hint: string;
};

const definitions: CadCommandDefinition[] = [
  { id: "file.exchange", label: "工程 / STEP 文件", icon: "FILE", hint: "打开工程保存面板，或执行 STEP 导入导出。" },
  { id: "file.new", label: "新建工程", icon: "+", hint: "创建一个空白工程并切换到新的文档。" },
  { id: "file.open", label: "打开工程", icon: "OPEN", hint: "打开 XBF 工程文件。" },
  { id: "file.save", label: "保存工程", icon: "SAVE", hint: "将当前工程保存为 XBF 文件。" },
  { id: "file.importStep", label: "导入 STEP", icon: "IN", hint: "导入 STEP 或 STP 文件。" },
  { id: "file.exportStep", label: "导出 STEP", icon: "OUT", hint: "导出当前几何为 STEP 文件。" },
  { id: "edit.undo", label: "撤销", icon: "↶", hint: "撤销最近一次文档修改。" },
  { id: "edit.redo", label: "重做", icon: "↷", hint: "恢复最近一次撤销。" },
  { id: "edit.properties", label: "对象属性", icon: "i", hint: "管理工程或 Body、Face、Edge 的属性实例。" },
  { id: "project.propertyTypes", label: "属性类型", icon: "◇", hint: "管理可复用属性类型与自定义字段。" },
  { id: "project.variables", label: "变量", icon: "Σ", hint: "管理标量变量与参数表达式" },
  { id: "project.coordinates", label: "坐标系", icon: "CS", hint: "管理 Global 和 Local Cartesian 坐标系" },
  { id: "project.materials", label: "材料库", icon: "MAT", hint: "管理工程材料和电磁属性" },
  { id: "view.fit", label: "适应窗口", icon: "⌗", hint: "将全部显示几何适应到视口" },
  { id: "view.iso", label: "轴测视图", icon: "◇", hint: "切换到轴测视图" },
  { id: "view.top", label: "顶视图", icon: "T", hint: "从 +Z 方向观察" },
  { id: "view.front", label: "前视图", icon: "F", hint: "从 -Y 方向观察" },
  { id: "view.right", label: "右视图", icon: "R", hint: "从 +X 方向观察" },
  { id: "view.grid", label: "显示网格", icon: "#", hint: "显示或隐藏建模网格" },
  { id: "select.body", label: "体选择", icon: "▣", hint: "切换到 Body 拾取" },
  { id: "select.face", label: "面选择", icon: "◩", hint: "切换到 Face 拾取" },
  { id: "select.edge", label: "边选择", icon: "⌁", hint: "切换到 Edge 拾取" },
  { id: "model.primitives", label: "基础体", icon: "□", hint: "创建常用 Solid Body" },
  { id: "model.surfaces", label: "基础面", icon: "▱", hint: "创建矩形、圆、圆柱、圆锥或球形 Sheet Body" },
  { id: "model.transform", label: "变换", icon: "⇄", hint: "平移、旋转、镜像或缩放当前 Body" },
  { id: "model.boolean", label: "Boolean", icon: "∪", hint: "执行 Fuse、Cut 或 Common" },
  { id: "model.agent", label: "建模助手", icon: "AI", hint: "将自然语言转换为安全的建模计划" },
  { id: "model.agentSettings", label: "大模型设置", icon: "LLM", hint: "管理 OpenAI 兼容的大模型 Provider" },
  { id: "model.pattern", label: "Pattern", icon: "#", hint: "Create a linear pattern of the active Body" },
  { id: "model.patternCircular", label: "Circular Pattern", icon: "◌", hint: "Create a circular pattern around an axis" },
  { id: "model.patternRectangular", label: "Rectangular Pattern", icon: "▦", hint: "Create a two-direction rectangular pattern" },
  { id: "model.patternMirror", label: "Mirror Pattern", icon: "◇", hint: "Create a mirrored Body across a plane" },
  { id: "feature.revolve", label: "Revolve", icon: "↻", hint: "Revolve a selected Face into a new Body" },
  { id: "feature.sweep", label: "Sweep / Pipe", icon: "↝", hint: "Sweep a Face along a path vector" },
  { id: "feature.loft", label: "Loft", icon: "⌁", hint: "Loft between multiple section Bodies" },
  { id: "analysis.shapeCheck", label: "Shape Check", icon: "✓", hint: "Check OCCT shape validity and topology counts" },
  { id: "analysis.measure", label: "Measure", icon: "∑", hint: "Measure volume, area, length and bounds" },
  { id: "analysis.mesh", label: "网格工具", icon: "M", hint: "修复脏几何、处理交叉并分析四面体质量" },
  { id: "feature.fillet", label: "边圆角", icon: "◒", hint: "对所选 Edge 创建 OCCT Fillet 特征" },
  { id: "feature.chamfer", label: "边倒角", icon: "⌞", hint: "对所选 Edge 创建 OCCT Chamfer 特征" },
  { id: "feature.draft", label: "拔模", icon: "∠", hint: "对所选 Face 创建 Draft 拔模特征" },
  { id: "feature.offset", label: "壳体/偏置", icon: "▱", hint: "创建 Shell、Thicken 或 Offset 特征" },
  { id: "window.closeOperation", label: "关闭操作窗口", icon: "×", hint: "关闭当前非模态操作窗口" },
  { id: "help.capabilities", label: "当前能力", icon: "?", hint: "查看当前已接入的建模能力" },
];

export const CAD_COMMANDS = new Map(definitions.map((definition) => [definition.id, definition]));
export type CommandSelectionRequirement = "none" | "body" | "face" | "edge" | "body-or-face-or-edge";

export type CadCommandMetadata = {
  operation?: string;
  mutatesDocument: boolean;
  undoable: boolean;
  supportsPreview: boolean;
  selection: CommandSelectionRequirement;
};

export const CAD_COMMAND_METADATA: Partial<Record<CadCommandId, CadCommandMetadata>> = {
  "edit.undo": { operation: "document.undo", mutatesDocument: true, undoable: false, supportsPreview: false, selection: "none" },
  "project.propertyTypes": { operation: "property.type.create", mutatesDocument: true, undoable: false, supportsPreview: false, selection: "none" },
  "edit.redo": { operation: "document.redo", mutatesDocument: true, undoable: false, supportsPreview: false, selection: "none" },
  "model.primitives": { mutatesDocument: true, undoable: true, supportsPreview: true, selection: "none" },
  "model.surfaces": { mutatesDocument: true, undoable: true, supportsPreview: true, selection: "none" },
  "model.transform": { mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body" },
  "model.boolean": { mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body" },
  "model.agent": { mutatesDocument: false, undoable: false, supportsPreview: true, selection: "none" },
  "model.pattern": { operation: "pattern.linear", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body" },
  "model.patternCircular": { operation: "pattern.circular", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body" },
  "model.patternRectangular": { operation: "pattern.rectangular", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body" },
  "model.patternMirror": { operation: "pattern.mirror", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body" },
  "feature.revolve": { operation: "detail.revolve", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "face" },
  "feature.sweep": { operation: "detail.sweep", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "face" },
  "feature.loft": { operation: "detail.loft", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body" },
  "feature.fillet": { operation: "detail.fillet", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "edge" },
  "feature.chamfer": { operation: "detail.chamfer", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "edge" },
  "feature.draft": { operation: "detail.draft", mutatesDocument: true, undoable: true, supportsPreview: true, selection: "face" },
  "feature.offset": { mutatesDocument: true, undoable: true, supportsPreview: true, selection: "body-or-face-or-edge" },
  "analysis.measure": { operation: "geometry.measure", mutatesDocument: false, undoable: false, supportsPreview: false, selection: "body-or-face-or-edge" },
  "analysis.mesh": { mutatesDocument: false, undoable: false, supportsPreview: false, selection: "none" },
  "analysis.shapeCheck": { operation: "geometry.check", mutatesDocument: false, undoable: false, supportsPreview: false, selection: "body" },
  "edit.properties": { operation: "property.set", mutatesDocument: true, undoable: true, supportsPreview: false, selection: "body-or-face-or-edge" },
};

/** Single source of truth for the UI command -> Worker operation inventory. */
export const CAD_WORKER_OPERATION_MAP = {
  "file.exchange": ["step.import", "step.export"],
  "file.new": ["document.create"],
  "file.open": ["document.restore"],
  "file.save": ["document.snapshot"],
  "file.importStep": ["step.import"],
  "file.exportStep": ["step.export"],
  "edit.undo": ["document.undo"],
  "edit.redo": ["document.redo"],
  "edit.properties": ["property.set", "property.delete", "property.list"],
  "project.propertyTypes": ["property.type.create", "property.type.update", "property.type.list", "property.package.export", "property.package.import"],
  "project.variables": ["variable.set", "variable.delete"],
  "project.coordinates": ["coordinate.set", "coordinate.delete"],
  "project.materials": ["material.set", "material.property.set", "material.property.delete", "material.delete"],
  "model.primitives": ["primitive.box", "primitive.cylinder", "primitive.cone", "primitive.sphere", "primitive.torus", "primitive.wedge", "primitive.prism", "primitive.pyramid", "primitive.tube"],
  "model.surfaces": ["surface.rectangle", "surface.disk", "surface.cylinder", "surface.cone", "surface.sphere"],
  "model.transform": ["transform.translate", "transform.rotate", "transform.mirror", "transform.scale", "transform.copy", "transform.scale_non_uniform", "transform.coordinate", "transform.align"],
  "model.boolean": ["boolean.fuse", "boolean.cut", "boolean.common", "boolean.section", "boolean.split", "boolean.partition", "boolean.fragments", "boolean.imprint"],
  "model.pattern": ["pattern.linear"],
  "model.patternCircular": ["pattern.circular"],
  "model.patternRectangular": ["pattern.rectangular"],
  "model.patternMirror": ["pattern.mirror"],
  "feature.revolve": ["detail.revolve"],
  "feature.sweep": ["detail.sweep", "detail.pipe"],
  "feature.loft": ["detail.loft"],
  "feature.fillet": ["detail.fillet"],
  "feature.chamfer": ["detail.chamfer"],
  "feature.draft": ["detail.draft"],
  "feature.offset": ["detail.shell", "detail.thicken", "detail.offset"],
  "analysis.shapeCheck": ["geometry.check"],
  "analysis.measure": ["geometry.measure"],
  "analysis.mesh": [],
  "body.lifecycle": ["body.update", "body.delete"],
  "history.lifecycle": ["feature.update", "feature.suppress", "feature.restore", "feature.delete"],
} as const;

export const CAD_SAFE_WORKER_OPERATIONS = new Set(Object.values(CAD_WORKER_OPERATION_MAP).flat());
export function getCommandMetadata(id: CadCommandId) {
  return CAD_COMMAND_METADATA[id];
}

export const CAD_MENUS: { label: string; commands: CadCommandId[] }[] = [
  { label: "文件", commands: ["file.new", "file.open", "file.save", "file.importStep", "file.exportStep"] },
  { label: "编辑", commands: ["edit.undo", "edit.redo", "edit.properties"] },
  { label: "视图", commands: ["view.fit", "view.iso", "view.top", "view.front", "view.right", "view.grid"] },
  { label: "建模", commands: ["model.agent", "model.primitives", "model.surfaces", "model.transform", "model.boolean", "model.pattern", "model.patternCircular", "model.patternRectangular", "model.patternMirror", "feature.revolve", "feature.sweep", "feature.loft"] },
  { label: "特征", commands: ["feature.fillet", "feature.chamfer", "feature.draft", "feature.revolve", "feature.offset"] },
  { label: "工具", commands: ["project.propertyTypes", "project.variables", "project.coordinates", "project.materials", "edit.properties", "model.agentSettings"] },
  { label: "分析", commands: ["analysis.shapeCheck", "analysis.measure", "analysis.mesh"] },
  { label: "窗口", commands: ["window.closeOperation"] },
  { label: "帮助", commands: ["help.capabilities"] },
];

export const CAD_RIBBON: { label: string; commands: CadCommandId[] }[] = [
  { label: "选择过滤器", commands: ["select.body", "select.face", "select.edge"] },
  { label: "工程", commands: ["file.new", "file.open", "file.save", "file.importStep", "file.exportStep"] },
  { label: "创建", commands: ["model.primitives", "model.surfaces"] },
  { label: "修改", commands: ["model.transform", "model.boolean", "model.pattern", "model.patternCircular", "model.patternRectangular", "model.patternMirror", "feature.fillet", "feature.chamfer", "feature.draft", "feature.revolve", "feature.sweep", "feature.loft", "feature.offset"] },
  { label: "数据", commands: ["project.propertyTypes", "project.variables", "project.coordinates", "project.materials", "edit.properties"] },
  { label: "分析", commands: ["analysis.measure", "analysis.shapeCheck", "analysis.mesh"] },
  { label: "视图", commands: ["view.fit", "view.grid"] },
  { label: "助手", commands: ["model.agent", "model.agentSettings"] },
];
