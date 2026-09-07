import {dkimVerify, type DKIMVerifyOptions} from 'mailauth';
import {Resolver} from 'node:dns/promises';

/** Verify the signed original, never sender-supplied Authentication-Results headers. */
export async function verifyMailSender(raw:Uint8Array,expectedSender:string,options:DKIMVerifyOptions={}):Promise<boolean>{
 if(!raw.byteLength||raw.byteLength>15*1024*1024)return false;
 const prefix=Buffer.from(raw).subarray(0,128*1024).toString();
 if(!/\r?\n\r?\n/.test(prefix))return false;
 const header=prefix.split(/\r?\n\r?\n/,1)[0];
 if((header.match(/^dkim-signature:/gim)??[]).length>10)return false;
 const expected=expectedSender.trim().toLowerCase();
 const domain=expected.split('@')[1];
 if(!domain)return false;
 const resolver=new Resolver({timeout:2000,tries:2});
 try{
  const result=await dkimVerify(Buffer.from(raw),{...options,resolver:options.resolver??((name,type)=>resolver.resolve(name,type) as any)});
  if(result.headerFrom.length!==1||result.headerFrom[0].toLowerCase()!==expected)return false;
  return result.results.some(signature=>{
   const details=signature as typeof signature & {canonBodyLengthLimit?:number;signingHeaders?:{keys:string}};
   return signature.status.result==='pass'&&signature.signingDomain.toLowerCase()===domain
    &&!signature.status.underSized&&details.canonBodyLengthLimit===undefined
    &&String(details.signingHeaders?.keys??'').toLowerCase().split(':').map(x=>x.trim()).includes('from');
  });
 }catch{return false;}finally{resolver.cancel();}
}
