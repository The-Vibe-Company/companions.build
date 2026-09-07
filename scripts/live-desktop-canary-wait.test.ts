import {describe,expect,test} from 'bun:test';
import {waitForHeadlessStart} from './live-desktop-canary-wait';

describe('desktop canary headless-start wait',()=>{
 for(const status of ['failed','interrupted','cancelled'])test(`stops immediately when its run is ${status}`,async()=>{
  let details=0,reads=0,sleeps=0;
  await expect(waitForHeadlessStart({runId:'owned-run',detail:async()=>{details++;return{runs:[{id:'other-run',status:'running'},{id:'owned-run',status}]};},started:async()=>{reads++;return false;},sleep:async()=>{sleeps++;}})).rejects.toThrow(`DESKTOP_CANARY_RUN_${status.toUpperCase()}`);
  expect({details,reads,sleeps}).toEqual({details:1,reads:0,sleeps:0});
 });

 test('ignores another run and observes its own persisted terminal transition',async()=>{
  let details=0,reads=0,sleeps=0;
  await expect(waitForHeadlessStart({runId:'owned-run',detail:async()=>({runs:details++===0?[{id:'other-run',status:'failed'},{id:'owned-run',status:'running'}]:[{id:'owned-run',status:'interrupted'}]}),started:async()=>{reads++;return false;},sleep:async()=>{sleeps++;}})).rejects.toThrow('DESKTOP_CANARY_RUN_INTERRUPTED');
  expect({details,reads,sleeps}).toEqual({details:2,reads:1,sleeps:1});
 });
});
