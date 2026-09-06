import {migrate} from './store';
import {processTriggerInbox} from './triggers';
import {enqueueBackground} from './automations';
await migrate();
console.log('Worker ready');
for(;;){
 try{const work=await processTriggerInbox({enqueueBackground});if(!work)await Bun.sleep(500);}
 catch{console.error('worker_progress_failed');await Bun.sleep(1000);}
}
