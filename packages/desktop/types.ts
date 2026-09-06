import { z } from "zod";

const coordinate = z.number().int().min(0).max(32_767);
const keyName = z.string().min(1).max(40).regex(/^[A-Za-z0-9_]+$/);

export const desktopActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screenshot") }),
  z.object({ kind: z.literal("click"), x: coordinate, y: coordinate, button: z.enum(["left", "middle", "right"]).default("left") }),
  z.object({ kind: z.literal("type"), text: z.string().max(10_000), intervalMs: z.number().int().min(0).max(100).default(10) }),
  z.object({ kind: z.literal("key"), keys: z.array(keyName).min(1).max(8) }),
  z.object({ kind: z.literal("scroll"), deltaX: z.number().int().min(-100).max(100).default(0), deltaY: z.number().int().min(-100).max(100).default(0) })
    .refine(value => value.deltaX !== 0 || value.deltaY !== 0, "A scroll delta is required"),
]);

export const desktopActionRequestSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  action: desktopActionSchema,
});

export const desktopAdminStateSchema = z.object({
  generation: z.number().int().nonnegative(),
  taken: z.boolean(),
});

export type DesktopAction = z.infer<typeof desktopActionSchema>;
export type DesktopActionRequest = z.infer<typeof desktopActionRequestSchema>;
export type DesktopAdminState = z.infer<typeof desktopAdminStateSchema>;

export type DesktopResult =
  | { kind: "ok" }
  | { kind: "screenshot"; mimeType: "image/png"; data: string; width: number; height: number };

export type DesktopState = DesktopAdminState & {
  confirmed: boolean;
  bootId: string;
};

export interface DesktopDriver {
  execute(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult>;
  /** Release synthetic input and complete an X11 round trip. Resolves only when takeover is safe. */
  quiesce(): Promise<void>;
}
