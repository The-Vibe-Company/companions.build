import {requireHostedActivation} from './activation';
import {controlHelp} from './control-help';
import {availableModels,validateModel} from './models';
import { z } from 'zod';
import {encrypt,decrypt} from './config';
import { db } from './store';
import type { ControlOperation } from '../../../packages/control/agent';
export type ControlContext={ownerId:string;companionId:string;runId:string;commandId:string;isChild:boolean};
export type ControlHandler=(context:ControlContext,input:unknown)=>Promise<unknown>;
export const controlHandlers:Partial<Record<ControlOperation,ControlHandler>>={};
export function registerControl(handlers:Partial<Record<ControlOperation,ControlHandler>>) {Object.assign(controlHandlers,handlers);}
export async function migrateProduct(sql:any) {await sql.unsafe(await Bun.file(new URL('./product.sql',import.meta.url)).text());}
const commandSchema=z.object({id:z.string().uuid(),runId:z.string().uuid(),operation:z.string(),input:z.record(z.string(),z.unknown())});
/** Claim before effect; an interrupted unknown outcome is reported, never blindly replayed. */
export async function applyControl(companionId:string,raw:unknown) {
  const command=commandSchema.parse(raw);
  const [actor]=await db`SELECT c.owner_id,c.parent_id,r.status FROM companions c JOIN runs r ON r.companion_id=c.id JOIN "user" u ON u.id=c.owner_id WHERE c.id=${companionId} AND r.id=${command.runId} AND c.retired_at IS NULL`;
  if(!actor||!['running','needs_input'].includes(actor.status)) return {error:'This task no longer has control authority.'};
  const [claim]=await db`INSERT INTO control_commands (id,companion_id,run_id,operation) VALUES (${command.id},${companionId},${command.runId},${command.operation}) ON CONFLICT DO NOTHING RETURNING id`;
  if(!claim) {
    const [previous]=await db`SELECT result,result_secret,status FROM control_commands WHERE id=${command.id} AND companion_id=${companionId} AND run_id=${command.runId}`;
    return (previous?.result_secret?JSON.parse(decrypt(previous.result_secret)):previous?.result)??{error:'The previous attempt has an unknown outcome. Inspect the current state before requesting a new change.'};
  }
  let result:unknown;
  try {
    if(['companion_create','routine_save','routine_test','trigger_save','trigger_test','prepare','spawn','delegate','adopt_template','desktop_takeover'].includes(command.operation))await requireHostedActivation(actor.owner_id);
    const handle=controlHandlers[command.operation as ControlOperation];
    if(!handle) result={error:'This operation is not available.'};
    else if(actor.parent_id&&['spawn','adopt_template','template_save','template_rollback'].includes(command.operation)) result={error:'Ask your parent to manage templates and additional agents.'};
    else result=await handle({ownerId:actor.owner_id,companionId,runId:command.runId,commandId:command.id,isChild:!!actor.parent_id},command.input);
  }catch(error){ result={error:error instanceof z.ZodError?'The operation input is invalid.':'The operation could not be completed. Inspect its state before retrying.'}; }
  if(JSON.stringify(result).length>90_000) result={error:'Result too large. Request a narrower result.'};
  await db`UPDATE control_commands SET status='done',result=null,result_secret=${encrypt(JSON.stringify(result))},finished_at=now() WHERE id=${command.id}`;
  return result;
}
export const avatarSchema=z.object({shape:z.number().int().min(0).max(7),color:z.number().int().min(0).max(10),face:z.number().int().min(0).max(4)});
export const identitySchema=z.object({name:z.string().trim().min(1).max(80).optional(),instructions:z.string().max(20_000).optional(),avatar:avatarSchema.optional(),modelId:z.string().min(1).max(200).optional()});
export async function configureCompanion(ownerId:string,id:string,input:unknown,sql:any=db) {
  const value=identitySchema.parse(input);
  if(value.modelId)await validateModel(value.modelId);
  const [row]=await sql`UPDATE companions SET model_id=COALESCE(${value.modelId??null},model_id),name=COALESCE(${value.name??null},name),instructions=COALESCE(${value.instructions??null},instructions),avatar=COALESCE(${value.avatar??null},avatar) WHERE id=${id} AND owner_id=${ownerId} AND retired_at IS NULL RETURNING id,name,instructions,avatar,model_id AS "modelId"`;
  return row??null;
}
registerControl({
  models:async()=>({models:await availableModels()}),
  identity:async context=>{
    const [companion]=await db`SELECT id,name,instructions,avatar,model_id AS "modelId",desktop_taken AS "desktopTaken",desktop_paused_at AS "desktopPausedAt",status FROM companions WHERE id=${context.companionId} AND owner_id=${context.ownerId}`;
    return {companion,isChild:context.isChild,operations:Object.keys(controlHandlers),examples:controlHelp,instructions:'Read current state before changing it. Omit example placeholder IDs. OAuth returns a consent link for the human; never claim connection before consent succeeds. Trigger mode filter also accepts filterCode, a JavaScript function (payload,responses) returning a boolean, plus optional filterRequests. New Sentry issues use source sentry and target organization/project. Child agents ask their parent for additional agents. Local Pi skills belong under the agent skills directory; use file/shell tools to install, then verify loading. Desktop takeover pauses the whole agent process until explicit release. Long operations are requests: poll task/template state before reporting completion.'};
  },
  configure:(context,input)=>configureCompanion(context.ownerId,context.companionId,input),
  companions:async context=>db`SELECT id,name,instructions,avatar,status FROM companions WHERE owner_id=${context.ownerId} AND retired_at IS NULL AND NOT temporary ORDER BY created_at`,
  ask_user:async(context,input)=>{
    const value=z.object({question:z.string().min(1).max(2000),options:z.array(z.string().max(200)).max(6).default([])}).parse(input);
    await db`INSERT INTO task_questions(id,companion_id,run_id,question,options) VALUES(${context.commandId},${context.companionId},${context.runId},${value.question},${value.options}) ON CONFLICT DO NOTHING`;
    return {pendingQuestionId:context.commandId};
  },
  desktop_takeover:async context=>{await db`UPDATE companions SET desktop_taken=true WHERE id=${context.companionId} AND owner_id=${context.ownerId}`;return {taken:true};},
  desktop_release:async context=>{await db`UPDATE companions SET desktop_taken=false WHERE id=${context.companionId} AND owner_id=${context.ownerId}`;return {taken:false};},
});
