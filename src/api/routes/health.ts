import { Hono } from "hono";
import { handleHealth } from "../handlers.ts";

export function healthRoutes() {
  return new Hono().get("/v1/health", (_c) => handleHealth());
}
