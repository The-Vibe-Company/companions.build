import {z} from "zod";
import {activeDesignSkill} from "./profiles";

export const designProjectSchema=z.object({
 id:z.uuid(),companionId:z.uuid(),name:z.string().trim().min(1).max(160),brief:z.string().max(20_000),
 revision:z.number().int().positive(),archived:z.boolean(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),
}).strict();
export type DesignProject=z.infer<typeof designProjectSchema>;

export const designProjectCreateSchema=z.object({
 id:z.uuid(),name:z.string().trim().min(1).max(160),brief:z.string().max(20_000),
}).strict();
export const designProjectUpdateSchema=z.object({
 expectedRevision:z.number().int().positive(),name:z.string().trim().min(1).max(160).optional(),
 brief:z.string().max(20_000).optional(),archived:z.boolean().optional(),
}).strict().refine(value=>value.name!==undefined||value.brief!==undefined||value.archived!==undefined,"Expected a project change");

export const designRunContextSchema=z.object({
 version:z.literal(1),profileId:z.literal("design-v2"),companionId:z.uuid(),
 project:z.object({id:z.uuid(),name:z.string().trim().min(1).max(160),brief:z.string().max(20_000),revision:z.number().int().positive()}).strict(),
 skill:z.object({id:z.literal(activeDesignSkill.id),version:z.literal(activeDesignSkill.version)}).strict(),
}).strict();
export type DesignRunContext=z.infer<typeof designRunContextSchema>;

export interface DesignProjectPage {projects:DesignProject[];nextCursor:string|null}
