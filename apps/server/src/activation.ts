import {billingConfiguration,requireProductActivation} from './billing';
/** Self-hosted local development remains usable without a payment provider. */
export async function requireHostedActivation(ownerId:string){
 if(process.env.NODE_ENV==='production'||billingConfiguration().mode==='stripe')await requireProductActivation(ownerId);
}
export function mutationStartsWork(path:string,method:string){
 if(!['POST','PATCH','PUT'].includes(method))return false;
 if(path==='/api/companions'&&method==='POST')return true;
 return /^\/api\/companions\/[^/]+\/(messages|prepare|desktop(?:\/takeover)?|desktop-takeover|replicas|spawn|adopt-template|routines(?:\/[^/]+(?:\/test)?)?|triggers(?:\/[^/]+(?:\/(?:test|register))?)?)$/.test(path);
}
