const NAMES=new Map([['--frontend-root','frontendRoot'],['--backend-root','backendRoot'],['--node-material','nodeSourceMaterial'],['--output-root','outputRoot']]);
export function parseWorkbenchBundleArguments(args){
  const options={};
  if(!Array.isArray(args)||args.length!==NAMES.size*2)throw Error('Exactly one value for each frontend/backend root, Node material and output root is required.');
  for(let index=0;index<args.length;index+=2){
    const name=NAMES.get(args[index]),value=args[index+1];
    if(!name||Object.hasOwn(options,name)||typeof value!=='string'||!value.trim()||value.startsWith('--'))throw Error('Invalid, duplicate or missing workbench bundle argument.');
    // Preserve operator spelling until the filesystem admission can reject
    // drive-relative paths, device namespaces and ambiguous Windows aliases.
    options[name]=value;
  }
  if(Object.keys(options).length!==NAMES.size)throw Error('All workbench bundle paths are required.');
  return options;
}
