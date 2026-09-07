import {afterAll,beforeAll,expect,test} from 'bun:test';
import {config,encrypt} from '../src/config';
import {environmentDigest,ExecutionStopped,MachineError,prepareBox} from '../src/machines';
import {BoxClient} from '../../../packages/box/client';
const priorTemplate=config.boxTemplate;
beforeAll(()=>{config.boxTemplate='rediscovery-fixture';});
afterAll(()=>{config.boxTemplate=priorTemplate;});
function fixture(){
 const secret=encrypt('fixture-agent-token'),c:any={id:'11111111-1111-4111-8111-111111111111',box_id:'owned-box',agent_secret:secret,endpoint_secret:null,config_digest:environmentDigest(secret)};
 const events:string[]=[];let state='ready',setup:string|undefined='done',reportedId='owned-box',owned=true,hostFailure=false,health:any={ready:true},after:string|undefined;
 const client=new BoxClient('fixture-box-key',(async(input:URL|RequestInfo,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,method=init?.method??'GET';
  if(method==='GET'){events.push('get');if(after==='get')owned=false;return Response.json({box:{id:reportedId,state,setupStatus:setup}});}
  if(path.endsWith('/resume')){events.push('resume');return Response.json({success:true});}
  if(path.endsWith('/boxes')){events.push('create');return Response.json({box:{id:'owned-box',state:'ready'}});}
  if(path.endsWith('/files')){events.push('environment');return Response.json({success:true});}
  const command=JSON.parse(String(init?.body)).command;
  if(command.startsWith('host ')){
   events.push('host');if(after==='host')owned=false;
   if(hostFailure){hostFailure=false;return new Response(null,{status:503});}
   return Response.json({success:true,exitCode:0,stdout:'https://fixture.on.ascii.dev?_token=synthetic'});
  }
  events.push('services');return Response.json({success:true,exitCode:0,stdout:''});
 }) as typeof fetch);
 const probe=async(endpoint:string,token:string)=>{
  events.push('health');expect(endpoint).toBe('https://fixture.on.ascii.dev/?_token=synthetic');expect(token).toBe('fixture-agent-token');
  expect(c.endpoint_secret).toBeNull();if(after==='health')owned=false;if(health instanceof Error)throw health;return health;
 };
 const run=()=>prepareBox(c,async id=>{events.push('checkpoint');expect(id).toBe('owned-box');},async()=>{events.push('configured');},async()=>{if(!owned)throw new ExecutionStopped('fixture lost authority');},client,probe);
 return {c,events,run,setState(value:string,valueSetup?:string){state=value;setup=valueSetup;},failHost(){hostFailure=true;},health(value:any){health=value;},loseAfter(value:string){after=value;},reportId(value:string){reportedId=value;}};
}
for(const state of ['ready','idle','running'])test(`known ${state} Box with applied config reuses an authenticated private preview without environment or service effects`,async()=>{
 const f=fixture();f.setState(state,'done');expect(await f.run()).toBe('https://fixture.on.ascii.dev/?_token=synthetic');
 expect(f.events).toEqual(['get','host','health']);expect(f.c.endpoint_secret).toBeNull();
});
for(const value of [null,{ready:false},{ready:'true'},new MachineError('agent_auth_expired'),new Error('fixture health timeout')])test('failed rediscovery probes once then takes the existing configuration path',async()=>{
 const f=fixture();f.health(value);expect(await f.run()).toContain('fixture.on.ascii.dev');
 expect(f.events).toEqual(['get','host','health','environment','services','configured','host']);expect(f.c.endpoint_secret).toBeNull();
});
test('unavailable private hosting falls back rather than returning an unverified endpoint',async()=>{
 const f=fixture();f.failHost();expect(await f.run()).toContain('fixture.on.ascii.dev');
 expect(f.events).toEqual(['get','host','environment','services','configured','host']);
});
for(const stage of ['get','host','health'])test(`authority loss after ${stage} stops all later effects and checkpoints`,async()=>{
 const f=fixture();f.loseAfter(stage);await expect(f.run()).rejects.toBeInstanceOf(ExecutionStopped);
 expect(f.events).toEqual(stage==='get'?['get']:stage==='host'?['get','host']:['get','host','health']);
});
test('an ExecutionStopped from the probe is never converted into repair',async()=>{
 const f=fixture();f.health(new ExecutionStopped('fixture stopped'));await expect(f.run()).rejects.toBeInstanceOf(ExecutionStopped);expect(f.events).toEqual(['get','host','health']);
});
test('a changed environment takes normal configuration without a preview probe',async()=>{
 const f=fixture();f.c.config_digest='old';await f.run();expect(f.events).toEqual(['get','environment','services','configured','host']);
});
test('a new Box never uses the rediscovery path even if passed a matching digest',async()=>{
 const f=fixture();f.c.box_id=null;await f.run();expect(f.events).toEqual(['create','checkpoint','get','environment','services','configured','host']);
});
for(const [state,setup,expected] of [['archived',undefined,['get','resume']],['provisioning',undefined,['get']],['ready','pending',['get']],['ready','running',['get']]] as const)test(`provider ${state}/${setup} does not probe before readiness`,async()=>{
 const f=fixture();f.setState(state,setup);expect(await f.run()).toBeNull();expect(f.events).toEqual([...expected]);
});
test('failed setup fails closed instead of probing a potentially old daemon',async()=>{
 const f=fixture();f.setState('ready','failed');await expect(f.run()).rejects.toThrow('box_setup_failed');expect(f.events).toEqual(['get']);
});
test('a provider response for another Box cannot publish or probe a preview',async()=>{
 const f=fixture();f.reportId('other-box');await expect(f.run()).rejects.toThrow('box_identity_mismatch');expect(f.events).toEqual(['get']);
});
