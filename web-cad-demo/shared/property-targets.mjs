/** Public association collections. Never infer a first member as a single target. */
export const MAX_PROPERTY_TARGETS = 256;
export const propertyTargets = instance => Array.isArray(instance?.targets) ? instance.targets : instance?.target ? [instance.target] : [];
export const propertyTargetKey = target => `${target.kind}|${target.bodyId}|${target.topologyId || ''}|${target.bodyIdentity || ''}|${target.topologyIdentity || ''}`;
export function associationDefinition(type) {
  const targetMode=type.targetMode===undefined?'single':type.targetMode,splitPolicy=type.splitPolicy===undefined?'review':type.splitPolicy;
  if(!['single','multiple'].includes(targetMode)||!['review','all-descendants'].includes(splitPolicy))throw new Error('Invalid property association mode or split policy.');
  if(targetMode==='multiple' && (type.targetScope==='project'||type.association==='none'))throw new Error('Multiple targets require a geometry-associated property type.');
  if(splitPolicy==='all-descendants' && (targetMode!=='multiple'||!['face','edge'].includes(type.targetScope)))throw new Error('All-descendants requires a multiple Face/Edge property type.');
  return targetMode==='multiple'?{targetMode,splitPolicy}:{};
}
