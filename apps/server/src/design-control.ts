import {z} from 'zod';
import {registerControl} from './control';
import {createDesignProject,listDesignProjects,readDesignProject,updateDesignProject} from './design-projects';
import {publishDesign,readWorkbench} from './workbench';

export const designControlHandlers={
 design_projects:async(context:any,input:unknown)=>await listDesignProjects(context.ownerId,context.companionId,input)??{error:'Design Companion not found.'},
 design_project_create:async(context:any,input:unknown)=>({project:await createDesignProject(context.ownerId,context.companionId,input)}),
 design_project_update:async(context:any,input:unknown)=>{
  const value=z.object({projectId:z.uuid()}).passthrough().parse(input),{projectId,...change}=value;
  return {project:await updateDesignProject(context.ownerId,context.companionId,projectId,change)};
 },
 design_history:async(context:any,input:unknown)=>{
  const value=z.object({projectId:z.uuid(),cursor:z.string().max(500).optional()}).strict().parse(input);
  return await readWorkbench(context.ownerId,context.companionId,value)??{error:'Design Companion not found.'};
 },
 design_publish:(context:any,input:unknown)=>publishDesign(context,input),
};
registerControl(designControlHandlers as any);

export {listDesignProjects as listProjects,createDesignProject as createProject,readDesignProject as readProject,updateDesignProject as updateProject};
