/* Collect local license evidence only. Never calls a publisher, installs a
 * package, selects a release, or upgrades incomplete evidence to compliance. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {hashFile,readSmallJson,assertRegularDirectory} from '../gateway/frontend-release.mjs';

const root=path.resolve(import.meta.dirname,'..'),build=path.resolve(process.argv[2]||'.artifacts/discrete-worker-native-final'),output=path.resolve(process.argv[3]||'.artifacts/discrete-license-inputs');
for(const directory of [build,output])assert.ok(directory.startsWith(path.join(root,'.artifacts')+path.sep));
assert.ok(!fs.existsSync(output),'Keep earlier license evidence; use a fresh output directory.');
for(let p=path.dirname(output);p!==root;p=path.dirname(p))if(fs.existsSync(p))assertRegularDirectory(p);
const receiptFile=path.join(build,'build.json'),buildSha=hashFile(receiptFile),buildReceipt=readSmallJson(receiptFile),dependencyRoot=path.join(root,'.artifacts/discrete-dependencies');
assert.equal(buildReceipt.format,'web-cad-discrete-surface-worker-build');assert.equal(buildReceipt.license.spdx,'GPL-3.0-or-later');
fs.mkdirSync(output);const captures=[];
function capture(source,relative){
  const stat=fs.lstatSync(source);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=1024**2,'License input must be a bounded regular file.');
  assert.ok(!relative.split('/').some(segment=>!segment||segment==='.'||segment==='..'||/[\\:]/.test(segment)));
  const expected=hashFile(source),destination=path.join(output,...relative.split('/'));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);assert.equal(hashFile(destination),expected);assert.equal(hashFile(source),expected);
  const item={file:relative,bytes:stat.size,sha256:expected};captures.push(item);return item;
}
function metadataField(text,name){const match=text.match(new RegExp('%'+name+'%\\r?\\n([\\s\\S]*?)(?:\\r?\\n\\r?\\n|$)'));assert.ok(match,'Missing package field '+name);return match[1].trim();}
const coreLicenses=['LICENSE','LICENSE.GPL','LICENSE.LGPL','LICENSE.BSL'].map(file=>capture(path.join(dependencyRoot,'CGAL-6.1.2',file),'cgal/'+file));
const boostLicense=capture(path.join(dependencyRoot,'boost_1_88_0/LICENSE_1_0.txt'),'boost/LICENSE_1_0.txt');
const ownLicense=capture(path.join(root,'discrete-surface-worker/LICENSE'),'worker/LICENSE');
const packages=[];
for(const [dll,name]of [['libgcc_s_seh-1.dll','gcc-libs'],['libgmp-10.dll','gmp'],['libmpfr-6.dll','mpfr'],['libwinpthread-1.dll','libwinpthread']]){
  const packageName='mingw-w64-ucrt-x86_64-'+name,local='C:/msys64/var/lib/pacman/local',matches=fs.readdirSync(local).filter(file=>file.startsWith(packageName+'-'));
  assert.equal(matches.length,1,'Expected one exact installed package identity.');const directory=path.join(local,matches[0]),desc=fs.readFileSync(path.join(directory,'desc'),'utf8'),files=fs.readFileSync(path.join(directory,'files'),'utf8');
  assert.equal(metadataField(desc,'NAME'),packageName);assert.ok(files.split(/\r?\n/).includes('ucrt64/bin/'+dll));
  const runtime=buildReceipt.runtime.files.find(item=>item.file.toLowerCase()===dll),actual=path.join('C:/msys64/ucrt64/bin',dll);assert.ok(runtime);assert.equal(hashFile(actual),runtime.sha256);assert.equal(hashFile(path.join(build,'runtime',dll)),runtime.sha256);
  const metadata=[capture(path.join(directory,'desc'),name+'/package-desc'),capture(path.join(directory,'files'),name+'/package-files')],notices=[];
  if(name==='gcc-libs')for(const file of ['COPYING3','COPYING.LIB','COPYING.RUNTIME','README'])notices.push(capture(path.join('C:/msys64/ucrt64/share/licenses/gcc-libs',file),name+'/'+file));
  if(name==='libwinpthread')notices.push(capture('C:/msys64/ucrt64/share/licenses/libwinpthread/COPYING',name+'/COPYING'));
  packages.push({name:packageName,version:metadataField(desc,'VERSION'),packageReportedLicense:metadataField(desc,'LICENSE'),runtime:{file:dll,sha256:runtime.sha256},metadata,notices,correspondingSourceQualification:'not-collected',noticeQualification:notices.length?'captured-package-notices-not-a-legal-compatibility-opinion':'package-does-not-install-license-text-separately'});
}
assert.equal(hashFile(receiptFile),buildSha);
const result={format:'web-cad-discrete-license-inputs',version:1,createdAt:new Date().toISOString(),build:{file:path.relative(root,receiptFile).replaceAll('\\','/'),sha256:buildSha},route:{selected:'GPL-3.0-or-later',commercialLicenseUsed:false,separateProcessExemptionClaimed:false,wholeRepositoryRelicensed:false},workerLicense:ownLicense,cgalLicenses:coreLicenses,boostLicense,archives:buildReceipt.archives,packages,staticCompilerRuntime:{present:true,flags:['-static-libgcc','-static-libstdc++'],qualification:'exact-static-library-and-corresponding-source-closure-incomplete'},distributionGate:{state:'blocked',code:'DISCRETE_CORRESPONDING_SOURCE_INCOMPLETE',remaining:['Exact corresponding source, package build recipes and patches for the actual runtime and static compiler libraries.','A reproducible source bundle containing this worker and shared JSON/resource-guard sources.','GMP/MPFR notices and license compatibility review for the combined distributed product.'],publicDistributionQualified:false},captures,dailyServicesChanged:false};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,output,packages:packages.length,licenseFiles:captures.length,distributionGate:result.distributionGate.state,dailyServicesChanged:false}));
