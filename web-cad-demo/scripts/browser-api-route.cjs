/* Keeps every UI verifier isolated for both absolute dev APIs and same-origin releases. */
function geometryApiUrl(value,targetApi){
  const source=new URL(value),target=new URL(targetApi);
  if(source.pathname!=='/api'&&!source.pathname.startsWith('/api/'))throw Error('Not a geometry API route.');
  return target.href.replace(/\/$/,'')+source.pathname.slice(4)+source.search;
}
async function routeGeometryApi(page,targetApi,workbenchUrl=process.env.WORKBENCH_URL||'http://localhost:3000/'){
  const origins=new Set(['http://127.0.0.1:8788',new URL(workbenchUrl).origin]);
  await page.route(url=>origins.has(url.origin)&&(url.pathname==='/api'||url.pathname.startsWith('/api/')),route=>route.continue({url:geometryApiUrl(route.request().url(),targetApi)}));
}
module.exports={geometryApiUrl,routeGeometryApi};
