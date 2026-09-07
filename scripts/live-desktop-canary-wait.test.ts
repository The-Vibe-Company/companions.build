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

 test('a successful reply without the started marker fails immediately',async()=>{
  let reads=0,sleeps=0;
  await expect(waitForHeadlessStart({runId:'owned-run',detail:async()=>({runs:[{id:'owned-run',status:'succeeded'}]}),started:async()=>{reads++;return false;},sleep:async()=>{sleeps++;}})).rejects.toThrow('DESKTOP_CANARY_HEADLESS_NOT_EXECUTED');
  expect({reads,sleeps}).toEqual({reads:1,sleeps:0});
 });

 for(const status of ['running','succeeded'])test(`a verified started marker wins when its run is ${status}`,async()=>{
  let reads=0,sleeps=0;
  await waitForHeadlessStart({runId:'owned-run',detail:async()=>({runs:[{id:'owned-run',status}]}),started:async()=>{reads++;return true;},sleep:async()=>{sleeps++;}});
  expect({reads,sleeps}).toEqual({reads:1,sleeps:0});
 });

 test('another successful run cannot fail the pending owned execution',async()=>{
  let reads=0,sleeps=0;
  await waitForHeadlessStart({runId:'owned-run',detail:async()=>({runs:[{id:'other-run',status:'succeeded'},{id:'owned-run',status:'running'}]}),started:async()=>++reads===2,sleep:async()=>{sleeps++;}});
  expect({reads,sleeps}).toEqual({reads:2,sleeps:1});
 });
});
