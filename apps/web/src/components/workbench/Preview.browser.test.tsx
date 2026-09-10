// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { expect, it } from "vitest";

it.each([390, 1440])("isolates generated documents and keeps chat/modules usable in Chromium at %ipx", async width => {
  const directory = mkdtempSync(path.join(tmpdir(), "workbench-preview-"));
  const networkRequests: string[] = [];
  const server = createServer((request, response) => { networkRequests.push(request.url ?? ""); response.end("unexpected external request"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server");
  const external = `http://127.0.0.1:${address.port}/leak`;
  try {
    const harness = path.join(directory, "harness.tsx");
    writeFileSync(harness, `
      import React from ${JSON.stringify(path.resolve("node_modules/react/index.js"))};
      import {createRoot} from ${JSON.stringify(path.resolve("node_modules/react-dom/client.js"))};
      import {CompanionWorkbench} from ${JSON.stringify(path.resolve("src/components/workbench/CompanionWorkbench.tsx"))};
      import {ChatViewport} from ${JSON.stringify(path.resolve("src/components/ChatViewport.tsx"))};
      import {safePreviewDocument} from ${JSON.stringify(path.resolve("src/components/workbench/preview.ts"))};
      import {api} from ${JSON.stringify(path.resolve("src/api.ts"))};
      let reads=0;api.workbench=async()=>{reads++;return {revisions:[],events:[],hasMore:false};};
      const detail={companion:{id:'00000000-0000-4000-8000-000000000001',profileId:'design-v1',name:'Design',instructions:'An editorial website',provider:'local',status:'ready'},messages:[],runs:[],activity:[]};
      createRoot(document.getElementById('app')).render(<CompanionWorkbench detail={detail} refreshVersion={0}><section className="chat-column"><ChatViewport storageKey="workbench-browser" entries={[]} ready={true} loading={false} older={false} onOlder={()=>{}} error="" onRetry={()=>{}}><div style={{height:900}}>Persistent chat</div></ChatViewport><div className="test-composer" style={{height:160,flexShrink:0}}>Composer</div></section></CompanionWorkbench>);
      const frame=document.createElement('iframe'); frame.setAttribute('sandbox',''); frame.referrerPolicy='no-referrer';
      const malicious='<h1>Design</h1><script>parent.compromised=true;fetch(${JSON.stringify(external)})<\\/script><img src="${external}" onerror="parent.compromised=true"><meta http-equiv="refresh" content="0;url=${external}"><a href="${external}" target="_top">Go</a><style>body{background-image:url(${external})}</style>';
      frame.srcdoc=safePreviewDocument(malicious);document.body.append(frame);
      const raw=document.createElement('iframe');raw.setAttribute('sandbox','');raw.srcdoc='<script>parent.compromised=true<\\/script>';document.body.append(raw);
      setTimeout(()=>{
        let opaque=false;try{opaque=frame.contentDocument===null;}catch{opaque=true;}
        const composer=document.querySelector('.test-composer');
        const contained=composer.getBoundingClientRect().bottom<=document.querySelector('.workbench-chat').getBoundingClientRect().bottom+1;
        const modules=[...document.querySelectorAll('.workbench-modules button')];
        const brief=modules.find(button=>button.getAttribute('aria-label')==='Design brief');
        if(brief)brief.click();
        setTimeout(()=>{
          const rect=brief?.getBoundingClientRect();
          const exposed=brief ? brief.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)) : false;
          const checks={moduleExposed:exposed,composerContained:contained,hostSafe:window.compromised!==true,opaque,noOverflow:document.documentElement.scrollWidth<=innerWidth,chatPresent:document.querySelector('.workbench-chat').textContent.includes('Persistent chat'),stagePresent:!!document.querySelector('.studio-stage'),briefVisible:!!document.querySelector('.design-brief-text'),moduleCount:modules.length,workbenchReads:reads};
          const result=document.createElement('pre');result.id='browser-result';result.textContent=JSON.stringify(checks);document.body.append(result);
        },100);
      },1000);
    `);
    const result = await build({ configFile: false, logLevel: "silent", plugins: [react()], resolve: { alias: { "@": path.resolve("src"), "react": path.resolve("node_modules/react"), "react-dom": path.resolve("node_modules/react-dom") } }, build: { write: false, minify: false, rollupOptions: { input: harness } } });
    const output = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
    const js = output.filter(item => item.type === "chunk").map(item => item.type === "chunk" ? item.code : "").join("\n");
    const css = output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.type === "asset" ? String(item.source) : "").join("\n");
    writeFileSync(path.join(directory, "app.js"), js);
    const html = path.join(directory, "index.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}#app{height:700px;width:${width}px;max-width:100%}.chat-column{display:flex;min-width:0;flex:1;flex-direction:column;position:relative}.conversation-content{min-height:100%}iframe{max-width:100%}${css}</style><div id="app"></div><script type="module" src="./app.js"></script>`);
    const { stdout } = await promisify(execFile)(process.env.CHROME_BIN || "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--disable-sync", "--allow-file-access-from-files", "--virtual-time-budget=5000", `--window-size=${width},900`, `--user-data-dir=${path.join(directory, "profile")}`, "--dump-dom", pathToFileURL(html).href], { encoding: "utf8", timeout: 45_000 });
    const found = stdout.match(/<pre id="browser-result">(.*?)<\/pre>/);
    expect(found, stdout.slice(-2500)).not.toBeNull();
    expect(JSON.parse(found![1])).toEqual({ moduleExposed: width > 1000, composerContained: true, hostSafe: true, opaque: true, noOverflow: true, chatPresent: true, stagePresent: width > 1000, briefVisible: width > 1000, moduleCount: width > 1000 ? 3 : 0, workbenchReads: width > 1000 ? 1 : 0 });
    expect(networkRequests).toEqual([]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
