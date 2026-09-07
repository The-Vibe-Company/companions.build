import {expect,test} from 'bun:test';
import {waitForDesktopUrl,type DesktopProvisioningObservation} from './live-box-desktop-wait';
function fixture(responses:Array<Response|Error>){
 let time=Date.parse('2026-09-07T12:00:00.000Z'),calls=0,sleeps=0,saves=0;
 const state:{desktopProvisioning?:DesktopProvisioningObservation}={};
 return {state,now:()=>time,async request(){const response=responses[Math.min(calls++,responses.length-1)];if(response instanceof Error)throw response;return response!.clone();},async sleep(ms:number){expect(ms).toBe(500);sleeps++;time+=ms;},async save(){saves++;},get calls(){return calls;},get sleeps(){return sleeps;},get saves(){return saves;}};
}
const pending=()=>Response.json({preparing:true},{status:202});
const ready=()=>Response.json({url:'https://fixture.invalid/vnc.html?password=private&_token=private-token'});
test('explicit provisioning records safe first/last/duration/count and then accepts a ready URL without retaining it',async()=>{
 const f=fixture([pending(),pending(),ready()]);await waitForDesktopUrl(f);
 expect(f.state.desktopProvisioning).toEqual({firstObservedAt:'2026-09-07T12:00:00.000Z',lastObservedAt:'2026-09-07T12:00:00.500Z',durationMs:500,count:2});expect(f.calls).toBe(3);expect(f.sleeps).toBe(2);expect(f.saves).toBe(2);
 expect(JSON.stringify(f.state)).not.toContain('private');expect(JSON.stringify(f.state)).not.toContain('url');
});
test('the unchanged sixty-second bound reports provisioning rather than swallowing its cause',async()=>{
 const f=fixture([pending()]);await expect(waitForDesktopUrl(f)).rejects.toThrow('DESKTOP_PROVISIONING_TIMEOUT');
 expect(f.state.desktopProvisioning?.durationMs).toBe(60_500);expect(f.calls).toBe(122);expect(f.saves).toBe(122);
});
test('a rerun preserves the first observation and accumulates provisioning count',async()=>{
 const f=fixture([pending(),ready()]);f.state.desktopProvisioning={firstObservedAt:'2026-09-07T11:59:00.000Z',lastObservedAt:'2026-09-07T11:59:30.000Z',durationMs:30_000,count:5};
 await waitForDesktopUrl(f);expect(f.state.desktopProvisioning).toMatchObject({firstObservedAt:'2026-09-07T11:59:00.000Z',durationMs:60_000,count:6});
});
for(const status of [400,401,403,404,429,500,503])test(`HTTP ${status} fails immediately with only a stable status code`,async()=>{
 const f=fixture([Response.json({error:'private-provider-payload',url:'https://private.invalid/?secret=x'},{status})]);
 await expect(waitForDesktopUrl(f)).rejects.toThrow(`DESKTOP_API_${status}`);expect(f.calls).toBe(1);expect(f.sleeps).toBe(0);expect(f.saves).toBe(0);
});
for(const response of [Response.json({preparing:false},{status:202}),new Response('private malformed JSON',{status:202}),Response.json({})])test('malformed envelopes fail rather than appearing to prepare forever',async()=>{
 const f=fixture([response]);await expect(waitForDesktopUrl(f)).rejects.toThrow(response.status===202?'DESKTOP_RESPONSE_INVALID':'DESKTOP_URL_INVALID');expect(f.calls).toBe(1);expect(f.sleeps).toBe(0);
});
for(const url of ['not a URL','http://fixture.invalid','https://user:private@fixture.invalid'])test('malformed or unsafe URL fails without logging its value',async()=>{
 const f=fixture([Response.json({url})]);await expect(waitForDesktopUrl(f)).rejects.toThrow('DESKTOP_URL_INVALID');expect(f.saves).toBe(0);
});
test('a transport failure is definitive and does not expose its message',async()=>{
 const f=fixture([Error('private transport details')]);await expect(waitForDesktopUrl(f)).rejects.toThrow('DESKTOP_API_UNREACHABLE');expect(f.calls).toBe(1);expect(f.sleeps).toBe(0);
});
