// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { expect, it } from 'vitest';

it.each([390, 1200])('preserves real browser reading geometry at %ipx', async width => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chat-reading-'));
  try {
    const harness = path.join(directory, 'harness.tsx');
    writeFileSync(harness, `
      import React from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};
      import {createRoot} from ${JSON.stringify(path.resolve('node_modules/react-dom/client.js'))};
      import {flushSync} from ${JSON.stringify(path.resolve('node_modules/react-dom/index.js'))};
      import {ChatViewport} from ${JSON.stringify(path.resolve('src/components/ChatViewport.tsx'))};
      import {readingKey,readPosition} from ${JSON.stringify(path.resolve('src/lib/chat-reading.ts'))};
      const checks = {};
      let rows = Array.from({length:60},(_,i)=>i+10), extraHeight = false, olderCalls = 0, loading = false;
      let root = createRoot(document.getElementById('app'));
      const entry = n => ({id:'message-'+n,kind:'message',createdAt:new Date(n*1000).toISOString(),sequence:0,cursor:String(n),runId:'run-'+n});
      const render = (id='a') => flushSync(()=>root.render(<ChatViewport key={id} storageKey={readingKey('browser',id)} entries={rows.map(entry)} ready={true} loading={loading} older={true} onOlder={()=>olderCalls++} error="" onRetry={()=>{}} latestId={String(rows.at(-1))}>
        {rows.map(n=><div data-chat-id={'message-'+n} key={n} style={{height:extraHeight&&n===12?240:80,flexShrink:0}}>Message {n}</div>)}
      </ChatViewport>));
      const wait = () => new Promise(resolve=>setTimeout(resolve,100));
      const viewport=()=>document.querySelector('.chat-viewport');
      const top=n=>document.querySelector('[data-chat-id="message-'+n+'"]').getBoundingClientRect().top-viewport().getBoundingClientRect().top;
      const scrollTo=n=>{viewport().scrollTop+=top(n)-13;viewport().dispatchEvent(new Event('scroll'));};
      const close=(a,b)=>Math.abs(a-b)<=2;
      async function run(){
        render(); await wait();
        checks.initialBottom = close(viewport().scrollHeight-viewport().clientHeight,viewport().scrollTop);
        scrollTo(35); await wait(); const anchor=top(35);
        checks.savedHistory = !readPosition(readingKey('browser','a')).bottom;
        rows=[...rows,70];render();await wait();checks.appendStable=close(top(35),anchor);
        rows=[1,2,3,...rows];render();await wait();checks.prependStable=close(top(35),anchor);
        extraHeight=true;render();await wait();checks.resizeStable=close(top(35),anchor);
        document.getElementById('app').style.display='none';rows=[...rows,72];render('a');await wait();document.getElementById('app').style.display='flex';await wait();checks.sectionRestores=close(top(35),anchor);
        render('b');await wait();checks.otherStartsAtBottom=close(viewport().scrollHeight-viewport().clientHeight,viewport().scrollTop);
        render('a');await wait();checks.switchRestores=close(top(35),anchor);
        root.unmount();root=createRoot(document.getElementById('app'));render('a');await wait();checks.remountRestores=close(top(35),anchor);
        rows=rows.filter(n=>n!==35);render();await wait();checks.deletedAnchor=close(top(36),anchor);
        document.querySelector('.chat-latest').click();await wait();rows=[...rows,71];render();await wait();checks.followBottom=close(viewport().scrollHeight-viewport().clientHeight,viewport().scrollTop);
        loading=true;render();viewport().scrollTop=0;viewport().dispatchEvent(new Event('scroll'));await wait();const beforeLoad=olderCalls;loading=false;render();await wait();checks.loadOlder=olderCalls>beforeLoad;
        checks.noSmoothScroll=getComputedStyle(viewport()).scrollBehavior==='auto';
      }
      run().catch(error=>{checks.error=String(error)}).finally(()=>{const output=document.createElement('pre');output.id='browser-result';output.textContent=JSON.stringify(checks);document.body.append(output);});
    `);
    const bundle = await build({ configFile: false, logLevel: 'silent', plugins: [react()], resolve: { alias: { '@': path.resolve('src'), 'react': path.resolve('node_modules/react'), 'react-dom': path.resolve('node_modules/react-dom') } }, build: { write: false, minify: false, rollupOptions: { input: harness } } });
    const output = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(item => 'output' in item ? item.output : []);
    const js = output.filter(item => item.type === 'chunk').map(item => item.type === 'chunk' ? item.code : '').join('\n');
    const css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.type === 'asset' ? String(item.source) : '').join('\n');
    writeFileSync(path.join(directory, 'app.js'), js);
    const html = path.join(directory, 'index.html');
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{margin:0}#app{height:500px;display:flex;width:${width}px}.conversation-content{box-sizing:border-box;min-height:100%;padding:20px}.chat-page-control{height:40px}${css}</style><div id="app"></div><script type="module" src="./app.js"></script>`);
    const dom = execFileSync(process.env.CHROME_BIN || 'google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync', '--allow-file-access-from-files', '--virtual-time-budget=10000', `--window-size=${width},700`, `--user-data-dir=${path.join(directory, 'profile')}`, '--dump-dom', pathToFileURL(html).href], { encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const found = dom.match(/<pre id="browser-result">(.*?)<\/pre>/);
    expect(found, dom.slice(-3000)).not.toBeNull();
    expect(JSON.parse(found![1])).toEqual({ initialBottom:true, savedHistory:true, appendStable:true, prependStable:true, resizeStable:true, sectionRestores:true, otherStartsAtBottom:true, switchRestores:true, remountRestores:true, deletedAnchor:true, followBottom:true, loadOlder:true, noSmoothScroll:true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
