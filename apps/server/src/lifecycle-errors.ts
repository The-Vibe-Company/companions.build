/** Explicit, application-owned messages safe to expose through the control boundary. */
export class LifecycleConflict extends Error {
 constructor(message:string,readonly code='lifecycle_conflict'){super(message);}
}
