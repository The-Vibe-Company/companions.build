import {beforeAll,afterEach,expect,test} from 'bun:test';
import {db,migrate} from '../src/store';
import {handler} from '../src/api';
import {setMagicLinkDeliveryForTests} from '../src/auth';
import {billingOverview,productActivation,handleBilling,recordUsage,flushPendingUsage,setBillingProviderForTests} from '../src/billing';
import {ownerMayStartWork} from '../src/lifecycle';
import {betaEmailAllowed} from '../src/private-beta';
const keys=['PRIVATE_BETA_EMAILS','BILLING_TEST_MODE','STRIPE_SECRET_KEY','STRIPE_BASE_PRICE_ID','STRIPE_MODEL_PRICE_ID','STRIPE_BOX_PRICE_ID','STRIPE_WEBHOOK_SECRET','STRIPE_METER_EVENT_NAME','STRIPE_BOX_METER_EVENT_NAME','APP_URL'];
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
beforeAll(async()=>{await migrate();});
afterEach(()=>{for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}setMagicLinkDeliveryForTests();setBillingProviderForTests(null);});
async function user(email:string,verified=true){const id=crypto.randomUUID();await db`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'Beta fixture',${email},${verified})`;return id;}
function requestLink(email:string){return handler(new Request('http://127.0.0.1:4310/api/auth/sign-in/magic-link',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:4310'},body:JSON.stringify({email,callbackURL:'/'})}));}
function address(){return `beta-${crypto.randomUUID()}@example.test`;}

test('allowlist is exact, normalized and closed when explicitly empty',()=>{
 process.env.PRIVATE_BETA_EMAILS='  ADA@EXAMPLE.TEST, grace@example.test\nother@sample.test,*.test,*@example.test';
 expect(betaEmailAllowed('ada@example.test')).toBe(true);expect(betaEmailAllowed(' GRACE@EXAMPLE.TEST ')).toBe(true);
 expect(betaEmailAllowed('someone@example.test')).toBe(false);expect(betaEmailAllowed('ada+tag@example.test')).toBe(false);expect(betaEmailAllowed('ada@example.test.attacker.test')).toBe(false);expect(betaEmailAllowed('*@example.test')).toBe(false);
 process.env.PRIVATE_BETA_EMAILS='';expect(betaEmailAllowed('ada@example.test')).toBe(false);
 delete process.env.PRIVATE_BETA_EMAILS;expect(betaEmailAllowed('any@example.test')).toBe(true);
});

test('denied sign-in sends no email and creates neither account nor verification',async()=>{
 const known=address(),unknown=address();await user(known);process.env.PRIVATE_BETA_EMAILS=address();let emails=0;
 setMagicLinkDeliveryForTests(()=>{emails++;});
 const before=(await db`SELECT count(*)::int n FROM verification`)[0].n;
 const first=await requestLink(known),second=await requestLink(unknown);
 expect(first.status).toBe(403);expect(second.status).toBe(403);expect(await first.json()).toEqual(await second.json());expect(emails).toBe(0);
 expect(await db`SELECT id FROM "user" WHERE email=${unknown}`).toHaveLength(0);
 expect((await db`SELECT count(*)::int n FROM verification`)[0].n).toBe(before);
});

test('a revoked outstanding magic link cannot create an account or session',async()=>{
 const email=address();process.env.PRIVATE_BETA_EMAILS=email;let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});
 expect((await requestLink(email)).status).toBe(200);expect(link).not.toBe('');process.env.PRIVATE_BETA_EMAILS=address();
 const verified=await handler(new Request(link,{redirect:'manual'}));expect(verified.headers.get('set-cookie')??'').not.toContain('session_token=');
 expect(await db`SELECT id FROM "user" WHERE email=${email}`).toHaveLength(0);
});

test('a revoked outstanding link cannot sign in an existing account',async()=>{
 const email=address(),owner=await user(email);process.env.PRIVATE_BETA_EMAILS=email;let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});
 expect((await requestLink(email)).status).toBe(200);process.env.PRIVATE_BETA_EMAILS=address();
 const result=await handler(new Request(link,{redirect:'manual'}));expect(result.headers.get('set-cookie')??'').not.toContain('session_token=');
 expect(await db`SELECT id FROM session WHERE "userId"=${owner}`).toHaveLength(0);
});

test('verified beta login works, then revocation blocks the existing session and runtime',async()=>{
 const email=address();process.env.PRIVATE_BETA_EMAILS=email.toUpperCase();let link='';setMagicLinkDeliveryForTests(message=>{link=message.url;});
 expect((await requestLink(email)).status).toBe(200);
 const verified=await handler(new Request(link,{redirect:'manual'}));const cookie=verified.headers.get('set-cookie')?.split(';')[0]??'';expect(cookie).toContain('session_token=');
 const [account]=await db`SELECT id,"emailVerified" FROM "user" WHERE email=${email}`;expect(account.emailVerified).toBe(true);
 const read=()=>handler(new Request('http://127.0.0.1:4310/api/companions',{headers:{cookie}}));expect((await read()).status).toBe(200);expect(await ownerMayStartWork(account.id)).toBe(true);
 process.env.PRIVATE_BETA_EMAILS=address();expect((await read()).status).toBe(401);expect(await ownerMayStartWork(account.id)).toBe(false);
 expect((await handler(new Request('http://127.0.0.1:4310/api/auth/get-session',{headers:{cookie}}))).status).toBe(403);
 expect((await handler(new Request('http://127.0.0.1:4310/api/auth/update-user',{method:'POST',headers:{cookie,'content-type':'application/json',origin:'http://127.0.0.1:4310'},body:JSON.stringify({name:'Changed after revocation'})}))).status).toBe(403);
 expect((await db`SELECT name FROM "user" WHERE id=${account.id}`)[0].name).not.toBe('Changed after revocation');
 process.env.PRIVATE_BETA_EMAILS=email;await db`UPDATE "user" SET "emailVerified"=false WHERE id=${account.id}`;
 expect((await read()).status).toBe(401);expect(await ownerMayStartWork(account.id)).toBe(false);
 await db`UPDATE "user" SET "emailVerified"=true,email=${address()} WHERE id=${account.id}`;expect(await ownerMayStartWork(account.id)).toBe(false);
 expect((await handler(new Request('http://127.0.0.1:4310/api/auth/sign-out',{method:'POST',headers:{cookie,origin:'http://127.0.0.1:4310'}}))).status).toBe(200);
});

