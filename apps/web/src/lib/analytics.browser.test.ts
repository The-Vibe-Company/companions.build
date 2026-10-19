// @vitest-environment node
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { expect, test } from "vitest";
import { renderInBrowser } from "../test/browser";

test("production SDK emits initial and SPA pageviews plus identity events in Chrome", async () => {
  const entry = "virtual:analytics-browser";
  const bundle = await build({
    configFile: false,
    resolve: { alias: { "posthog-js": path.resolve("node_modules/posthog-js/dist/module.mjs") } },
    logLevel: "silent",
    define: { "import.meta.env.PROD": "true", "import.meta.env.VITE_POSTHOG_KEY": JSON.stringify("test-project"), "import.meta.env.VITE_POSTHOG_HOST": JSON.stringify("http://127.0.0.1:1") },
    plugins: [{ name:"analytics-browser", resolveId(id) { if(id===entry)return id; }, load(id) { if(id===entry)return `
      import posthog from "posthog-js";
      import {initAnalytics,identifyAnalytics} from ${JSON.stringify(path.resolve("src/lib/analytics.ts"))};
      // The SDK intentionally excludes HeadlessChrome bot traffic.
      Object.defineProperty(navigator,'userAgent',{value:navigator.userAgent.replace('HeadlessChrome','Chrome')});
      Object.defineProperty(navigator,'webdriver',{value:false});
      Object.defineProperty(navigator,'userAgentData',{value:undefined});
      const events=[];
      const init=posthog.init.bind(posthog);
      posthog.init=(key,options)=>init(key,{...options,before_send:event=>{
        const sanitized=options.before_send(event);if(sanitized)events.push(sanitized);return sanitized;
      }});
      initAnalytics();initAnalytics();
      setTimeout(()=>{
        history.pushState({},'', '/account?token=private#secret');
        setTimeout(()=>{
          identifyAnalytics('persisted-user');identifyAnalytics('persisted-user');identifyAnalytics(null);
          const report=document.createElement('pre');report.id='browser-result';report.textContent=JSON.stringify({events,resetId:posthog.get_distinct_id()});document.body.append(report);
          identifyAnalytics("stale-user");
        },300);
      },300);
    `; } }],
    build: { write:false, rollupOptions:{input:entry,output:{inlineDynamicImports:true}} },
  });
  const output=(Array.isArray(bundle)?bundle:[bundle]).flatMap(item=>'output' in item?item.output:[]);
  const js=output.filter(item=>item.type==='chunk').map(item=>item.type==='chunk'?item.code:'').join('\n');
  const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/bundle.js'?'application/javascript':'text/html');response.end(request.url==='/bundle.js'?js:'<!doctype html><body><script type="module" src="/bundle.js"></script>');});
  const directory=mkdtempSync(path.join(tmpdir(),'analytics-browser-'));
  try {
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address(); if(!address||typeof address==='string')throw new Error('No server address');
    const origin=`http://127.0.0.1:${address.port}`;
    for (let visit=0;visit<2;visit++) {
      const html=await renderInBrowser({url:origin+'/?token=private#secret',profile:path.join(directory,'profile'),width:1000,height:700});
      const report=JSON.parse(html.match(/<pre id="browser-result">(.*?)<\/pre>/)![1]);
      const events=report.events;
      expect(events[0].properties.distinct_id).not.toBe('stale-user');
      expect(report.resetId).not.toBe('persisted-user');
      expect(report.resetId).not.toBe(events[0].properties.distinct_id);
      expect(events.filter((event:any)=>event.event==='$pageview').map((event:any)=>event.properties.$current_url)).toEqual([origin+'/',origin+'/account']);
      expect(events.filter((event:any)=>event.event==='$identify')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('private');
      expect(JSON.stringify(events)).not.toContain('#secret');
    }
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true}); }
},60000);
