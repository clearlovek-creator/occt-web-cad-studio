export type FeatureData = {
  id: string;
  type: string;
  state: string;
  computedRevision: number;
  inputFeatures: string[];
  outputBodies: string[];
  numberParameters: Record<string, number>;
  stringParameters: Record<string, string>;
};

export type StructuredFeatureNode = {
  feature: FeatureData;
  inputBodies: StructuredBodyNode[];
};

export type StructuredBodyNode = {
  bodyId: string;
  name?: string;
  features: StructuredFeatureNode[];
};

function ids(value: string | undefined) {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isBooleanFeature(feature: FeatureData) {
  return feature.type.startsWith("boolean.");
}

export function buildStructuredBodyHistory(features: FeatureData[], bodyId: string): StructuredFeatureNode[] {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const roots = features.filter((feature) => feature.outputBodies.includes(bodyId));
  const root = roots.at(-1);
  if (!root) return [];

  const buildMainline = (featureId: string, visiting: Set<string>): StructuredFeatureNode[] => {
    if (visiting.has(featureId)) return [];
    const feature = byId.get(featureId);
    if (!feature) return [];
    const nextVisiting = new Set(visiting).add(featureId);

    if (!isBooleanFeature(feature)) {
      const previous = feature.inputFeatures[0]
        ? buildMainline(feature.inputFeatures[0], nextVisiting)
        : [];
      return [...previous, { feature, inputBodies: [] }];
    }

    const targetBodies = ids(feature.stringParameters.targetBodies || feature.stringParameters.targetBody);
    const toolBodies = ids(feature.stringParameters.toolBodies || feature.stringParameters.toolBody);
    const inputBodyIds = [...targetBodies, ...toolBodies];
    const primaryTarget = feature.inputFeatures[0]
      ? buildMainline(feature.inputFeatures[0], nextVisiting)
      : [];
    const inputBodies = feature.inputFeatures.slice(1).map((inputFeatureId, index) => ({
      bodyId: inputBodyIds[index + 1] || `input-${index + 2}`,
      name: feature.stringParameters[`inputBodyMeta.${inputBodyIds[index + 1]}.name`] || undefined,
      features: buildMainline(inputFeatureId, nextVisiting),
    }));

    return [...primaryTarget, { feature, inputBodies }];
  };

  return buildMainline(root.id, new Set());
}

/** Suppressed features without a reachable row still need a recovery entry.
 * Collapse/filter/display visibility do not change semantic reachability. */
export function unrepresentedSuppressedFeatures(features:FeatureData[],histories:Iterable<StructuredFeatureNode[]>):FeatureData[] {
  const represented=new Set<string>(),pending:StructuredFeatureNode[]=[];
  for(const history of histories)pending.push(...history);
  while(pending.length){const node=pending.pop()!;if(represented.has(node.feature.id))continue;represented.add(node.feature.id);for(const input of node.inputBodies)pending.push(...input.features);}
  return features.filter(feature=>feature.state==="suppressed"&&!represented.has(feature.id));
}

export function featureOutputName(feature:FeatureData):string {
  const bodyId=feature.outputBodies[0];
  return feature.stringParameters[`outputBodyMeta.${bodyId}.name`] || feature.stringParameters[`lifecycleBodyMeta.${bodyId}.name`] || featureTypeLabel(feature.type);
}

export function traceBodyFeatures(features: FeatureData[], bodyId: string): FeatureData[] {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const roots = features.filter((feature) => feature.outputBodies.includes(bodyId));
  const root = roots.at(-1);
  if (!root) return [];

  const included = new Set<string>();
  const visit = (featureId: string) => {
    if (included.has(featureId)) return;
    const feature = byId.get(featureId);
    if (!feature) return;
    feature.inputFeatures.forEach(visit);
    included.add(featureId);
  };
  visit(root.id);
  return features.filter((feature) => included.has(feature.id));
}

const FEATURE_TYPE_LABELS: Record<string, string> = {
  "primitive.box": "Box",
  "primitive.cylinder": "Cylinder",
  "primitive.cone": "Cone",
  "primitive.sphere": "Sphere",
  "primitive.torus": "Torus",
  "primitive.wedge": "Wedge",
  "primitive.prism": "Prism",
  "primitive.pyramid": "Pyramid",
  "primitive.tube": "Tube",
  "surface.rectangle": "Rectangle Surface",
  "surface.disk": "Disk Surface",
  "surface.cylinder": "Cylinder Surface",
  "surface.cone": "Cone Surface",
  "surface.sphere": "Sphere Surface",
  "transform.translate": "Translate",
  "transform.rotate": "Rotate",
  "transform.mirror": "Mirror",
  "transform.scale": "Scale",
  "transform.scale_non_uniform": "Non-uniform Scale",
  "transform.coordinate": "Coordinate Transform",
  "transform.align": "Align",
  "transform.copy": "Copy",
  "boolean.fuse": "Boolean Fuse",
  "boolean.cut": "Boolean Cut",
  "boolean.common": "Boolean Common",
  "boolean.section": "Boolean Section",
  "boolean.split": "Boolean Split",
  "boolean.partition": "Boolean Partition",
  "boolean.fragments": "Boolean Fragments",
  "boolean.imprint": "Boolean Imprint",
  "detail.fillet": "Fillet",
  "detail.chamfer": "Chamfer",
  "detail.shell": "Shell",
  "detail.thicken": "Thicken",
  "detail.offset": "Offset",
  "detail.draft": "Draft",
  "detail.revolve": "Revolve",
  "detail.sweep": "Sweep",
  "detail.pipe": "Pipe",
  "detail.loft": "Loft",
  "pattern.linear": "Linear Pattern",
  "pattern.circular": "Circular Pattern",
  "pattern.rectangular": "Rectangular Pattern",
  "pattern.mirror": "Mirror Pattern",
  "import.step": "STEP Import",
};

export function featureTypeLabel(type: string) {
  const label = FEATURE_TYPE_LABELS[type] || type.split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  return /^(primitive|surface)\./.test(type) ? "create" + label.replace(/\s+/g, "") : label;
}

export function bodyDisplayName(bodyId: string, features: FeatureData[]) {
  const source = features.find((feature) => feature.outputBodies.includes(bodyId));
  const baseName = source ? (FEATURE_TYPE_LABELS[source.type] || featureTypeLabel(source.type)).replace(/\s+/g, "") : "Body";
  const sequence = bodyId.match(/(\d+)$/)?.[1] || bodyId;
  return `${baseName}${sequence}`;
}
