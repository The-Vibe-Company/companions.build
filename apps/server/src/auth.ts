import {APIError,createAuthMiddleware,getSessionFromCtx} from "better-auth/api";
import {betaEmailAllowed,privateBetaEmails,PRIVATE_BETA_MESSAGE} from "./private-beta";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { Pool } from "pg";
import { config } from "./config";
import { createMailAdapter } from "./mail";

const pool = new Pool({ connectionString: config.databaseUrl, max: 8 });

type DeliveredMagicLink = { email: string; url: string };
let testDelivery: ((message: DeliveredMagicLink) => void | Promise<void>) | undefined;
const mailer = createMailAdapter({
  provider: config.emailProvider, from: config.emailFrom, resendApiKey: config.resendApiKey,
  smtpHost: config.smtpHost, smtpPort: config.smtpPort, smtpSecure: config.smtpSecure,
  smtpUser: config.smtpUser, smtpPassword: config.smtpPassword,
});

async function sendMagicLink(message: DeliveredMagicLink) {
  assertBetaEmail(message.email);
  if (testDelivery) return testDelivery(message);
  await mailer.send({
    to: message.email,
    subject: "Sign in to companions.build",
    text: `Open this one-time link to sign in to companions.build:\n\n${message.url}\n\nThis link expires in 10 minutes.`,
  });
}

function assertBetaEmail(email:string) {
  if (!betaEmailAllowed(email)) throw new APIError("FORBIDDEN",{code:"PRIVATE_BETA_REQUIRED",message:PRIVATE_BETA_MESSAGE});
}
export const auth = betterAuth({
  hooks: {before:createAuthMiddleware(async ctx => {
    if (typeof ctx.body?.email === "string") assertBetaEmail(ctx.body.email);
    if (typeof ctx.body?.newEmail === "string") assertBetaEmail(ctx.body.newEmail);
    if(privateBetaEmails()!==null && ctx.path!=="/sign-out") {
      const session=await getSessionFromCtx(ctx,{disableCookieCache:true,disableRefresh:true});
      if(session?.user){
        const result=await pool.query('SELECT email,"emailVerified" FROM "user" WHERE id=$1',[session.user.id]);
        const user=result.rows[0];
        if(!user || !user.emailVerified || !betaEmailAllowed(user.email))throw new APIError("FORBIDDEN",{code:"PRIVATE_BETA_REQUIRED",message:PRIVATE_BETA_MESSAGE});
      }
    }
  })},
  databaseHooks: {
    user: {
      create: {before:async user => {assertBetaEmail(user.email);}},
      update: {before:async user => {if(user.email)assertBetaEmail(user.email);}},
    },
    session: {create: {before:async session => {
      if(privateBetaEmails()===null)return;
      const result=await pool.query('SELECT email,"emailVerified" FROM "user" WHERE id=$1',[session.userId]);
      const user=result.rows[0];
      if(!user || !user.emailVerified || !betaEmailAllowed(user.email)) throw new APIError("FORBIDDEN",{code:"PRIVATE_BETA_REQUIRED",message:PRIVATE_BETA_MESSAGE});
    }}},
  },
  appName: "companions.build",
  baseURL: config.authUrl,
  basePath: "/api/auth",
  secret: config.authSecret,
  database: pool,
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  plugins: [magicLink({
    expiresIn: 600,
    storeToken: "hashed",
    sendMagicLink: async ({ email, url }) => sendMagicLink({ email, url }),
  })],
  advanced: {
    database: { generateId: () => crypto.randomUUID(), joins: true, validateSchema: false },
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  },
  trustedOrigins: [
    config.authUrl,
    ...(process.env.NODE_ENV === "production" ? [] : ["http://127.0.0.1:*", "http://localhost:*"]),
  ],
});

export class AuthenticationRequired extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthenticationRequired";
  }
}

export async function sessionUser(request: Request) {
  let session;
  try { session = await auth.api.getSession({ headers: request.headers }); }
  catch(error) { if(error instanceof APIError && error.body?.code==="PRIVATE_BETA_REQUIRED")return null;throw error; }
  if (!session?.user) return null;
  if (privateBetaEmails() !== null) {
    const result=await pool.query('SELECT email,"emailVerified" FROM "user" WHERE id=$1',[session.user.id]);
    const user=result.rows[0];
    if(!user || !user.emailVerified || !betaEmailAllowed(user.email))return null;
  }
  return session.user;
}

/** Resolve the authenticated personal account for a product route. */
export async function requireUser(request: Request): Promise<string> {
  const user = await sessionUser(request);
  if (!user) throw new AuthenticationRequired();
  return user.id;
}

/** Test-only delivery seam: no auth token is logged or returned by a production route. */
export function setMagicLinkDeliveryForTests(delivery?: (message: DeliveredMagicLink) => void | Promise<void>) {
  if (process.env.NODE_ENV !== "test") throw new Error("Magic-link delivery can only be replaced in tests");
  testDelivery = delivery;
}