test('beta grants only verified stored owners and overrides even active Stripe subscriptions',async()=>{
 const email=address(),owner=await user(email),unverified=await user(address(),false),outsider=await user(address());
 Object.assign(process.env,{STRIPE_SECRET_KEY:'fixture',STRIPE_BASE_PRICE_ID:'price_base',STRIPE_MODEL_PRICE_ID:'price_model',STRIPE_BOX_PRICE_ID:'price_box',STRIPE_WEBHOOK_SECRET:'fixture',STRIPE_METER_EVENT_NAME:'model',STRIPE_BOX_METER_EVENT_NAME:'box',APP_URL:'https://example.test'});delete process.env.BILLING_TEST_MODE;
 const customer='cus_'+outsider,subscription='sub_'+outsider;
 await db`INSERT INTO billing_accounts(owner_id,stripe_customer_id,stripe_subscription_id) VALUES(${outsider},${customer},${subscription})`;
 await db`INSERT INTO billing_subscriptions(stripe_subscription_id,owner_id,stripe_customer_id,stripe_price_id,subscription_status,last_event_created) VALUES(${subscription},${outsider},${customer},${JSON.stringify(['price_base','price_box','price_model'])},'active',1)`;
 delete process.env.PRIVATE_BETA_EMAILS;expect((await productActivation(outsider)).allowed).toBe(true);
 process.env.PRIVATE_BETA_EMAILS=email;expect((await productActivation(owner)).allowed).toBe(true);expect((await productActivation(outsider)).allowed).toBe(false);expect((await productActivation(unverified)).allowed).toBe(false);expect((await productActivation(crypto.randomUUID())).allowed).toBe(false);
 expect(await billingOverview(owner)).toMatchObject({mode:'beta',plan:'beta',active:true});expect(await billingOverview(outsider)).toMatchObject({mode:'beta',plan:'inactive',active:false});
 expect((await handleBilling(new Request('https://example.test/api/billing/checkout',{method:'POST'}),owner))!.status).toBe(409);
 delete process.env.PRIVATE_BETA_EMAILS;expect((await productActivation(outsider)).allowed).toBe(true);expect(await billingOverview(outsider)).toMatchObject({mode:'stripe',plan:'subscription',active:true});
});

test('beta usage is atomically nonbillable and never sent after beta ends; pre-beta pending survives',async()=>{
 const email=address(),owner=await user(email);delete process.env.PRIVATE_BETA_EMAILS;delete process.env.BILLING_TEST_MODE;
 Object.assign(process.env,{STRIPE_SECRET_KEY:'fixture',STRIPE_BASE_PRICE_ID:'price_base',STRIPE_MODEL_PRICE_ID:'price_model',STRIPE_BOX_PRICE_ID:'price_box',STRIPE_WEBHOOK_SECRET:'fixture',STRIPE_METER_EVENT_NAME:'model',STRIPE_BOX_METER_EVENT_NAME:'box',APP_URL:'https://example.test'});
 const delivered:string[]=[];setBillingProviderForTests({async createCheckout(){throw Error('Unexpected checkout');},async createPortal(){throw Error('Unexpected portal');},async sendMeterEvent(value){delivered.push(value.operationId);}});
 const prior={operationId:'prior-'+crypto.randomUUID(),ownerId:owner,category:'model_tokens' as const,unit:'token' as const,quantity:5};
 expect(await recordUsage(prior)).toMatchObject({delivery:'pending'});
 await db`INSERT INTO billing_accounts(owner_id,stripe_customer_id) VALUES(${owner},${'cus_'+owner})`;
 process.env.PRIVATE_BETA_EMAILS=email;
 const during={...prior,operationId:'beta-'+crypto.randomUUID()};
 expect(await recordUsage(during)).toMatchObject({delivery:'skipped'});
 expect((await db`SELECT stripe_delivery_status FROM usage_ledger WHERE owner_id=${owner} AND operation_id=${during.operationId}`)[0].stripe_delivery_status).toBe('skipped');
 await flushPendingUsage(owner);expect(delivered).toEqual([]);
 expect((await db`SELECT stripe_delivery_status FROM usage_ledger WHERE owner_id=${owner} AND operation_id=${prior.operationId}`)[0].stripe_delivery_status).toBe('pending');
 delete process.env.PRIVATE_BETA_EMAILS;await flushPendingUsage(owner);expect(delivered).toEqual([prior.operationId]);
 expect(await recordUsage(during)).toMatchObject({delivery:'duplicate'});expect(delivered).toEqual([prior.operationId]);
});
