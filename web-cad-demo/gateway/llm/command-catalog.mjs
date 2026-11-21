const OPERATIONS = [
  "document.undo", "document.redo", "primitive.box", "primitive.cylinder", "primitive.cone", "primitive.sphere", "primitive.torus", "primitive.wedge", "primitive.prism", "primitive.pyramid", "primitive.tube",
  "surface.rectangle", "surface.disk", "surface.cylinder", "surface.cone", "surface.sphere", "transform.translate", "transform.rotate", "transform.mirror", "transform.scale", "transform.copy", "transform.scale_non_uniform", "transform.coordinate", "transform.align",
  "boolean.fuse", "boolean.cut", "boolean.common", "boolean.section", "boolean.split", "boolean.partition", "boolean.fragments", "boolean.imprint", "detail.fillet", "detail.chamfer", "detail.shell", "detail.thicken", "detail.offset", "detail.revolve", "detail.sweep", "detail.pipe", "detail.loft", "detail.draft",
  "pattern.linear", "pattern.circular", "pattern.rectangular", "pattern.mirror", "geometry.measure", "geometry.check", "body.delete", "body.update", "feature.update", "feature.suppress", "feature.restore", "feature.delete",
  "body.presentation", "variable.set", "variable.delete", "coordinate.set", "coordinate.delete", "material.set", "material.property.set", "material.property.delete", "material.delete", "property.set", "property.delete", "property.list",
  "property.type.create", "property.type.update", "property.type.delete", "property.type.list", "property.instance.create", "property.instance.update", "property.instance.delete", "property.instance.retarget", "property.instance.list", "property.package.export", "property.package.import", "geometry.relation",
  "mesh.strategy.create", "mesh.strategy.update", "mesh.strategy.delete", "mesh.strategy.list",
];

const READ_ONLY = new Set(["body.presentation", "geometry.measure", "geometry.relation", "geometry.check", "property.list", "property.type.list", "property.instance.list", "property.package.export", "mesh.strategy.list"]);

export const CAD_OPERATION_CATALOG = Object.freeze(OPERATIONS.map((operation) => Object.freeze({
  operation,
  mode: READ_ONLY.has(operation) ? "plan-or-edit" : "edit",
  readOnly: READ_ONLY.has(operation),
  risk: "none",
})));

export const CAD_OPERATION_NAMES = new Set(CAD_OPERATION_CATALOG.map((item) => item.operation));
export const CAD_READ_ONLY_OPERATIONS = new Set(CAD_OPERATION_CATALOG.filter((item) => item.readOnly).map((item) => item.operation));
export const CAD_RISKY_OPERATIONS = new Set();
export function isKnownCadOperation(operation) { return CAD_OPERATION_NAMES.has(String(operation || "")); }
export function isReadOnlyCadOperation(operation) { return CAD_READ_ONLY_OPERATIONS.has(String(operation || "")); }
export function isRiskyCadOperation(operation) { return CAD_RISKY_OPERATIONS.has(String(operation || "")); }
export const CAD_TOOL_OPERATION_MAP = Object.freeze({
  create_box: Object.freeze({ operation: "primitive.box", inputKeys: [], parameterKeys: ["width", "depth", "height"] }),
  create_cylinder: Object.freeze({ operation: "primitive.cylinder", inputKeys: [], parameterKeys: ["radius", "height"] }),
  create_sphere: Object.freeze({ operation: "primitive.sphere", inputKeys: [], parameterKeys: ["radius"] }),
  translate_body: Object.freeze({ operation: "transform.translate", inputKeys: ["bodyId"], parameterKeys: ["dx", "dy", "dz"] }),
  rotate_body: Object.freeze({ operation: "transform.rotate", inputKeys: ["bodyId"], parameterKeys: ["axisOrigin", "axisDirection", "angle"] }),
  scale_body: Object.freeze({ operation: "transform.scale", inputKeys: ["bodyId"], parameterKeys: ["factor"] }),
  boolean_fuse: Object.freeze({ operation: "boolean.fuse", inputKeys: ["targetBody", "toolBody"], parameterKeys: [] }),
  boolean_cut: Object.freeze({ operation: "boolean.cut", inputKeys: ["targetBody", "toolBody"], parameterKeys: [] }),
  boolean_common: Object.freeze({ operation: "boolean.common", inputKeys: ["targetBody", "toolBody"], parameterKeys: [] }),
  fillet_edge: Object.freeze({ operation: "detail.fillet", inputKeys: ["bodyId", "edgeId"], parameterKeys: ["radius"] }),
  chamfer_edge: Object.freeze({ operation: "detail.chamfer", inputKeys: ["bodyId", "edgeId"], parameterKeys: ["distance"] }),
  set_variable: Object.freeze({ operation: "variable.set", inputKeys: [], parameterKeys: ["name", "type", "expression"] }),
  set_material: Object.freeze({ operation: "material.set", inputKeys: [], parameterKeys: ["name", "category", "relativePermittivity", "conductivity"] }),
  assign_material: Object.freeze({ operation: "body.update", inputKeys: ["bodyId"], parameterKeys: ["material"] }),
  set_coordinate_system: Object.freeze({ operation: "coordinate.set", inputKeys: [], parameterKeys: ["id", "name", "kind", "origin", "xAxis", "yAxis", "xPoint", "planePoint", "referenceBodyId", "referenceTopologyId", "associationMode", "preserveReference", "copyReferenceFrom"] }),
  set_property: Object.freeze({ operation: "property.set", inputKeys: ["kind", "bodyId", "topologyId"], parameterKeys: ["key", "type", "value"] }),
  create_property_type: Object.freeze({ operation: "property.type.create", inputKeys: [], parameterKeys: ["key", "name", "description", "targetScope", "association", "fields", "targetMode", "splitPolicy"] }),
  list_property_types: Object.freeze({ operation: "property.type.list", inputKeys: [], parameterKeys: [] }),
  create_property_instance: Object.freeze({ operation: "property.instance.create", inputKeys: [], parameterKeys: ["typeId", "typeKey", "name", "value", "target", "targets"] }),
  update_property_instance: Object.freeze({ operation: "property.instance.update", inputKeys: ["instanceId"], parameterKeys: ["name", "value"] }),
  retarget_property_instance: Object.freeze({ operation: "property.instance.retarget", inputKeys: ["instanceId"], parameterKeys: ["target", "targets"] }),
  delete_property_instance: Object.freeze({ operation: "property.instance.delete", inputKeys: ["instanceId"], parameterKeys: [] }),
  list_property_instances: Object.freeze({ operation: "property.instance.list", inputKeys: [], parameterKeys: [] }),
  delete_body: Object.freeze({ operation: "body.delete", inputKeys: ["bodyId"], parameterKeys: [] }),
  measure_geometry: Object.freeze({ operation: "geometry.measure", inputKeys: ["bodyId", "selectionType", "selectionId"], parameterKeys: [] }),
  relate_geometry: Object.freeze({ operation: "geometry.relation", inputKeys: ["bodyA", "bodyB"], parameterKeys: ["tolerance"] }),
  undo: Object.freeze({ operation: "document.undo", inputKeys: [], parameterKeys: [] }),
  redo: Object.freeze({ operation: "document.redo", inputKeys: [], parameterKeys: [] }),
});
