import {recordCompletedUsage} from './usage';
import {migrateForService} from './store';
import {processTriggerInbox} from './triggers';
import {enqueueBackgroundInTransaction} from './automations';
import {progressSoftwareDeliveryInvites} from './delivery';
await migrateForService();
console.log('Worker ready');
let lastUsage=0;
let lastDeliveries=0;
let deliveryWork:Promise<unknown>|null=null;
for(;;){
 try{if(Date.now()-lastUsage>30_000){await recordCompletedUsage();lastUsage=Date.now();}if(!deliveryWork&&Date.now()-lastDeliveries>5_000){lastDeliveries=Date.now();deliveryWork=progressSoftwareDeliveryInvites().catch(()=>console.error('delivery_progress_failed')).finally(()=>{deliveryWork=null;});}const work=await processTriggerInbox({enqueueBackground:enqueueBackgroundInTransaction});if(!work)await Bun.sleep(500);}
 catch{console.error('worker_progress_failed');await Bun.sleep(1000);}
}
