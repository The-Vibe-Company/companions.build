import {expect,test} from 'bun:test';
import {config} from '../src/config';
import {availableModels,validateModel} from '../src/models';

test('Azure catalog offers only the configured Foundry deployment',async()=>{
 const previous={testMode:config.testMode,modelProvider:config.modelProvider,modelId:config.modelId};
 try{
  Object.assign(config,{testMode:false,modelProvider:'azure',modelId:'gpt-5.6-luna'});
  expect(await availableModels()).toEqual([{id:'gpt-5.6-luna',name:'Great',isDefault:true}]);
  await expect(validateModel('gpt-5.6-luna')).resolves.toBeUndefined();
  await expect(validateModel('gpt-5.6-sol')).rejects.toThrow('MODEL_UNAVAILABLE');
 }finally{Object.assign(config,previous);}
});


test('Great is the default and Fast is the only additional hosted choice when enabled',async()=>{
 const previous={testMode:config.testMode,modelProvider:config.modelProvider,modelId:config.modelId,modelGatewayUrl:config.modelGatewayUrl,deepseekEnabled:config.deepseekEnabled};
 try{
  Object.assign(config,{testMode:false,modelProvider:'azure',modelId:'gpt-5.6-luna',modelGatewayUrl:'https://fixture.invalid/api/model-gateway',deepseekEnabled:true});
  expect(await availableModels()).toEqual([{id:'gpt-5.6-luna',name:'Great',isDefault:true},{id:'deepseek-flash',name:'Fast'}]);
  await expect(validateModel('deepseek-flash')).resolves.toBeUndefined();
  await expect(validateModel('deepseek-v4-pro')).rejects.toThrow('MODEL_UNAVAILABLE');
  config.deepseekEnabled=false;await expect(validateModel('deepseek-flash')).rejects.toThrow('MODEL_UNAVAILABLE');
  config.deepseekEnabled=true;config.modelGatewayUrl=undefined;
  await expect(validateModel('deepseek-flash')).rejects.toThrow('MODEL_UNAVAILABLE');
 }finally{Object.assign(config,previous);}
});
