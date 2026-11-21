/** A conforming chain of cubes, split by one consistent diagonal. Partial final
 * cubes remain unions of positive tetrahedra; no repeated synthetic cell keys. */
export function tetraStrip(count, template) {
  const cubes = Math.ceil(count / 6), positions = [], cells = [], exterior = new Set();
  for (let x = 0; x <= cubes; x++) positions.push(x,0,0, x,1,0, x,0,1, x,1,1);
  const patterns = [[0,1,3,7],[0,5,1,7],[0,3,2,7],[0,2,6,7],[0,4,5,7],[0,6,4,7]];
  for (let x = 0; x < cubes; x++) {
    const nodes = [4*x,4*(x+1),4*x+1,4*(x+1)+1,4*x+2,4*(x+1)+2,4*x+3,4*(x+1)+3];
    for (const pattern of patterns) {
      if (cells.length === count) break;
      const corners = pattern.map(i => nodes[i]);
      cells.push({ ...template, elementId: String(cells.length + 1), corners });
      for (let omitted = 0; omitted < 4; omitted++) {
        const face = corners.filter((_, i) => i !== omitted).sort((a,b) => a-b).join(',');
        if (exterior.has(face)) exterior.delete(face); else exterior.add(face);
      }
    }
  }
  return { positions, cells, boundaryFaceCount: exterior.size };
}
