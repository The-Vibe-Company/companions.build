import {expect,test} from 'bun:test';
import {config} from '../src/config';
import {availableModels,validateModel} from '../src/models';

test('Azure catalog offers only the configured Foundry deployment',async()=>{
 const previous={testMode:config.testMode,modelProvider:config.modelProvider,modelId:config.modelId};
 try{
  Object.assign(config,{testMode:false,modelProvider:'azure',modelId:'gpt-5.6-luna'});
  expect(await availableModels()).toEqual([{id:'gpt-5.6-luna',name:'GPT-5.6 Luna'}]);
  await expect(validateModel('gpt-5.6-luna')).resolves.toBeUndefined();
  await expect(validateModel('gpt-5.6-sol')).rejects.toThrow('MODEL_UNAVAILABLE');
 }finally{Object.assign(config,previous);}
});
