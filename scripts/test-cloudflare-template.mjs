// Browser regression checks using the real useTool cache and Cloudflare read hook.
// No Cloudflare requests or credentials; failures are injected at the kit transport boundary.
// Run: node scripts/test-cloudflare-template.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { resolve } from 'node:path'
import { templatesDir } from './templates-dir.mjs'

const { outputFiles } = await build({
  stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { setTransport } from './src/kit/core.ts';
    import { useCloudflareRead } from ${JSON.stringify(resolve(templatesDir, 'cloudflare-workers/read.js'))};
    window.calls = [];
    setTransport({workspace:null,post(){},async call(connector,tool,args){
      window.calls.push({connector,tool,args});
      const error=window.failures.shift(); if(error) throw new Error(error);
      return [{id:'account',name:'Account'}];
    }});
    function App(){const q=useCloudflareRead({code:"async () => cloudflare.request({method:'GET',path:'/accounts'})"}, {enabled:window.enabled});
      window.query={data:q.data,error:q.error?.message,loading:q.loading,fetching:q.fetching};
      return <button onClick={q.reload}>Retry</button>;
    }
    const root=createRoot(document.getElementById('root')); window.unmount=()=>root.unmount();
    root.render(<React.StrictMode><App/></React.StrictMode>);
  `, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  nodePaths: [resolve('node_modules')],
  alias: { lynx: resolve('src/kit/core.ts') }, logLevel: 'silent',
});
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const errors=[];
const refresh='Token refresh is already in progress; retry shortly';
const invalid='Cloudflare API error: GET /accounts returned HTTP 403: 9109: Invalid access token. HTTP 403 means the credential was accepted but is not allowed to do this';
async function pageFor(failures, enabled=true){
  const page=await browser.newPage(); page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(({failures,enabled})=>Object.assign(window,{failures,enabled}),{failures,enabled});
  await page.addScriptTag({content:outputFiles[0].text});
  return page;
}
try{
  const recovered=await pageFor([refresh,invalid]);
  await recovered.waitForFunction(()=>window.calls.length===1 && window.query.loading);
  assert.equal(await recovered.evaluate(()=>window.query.error),undefined);
  await recovered.waitForFunction(()=>window.query.data?.[0]?.id==='account',null,{timeout:12000});
  assert.equal(await recovered.evaluate(()=>window.calls.length),3);
  assert.ok((await recovered.evaluate(()=>window.calls)).every(c=>c.connector==='cloudflare'&&c.tool==='execute'&&c.args.code.includes("method:'GET'")));
  await recovered.close(); console.log('ok: refresh/9109 recover automatically through the real cache');

  const stopped=await pageFor([invalid,invalid,invalid,invalid]);
  await stopped.waitForFunction(()=>window.query.error && !window.query.fetching,null,{timeout:15000});
  assert.equal(await stopped.evaluate(()=>window.calls.length),4);
  assert.match(await stopped.evaluate(()=>window.query.error),/reconnect Cloudflare/);
  assert.doesNotMatch(await stopped.evaluate(()=>window.query.error),/credential was accepted/);
  await stopped.waitForTimeout(1200);
  assert.equal(await stopped.evaluate(()=>window.calls.length),4);
  await stopped.getByRole('button',{name:'Retry'}).click();
  await stopped.waitForFunction(()=>!!window.query.data);
  assert.equal(await stopped.evaluate(()=>window.calls.length),5);
  await stopped.close(); console.log('ok: retries stop, explain invalid token, and manual retry recovers');

  const denied=await pageFor(['HTTP 403: Workers Scripts Read permission required']);
  await denied.waitForFunction(()=>!!window.query.error); await denied.waitForTimeout(1200);
  assert.equal(await denied.evaluate(()=>window.calls.length),1);
  assert.match(await denied.evaluate(()=>window.query.error),/permission required/);
  await denied.close(); console.log('ok: ordinary permission failures are not retried or rewritten');

  const disabled=await pageFor([],false); await disabled.waitForTimeout(100);
  assert.equal(await disabled.evaluate(()=>window.calls.length),0);await disabled.close();
  const unmounted=await pageFor([refresh]);await unmounted.waitForFunction(()=>window.calls.length===1 && window.query.loading);
  await unmounted.evaluate(()=>window.unmount());await unmounted.waitForTimeout(1200);
  assert.equal(await unmounted.evaluate(()=>window.calls.length),1);await unmounted.close();
  assert.deepEqual(errors,[]);console.log('ok: disabled reads and unmounted components do not retry');
}finally{await browser.close()}
