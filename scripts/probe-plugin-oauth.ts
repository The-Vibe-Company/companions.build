/** Live public discovery; --authorize also starts the application's consent flow, never grants it. */
import {chmodSync,mkdirSync,writeFileSync} from 'node:fs';
import {COMPANION_PLUGIN_OAUTH_SERVERS as servers} from '../packages/plugins/oauth';

const authorize=process.argv.includes('--authorize');
const apiBase=`http://127.0.0.1:${process.env.API_PORT??Number(process.env.WEB_PORT??4310)+1}/api`;
const cookie=authorize?(await Bun.file('.local/session-cookie').text()).trim():null;
async function publicJson(url:string){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15_000)});
 if(!response.ok)throw Error(`http_${response.status}`);
 return response.json() as Promise<Record<string,unknown>>;
}
const report:Array<Record<string,unknown>>=[];
const privateLinks:Array<{id:string;url:string}>=[];
for(const [id,server] of Object.entries(servers)){
 const result:Record<string,unknown>={id,provider:server.provider};
 try{
  if(server.resourceMetadataUrl){
   const metadata=await publicJson(server.resourceMetadataUrl);
   if(metadata.resource!==server.remoteUrl||!Array.isArray(metadata.authorization_servers)||!metadata.authorization_servers.includes(server.authorizationServer))throw Error('resource_metadata_changed');
   result.resourceMetadata='verified';
   if(server.provider!=='github'){
    const metadataUrl='authorizationMetadataUrl' in server?server.authorizationMetadataUrl:`${server.authorizationServer}/.well-known/oauth-authorization-server`;
    const authorization=await publicJson(metadataUrl);
    for(const key of ['authorization_endpoint','token_endpoint',...(server.dynamicRegistration?['registration_endpoint']:[])]){
     const value=authorization[key];
     if(typeof value!=='string'||!(server.allowedOrigins as readonly string[]).includes(new URL(value).origin))throw Error('authorization_metadata_changed');
    }
    result.authorizationMetadata='verified';
   }
  }else result.resourceMetadata='not_applicable';
  if(authorize){
   const response=await fetch(`${apiBase}/plugins/connect`,{method:'POST',headers:{cookie:cookie!,'content-type':'application/json'},body:JSON.stringify({serverId:id,label:`${server.provider} verification`}),signal:AbortSignal.timeout(30_000)});
   const body=await response.json() as {url?:unknown};
   if(!response.ok){result.authorizationStart=`http_${response.status}`;}
   else{
    if(typeof body.url!=='string')throw Error('authorization_url_missing');
    const url=new URL(body.url);
    if(!(server.allowedOrigins as readonly string[]).includes(url.origin)||!url.searchParams.get('state')||(server.provider!=='slack'&&url.searchParams.get('code_challenge_method')!=='S256'))throw Error('authorization_parameters_invalid');
    privateLinks.push({id,url:body.url});result.authorizationStart='consent_required';
   }
  }
 }catch(error){
  const code=error instanceof Error?error.message:'';
  result.error=/^(http_[0-9]{3}|resource_metadata_changed|authorization_metadata_changed|authorization_url_missing|authorization_parameters_invalid)$/.test(code)?code:'probe_failed';
 }
 report.push(result);
}
mkdirSync('.artifacts/plugin-oauth',{recursive:true});
const evidence={observedAt:new Date().toISOString(),scope:authorize?'discovery_and_consent_start':'public_discovery',providers:report};
writeFileSync('.artifacts/plugin-oauth/report.json',JSON.stringify(evidence,null,2));
if(authorize){mkdirSync('.local',{recursive:true,mode:0o700});writeFileSync('.local/plugin-oauth-consent.json',JSON.stringify(privateLinks),{mode:0o600});chmodSync('.local/plugin-oauth-consent.json',0o600);}
console.log(JSON.stringify(evidence,null,2));
if(report.some(result=>result.error))process.exitCode=1;
