import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {config} from './config';

const MAX_LIFETIME_MS=6*60*60*1000;
const CLOCK_SKEW_MS=60_000;
const purpose='companions.build/model-gateway/v1\0';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ModelGatewayClaims={companionId:string;runId:string;credentialDigest:string;expiresAt:number};
function sign(payload:string){return createHmac('sha256',config.authSecret).update(purpose).update(payload).digest();}
/** Binds access to one accepted run and the current encrypted agent credential. */
export function mintModelGatewayToken(companionId:string,runId:string,agentSecret:string,expiresAt=Date.now()+MAX_LIFETIME_MS){
 if(!uuid.test(companionId)||!uuid.test(runId)||!agentSecret||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+MAX_LIFETIME_MS)throw Error('MODEL_GATEWAY_TOKEN_INVALID');
 const claims={companionId,runId,credentialDigest:createHash('sha256').update(agentSecret).digest('hex'),expiresAt,issuedAt:Date.now()};
 const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
 return `${payload}.${sign(payload).toString('base64url')}`;
}
export function verifyModelGatewayToken(token:string):ModelGatewayClaims|null{
 if(typeof token!=='string'||token.length>1024)return null;
 const parts=token.split('.');if(parts.length!==2||parts.some(part=>!/^[-_a-zA-Z0-9]+$/.test(part)))return null;
 const expected=sign(parts[0]),signature=Buffer.from(parts[1],'base64url');
 if(signature.length!==expected.length||!timingSafeEqual(signature,expected))return null;
 try{
  const value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
  if(!value||typeof value.companionId!=='string'||typeof value.runId!=='string'||!uuid.test(value.companionId)||!uuid.test(value.runId)||!/^[a-f0-9]{64}$/.test(value.credentialDigest)||!Number.isSafeInteger(value.expiresAt)||!Number.isSafeInteger(value.issuedAt)||value.expiresAt<=Date.now()||value.issuedAt>Date.now()+CLOCK_SKEW_MS||value.expiresAt<=value.issuedAt||value.expiresAt-value.issuedAt>MAX_LIFETIME_MS)return null;
  return {companionId:value.companionId,runId:value.runId,credentialDigest:value.credentialDigest,expiresAt:value.expiresAt};
 }catch{return null;}
}
