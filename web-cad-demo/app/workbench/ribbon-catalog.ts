import type { StudioIconName } from "./StudioIcon";
import type { CadCommandId } from "../commands/command-registry";

export type PrimitiveKind = "box" | "cylinder" | "cone" | "sphere" | "torus" | "wedge" | "prism" | "pyramid" | "tube";
export type SurfaceKind = "rectangle" | "disk" | "cylinder" | "cone" | "sphere";
export type TransformKind = "translate" | "rotate" | "mirror" | "copy" | "coordinate" | "align" | "scale" | "scale_non_uniform";
export type BooleanKind = "fuse" | "cut" | "common" | "section" | "split" | "partition" | "fragments" | "imprint";
export type WorkbenchCommand = CadCommandId | `primitive.${PrimitiveKind}` | `surface.${SurfaceKind}` | `transform.${TransformKind}` | `boolean.${BooleanKind}` | "feature.pipe" | "feature.shell" | "feature.thicken" | "feature.offsetOnly" | "feature.history" | "analysis.volume" | "view.renderAll" | "view.messages" | "project.workspaces" | "project.sources" | "project.backups" | "view.back" | "view.panels" | "view.restorePanels" | "view.screenshot" | "view.measurements" | "view.shaded" | "view.wire" | "view.edges";

export type RibbonTool = { id: WorkbenchCommand; label: string; icon: StudioIconName };
export type RibbonGroup = { label: string; tools: RibbonTool[] };

const tool = (label: string, icon: StudioIconName, id: WorkbenchCommand): RibbonTool => ({ id, label, icon });

