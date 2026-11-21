/** Remove stale objects from the scene as well as from the picking cache. */
export function pruneBodyRenderables<T extends { userData: Record<string, unknown> }>(
  group: { remove: (object: T) => unknown }, objects: T[], liveBodyIds: Set<string>, dispose: (object: T) => void,
): T[] {
  return objects.filter((object) => {
    if (liveBodyIds.has(String(object.userData.bodyId))) return true;
    group.remove(object);
    dispose(object);
    return false;
  });
}
