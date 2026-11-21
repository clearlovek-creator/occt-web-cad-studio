import {registerHooks} from 'node:module';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const app=new URL('../../app/',import.meta.url).href;
// Render actual TSX using the project's own installed React, without a bundler,
// a fake replacement component, DOM effects, network or model credentials.
registerHooks({
  resolve(specifier,context,next){
    if(specifier.startsWith('.')&&context.parentURL?.startsWith(app)&&! /\.[a-z]+$/i.test(specifier)){
      for(const extension of ['.ts','.tsx']){const url=new URL(specifier+extension,context.parentURL);if(fs.existsSync(fileURLToPath(url)))return next(url.href,context);}
    }
    return next(specifier,context);
  },
  load(url,context,next){if(url.startsWith(app)&&/\.tsx?$/.test(url))return {format:'module',source:ts.transpileModule(fs.readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);},
});
export async function renderPiPanel(){const {PiModelingAgentPanel}=await import('../../app/PiModelingAgentPanel.tsx');return renderToStaticMarkup(React.createElement(PiModelingAgentPanel,{revision:17,selection:null}));}
export async function legacyPiAlias(){const legacy=await import('../../app/ModelingAgentPanel.tsx'),native=await import('../../app/PiModelingAgentPanel.tsx');return legacy.ModelingAgentPanel===native.PiModelingAgentPanel;}
