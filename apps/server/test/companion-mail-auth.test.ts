import {test,expect} from 'bun:test';
import {generateKeyPairSync} from 'node:crypto';
import {dkimSign} from 'mailauth';
import {verifyMailSender} from '../src/companion-mail-auth';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const privateKey=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const publicKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
const resolver=async()=>[[`v=DKIM1; k=rsa; p=${publicKey}`]];
const body='From: Paul <paul@example.com>\r\nTo: stan.alice@mail.companions.build\r\nSubject: Work\r\n\r\nPlease review the document.\r\n';
async function signed(domain='example.com',maxBodyLength?:number){
 const result=await dkimSign(body,{signingDomain:domain,selector:'mail',privateKey,signatureData:[{signingDomain:domain,selector:'mail',privateKey,...(maxBodyLength===undefined?{}:{maxBodyLength})}]});
 return Buffer.from(result.signatures+body);
}
test('original signed mail authenticates exact sender, not another allowlisted address',async()=>{
 const raw=await signed();
 expect(await verifyMailSender(raw,'paul@example.com',{resolver})).toBe(true);
 expect(await verifyMailSender(raw,'owner@example.com',{resolver})).toBe(false);
 expect(await verifyMailSender(await signed('attacker.example'),'paul@example.com',{resolver})).toBe(false);
});
test('forged authentication headers, changed body and partial-body signatures cannot authorize work',async()=>{
 expect(await verifyMailSender(Buffer.from('Authentication-Results: inbound; dkim=pass\r\n'+body),'paul@example.com',{resolver})).toBe(false);
 const raw=await signed();
 expect(await verifyMailSender(Buffer.from(raw.toString().replace('Please review','Please delete')),'paul@example.com',{resolver})).toBe(false);
 expect(await verifyMailSender(await signed('example.com',5),'paul@example.com',{resolver})).toBe(false);
 expect(await verifyMailSender(Buffer.from('X-Oversize: '+ 'a'.repeat(128*1024)+'\r\n'+body),'paul@example.com',{resolver})).toBe(false);
});
