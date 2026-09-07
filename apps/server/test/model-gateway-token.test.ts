import {test,expect,spyOn} from 'bun:test';
import {createHash} from 'node:crypto';
import {mintModelGatewayToken,verifyModelGatewayToken} from '../src/model-gateway-token';
import {config} from '../src/config';
import {modelEnvironment} from '../src/machines';

test('model access binds one run and companion, expires and rejects tampering',()=>{
 const companionId=crypto.randomUUID(),runId=crypto.randomUUID(),secret='synthetic-encrypted-credential';
 const expiresAt=Date.now()+30_000,token=mintModelGatewayToken(companionId,runId,secret,expiresAt);
 expect(verifyModelGatewayToken(token)).toEqual({companionId,runId,credentialDigest:createHash('sha256').update(secret).digest('hex'),expiresAt});
 const [body,signature]=token.split('.');
 const changed=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body,'base64url').toString()),runId:crypto.randomUUID()})).toString('base64url');
 expect(verifyModelGatewayToken(`${changed}.${signature}`)).toBeNull();
 expect(verifyModelGatewayToken(token+'.extra')).toBeNull();
 expect(verifyModelGatewayToken('malformed')).toBeNull();
 expect(()=>mintModelGatewayToken(companionId,runId,secret,Date.now()-1)).toThrow('MODEL_GATEWAY_TOKEN_INVALID');
 expect(()=>mintModelGatewayToken(companionId,runId,secret,Date.now()+7*3600_000)).toThrow('MODEL_GATEWAY_TOKEN_INVALID');
 const previous=config.authSecret;
 try{config.authSecret='other-server-secret';expect(verifyModelGatewayToken(token)).toBeNull();}finally{config.authSecret=previous;}
});

test('separate API and executor clocks tolerate small skew without extending expired access',()=>{
 const now=Date.now(),clock=spyOn(Date,'now').mockReturnValue(now);
 try{
  const token=mintModelGatewayToken(crypto.randomUUID(),crypto.randomUUID(),'synthetic');
  clock.mockReturnValue(now-5_000);expect(verifyModelGatewayToken(token)).not.toBeNull();
  clock.mockReturnValue(now-61_000);expect(verifyModelGatewayToken(token)).toBeNull();
  clock.mockReturnValue(now+6*3600_000);expect(verifyModelGatewayToken(token)).toBeNull();
 }finally{clock.mockRestore();}
});

test('gateway Box environment contains no global provider credential for every supported provider',()=>{
 const previous={testMode:config.testMode,modelGatewayUrl:config.modelGatewayUrl,modelProvider:config.modelProvider};
 const keys=['GOOGLE_API_KEY','GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','OPENROUTER_API_KEY','ZAI_API_KEY'];
 const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  config.testMode=false;config.modelGatewayUrl='https://fixture.invalid/api/model-gateway';
  for(const key of keys)process.env[key]='synthetic-platform-key';
  for(const provider of ['google','anthropic','openai','openrouter','zai']){
   config.modelProvider=provider;
   const env=modelEnvironment('synthetic-agent-secret');
   expect(env.MODEL_GATEWAY_URL).toBe(config.modelGatewayUrl);
   expect(Object.keys(env).some(key=>key.endsWith('API_KEY'))).toBe(false);
   expect(JSON.stringify(env)).not.toContain('synthetic-platform-key');
  }
 }finally{
  Object.assign(config,previous);
  for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});

test('hosted preparation refuses direct provider credentials even if gateway config is missing',()=>{
 const previous={testMode:config.testMode,modelGatewayUrl:config.modelGatewayUrl},nodeEnv=process.env.NODE_ENV;
 try{
  config.testMode=false;config.modelGatewayUrl=undefined;process.env.NODE_ENV='production';
  expect(()=>modelEnvironment('synthetic')).toThrow('model_gateway_required');
 }finally{Object.assign(config,previous);if(nodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=nodeEnv;}
});
