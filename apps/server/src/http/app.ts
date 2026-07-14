import Fastify, { type FastifyInstance } from "fastify";
import { ERROR_CODES } from "@gameish/protocol";
import { z } from "zod";

import type { DevelopmentPlayTickets } from "../development/play-tickets.js";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface HttpAppOptions {
  readinessProbe: ReadinessProbe;
  developmentPlayTickets?: DevelopmentPlayTickets | undefined;
  logger?: boolean | undefined;
}

const developmentTicketRequestSchema = z
  .object({ displayName: z.string().trim().min(1).max(40) })
  .strict();

export function createHttpApp(options: HttpAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  app.addHook("onSend", (request, reply, _payload, done) => {
    void reply.header("x-correlation-id", request.id);
    done();
  });

  app.get("/health", () => ({ status: "ok" as const }));

  if (options.developmentPlayTickets) {
    const developmentPlayTickets = options.developmentPlayTickets;
    app.post("/development/play-ticket", async (request, reply) => {
      const parsed = developmentTicketRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: ERROR_CODES.invalidJoinOptions });
      }
      return reply
        .status(201)
        .send(developmentPlayTickets.issue(parsed.data.displayName));
    });
  }

  app.get("/ready", async (request, reply) => {
    try {
      await options.readinessProbe.check();
      return { status: "ready" as const };
    } catch {
      request.log.warn(
        { code: ERROR_CODES.databaseUnavailable, correlationId: request.id },
        "Readiness probe failed",
      );
      return reply.status(503).send({
        status: "not_ready",
        code: ERROR_CODES.databaseUnavailable,
      });
    }
  });

  return app;
}
