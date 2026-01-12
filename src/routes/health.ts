import { Elysia } from "elysia";

export const healthRoutes = new Elysia({ prefix: "/health" }).get("/", () => {
  return {
    status: "ok",
    timestamp: Date.now(),
  };
});