export const WORKBENCH_TABS: { label: string; groups: RibbonGroup[] }[] = [
  { label: "工程", groups: [
    { label: "文件", tools: [
      tool("新建工程", "file", "file.new"),
      tool("打开工程", "file", "file.open"),
      tool("保存工程", "save", "file.save"),
      tool("另存为", "export", "file.saveAs"),
      tool("恢复工程", "file", "project.workspaces"),
      tool("备份管理", "save", "project.backups"),
    ] },
    { label: "数据交换", tools: [
      tool("导入 STEP", "box", "file.importStep"),
      tool("导出 STEP", "export", "file.exportStep"),
      tool("来源与引用", "check", "project.sources"),
    ] },
    { label: "编辑历史", tools: [
      tool("撤销", "undo", "edit.undo"),
      tool("重做", "redo", "edit.redo"),
    ] },
  ] },
  { label: "建模", groups: [
    { label: "基础体", tools: [
      tool("长方体", "box", "primitive.box"),
      tool("圆柱体", "cylinder", "primitive.cylinder"),
      tool("圆锥体", "cone", "primitive.cone"),
      tool("圆球体", "sphere", "primitive.sphere"),
      tool("圆环体", "torus", "primitive.torus"),
      tool("棱柱", "box", "primitive.prism"),
      tool("楔体", "box", "primitive.wedge"),
      tool("棱台", "box", "primitive.pyramid"),
      tool("圆管", "cylinder", "primitive.tube"),
    ] },
    { label: "基础面", tools: [
      tool("矩形面", "rectangle", "surface.rectangle"),
      tool("圆面", "circle", "surface.disk"),
      tool("圆柱面", "cylinder", "surface.cylinder"),
      tool("球面", "sphere", "surface.sphere"),
      tool("圆锥面", "cone", "surface.cone"),
    ] },
    { label: "生成几何", tools: [
      tool("旋转体", "rotate", "feature.revolve"),
      tool("扫掠", "sweep", "feature.sweep"),
      tool("放样", "loft", "feature.loft"),
      tool("管道", "sweep", "feature.pipe"),
    ] },
  ] },
  { label: "变换", groups: [
    { label: "刚体变换", tools: [
      tool("移动", "move", "transform.translate"),
      tool("旋转", "rotate", "transform.rotate"),
      tool("镜像", "mirror", "transform.mirror"),
      tool("对齐", "box", "transform.align"),
      tool("坐标变换", "axes", "transform.coordinate"),
    ] },
    { label: "形状变换", tools: [
      tool("缩放", "box", "transform.scale"),
      tool("偏移", "move", "feature.offsetOnly"),
      tool("非等比缩放", "expand", "transform.scale_non_uniform"),
    ] },
    { label: "阵列复制", tools: [
      tool("线性阵列", "array", "model.pattern"),
      tool("圆周阵列", "array", "model.patternCircular"),
      tool("复制", "box", "transform.copy"),
      tool("矩形阵列", "array", "model.patternRectangular"),
      tool("镜像阵列", "mirror", "model.patternMirror"),
    ] },
  ] },
  { label: "布尔", groups: [
    { label: "布尔运算", tools: [
      tool("并集", "union", "boolean.fuse"),
      tool("差集", "subtract", "boolean.cut"),
      tool("交集", "intersection", "boolean.common"),
    ] },
    { label: "分割", tools: [
      tool("截交线", "box", "boolean.section"),
      tool("分割实体", "box", "boolean.split"),
      tool("片段提取", "box", "boolean.fragments"),
      tool("分区", "union", "boolean.partition"),
      tool("压印", "layers", "boolean.imprint"),
    ] },
  ] },
  { label: "特征", groups: [
    { label: "特征生成", tools: [
      tool("旋转体", "rotate", "feature.revolve"),
      tool("扫掠", "sweep", "feature.sweep"),
      tool("放样", "loft", "feature.loft"),
    ] },
    { label: "工程特征", tools: [
      tool("倒角", "box", "feature.chamfer"),
      tool("圆角", "box", "feature.fillet"),
      tool("抽壳", "box", "feature.shell"),
      tool("拔模", "box", "feature.draft"),
      tool("加厚", "layers", "feature.thicken"),
    ] },
    { label: "特征管理", tools: [
      tool("编辑参数", "box", "feature.history"),
    ] },
  ] },
  { label: "网格", groups: [
    { label: "网格划分", tools: [
      tool("体网格", "mesh", "analysis.mesh"),
    ] },
  ] },
  { label: "检查", groups: [
    { label: "几何检查", tools: [
      tool("有效性检查", "check", "analysis.shapeCheck"),
    ] },
    { label: "结果", tools: [
      tool("测量体 / 面 / 边", "box", "analysis.measure"),
    ] },
  ] },
  { label: "修复", groups: [
    { label: "网格修复", tools: [
      tool("网格修复工作台", "mesh", "analysis.mesh"),
    ] },
  ] },
  { label: "分析", groups: [
    { label: "质量属性", tools: [
      tool("体积", "measure", "analysis.volume"),
    ] },
  ] },
  { label: "测量", groups: [
    { label: "结果", tools: [
      tool("测量列表", "measure", "view.measurements"),
      tool("测量体 / 面 / 边", "box", "analysis.measure"),
    ] },
  ] },
  { label: "视图", groups: [
    { label: "观察视角", tools: [
      tool("轴测图", "iso", "view.iso"),
      tool("前视", "viewFront", "view.front"),
      tool("后视", "viewBack", "view.back"),
      tool("俯视", "viewTop", "view.top"),
      tool("右视", "viewRight", "view.right"),
      tool("适应窗口", "fit", "view.fit"),
    ] },
    { label: "显示", tools: [
      tool("着色", "shaded", "view.shaded"),
      tool("线框", "wireframe", "view.wire"),
      tool("着色 + 边线", "shadedEdges", "view.edges"),
      tool("参考网格", "referenceGrid", "view.grid"),
      tool("全量渲染", "layers", "view.renderAll"),
    ] },
    { label: "布局", tools: [
      tool("面板管理", "columns", "view.panels"),
      tool("恢复默认布局", "restoreLayout", "view.restorePanels"),
      tool("消息面板", "messages", "view.messages"),
      tool("关闭操作", "close", "window.closeOperation"),
    ] },
  ] },
  { label: "数据", groups: [
    { label: "模型参数", tools: [
      tool("变量管理", "settings", "project.variables"),
      tool("坐标系", "box", "project.coordinates"),
    ] },
    { label: "模型数据", tools: [
      tool("材料管理", "settings", "project.materials"),
    ] },
    { label: "导出", tools: [
      tool("数据导出", "export", "file.exchange"),
      tool("模型快照", "camera", "view.screenshot"),
    ] },
    { label: "属性", tools: [
      tool("属性类型", "tag", "project.propertyTypes"),
      tool("属性实例", "tag", "edit.properties"),
    ] },
  ] },
  { label: "工具", groups: [
    { label: "系统", tools: [
      tool("当前能力", "help", "help.capabilities"),
    ] },
  ] },
  { label: "扩展", groups: [
    { label: "智能化", tools: [
      tool("AI 助手", "terminal", "model.agent"),
    ] },
    { label: "集成", tools: [
      tool("服务配置", "box", "model.agentSettings"),
    ] },
  ] },
];
