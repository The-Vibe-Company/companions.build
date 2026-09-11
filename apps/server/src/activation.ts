import {privateBetaEmails} from "./private-beta";
import {db} from './store';
import {billingConfiguration,requireProductActivation} from './billing';
/** Self-hosted local development remains usable without a payment provider. */
export async function requireHostedActivation(ownerId:string,sql:any=db){
 if(privateBetaEmails()!==null||process.env.NODE_ENV==='production'||billingConfiguration().mode==='stripe')await requireProductActivation(ownerId,sql);
}
export function mutationStartsWork(path:string,method:string){
 if(!['POST','PATCH','PUT'].includes(method))return false;
 if(path==='/api/companions'&&method==='POST')return true;
 return /^\/api\/companions\/[^/]+\/(messages|prepare|desktop(?:\/(?:takeover|release))?|desktop-takeover|maintenance)$/.test(path)
  || /^\/api\/discussions(?:\/[^/]+(?:\/(?:messages|participants|invitations|cancel))?)?$/.test(path);
}
