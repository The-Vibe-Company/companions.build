import {recordCompletedUsage} from './usage';
import {migrate} from './store';
import {processTriggerInbox} from './triggers';
import {enqueueBackground} from './automations';
await migrate();
console.log('Worker ready');
let lastUsage=0;
for(;;){
 try{if(Date.now()-lastUsage>30_000){await recordCompletedUsage();lastUsage=Date.now();}const work=await processTriggerInbox({enqueueBackground});if(!work)await Bun.sleep(500);}
 catch{console.error('worker_progress_failed');await Bun.sleep(1000);}
}
