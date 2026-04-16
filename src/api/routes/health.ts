import { Hono } from "hono";
import { handleHealth } from "../handlers.ts";
import type { AppContext } from "../types.ts";

export function healthRoutes(ctx: AppContext) {
  return new Hono().get("/v1/health", (_c) => handleHealth(ctx.healthMonitor));
}
