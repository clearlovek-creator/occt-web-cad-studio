/** Exact top-K AABB gap ordering, O(K) retained pair objects. Sweep pruning is
 * safe for separated boxes; overlapping worst cases still need O(N^2) checks. */
export function nearestBoundsRelations(spatialByBody,relate,limit=32){
  if(!Number.isSafeInteger(limit)||limit<1)return [];
  const entries=[...spatialByBody.entries()].filter(([,value])=>value?.bounds).sort((a,b)=>a[1].bounds.min[0]-b[1].bounds.min[0]||compareId(a[0],b[0]));
  const heap=[],compare=(a,b)=>a.gap-b.gap||compareId(a.bodyA,b.bodyA)||compareId(a.bodyB,b.bodyB);
  const push=value=>{heap.push(value);let i=heap.length-1;while(i){const p=(i-1)>>1;if(compare(heap[p],heap[i])>=0)break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p;}};
  const replace=value=>{heap[0]=value;let i=0;while(i*2+1<heap.length){let next=i*2+1;if(next+1<heap.length&&compare(heap[next+1],heap[next])>0)next++;if(compare(heap[i],heap[next])>=0)break;[heap[i],heap[next]]=[heap[next],heap[i]];i=next;}};
  for(let first=0;first<entries.length;first++)for(let second=first+1;second<entries.length;second++){
    const [a,b]=[entries[first],entries[second]];
    if(heap.length===limit&&b[1].bounds.min[0]-a[1].bounds.max[0]>heap[0].gap)break;
    const [left,right]=compareId(a[0],b[0])<0?[a,b]:[b,a],value=relate(left[0],left[1],right[0],right[1]);
    if(heap.length<limit)push(value);else if(compare(value,heap[0])<0)replace(value);
  }
  return heap.sort(compare);
}
function compareId(a,b){return a<b?-1:a>b?1:0;}
