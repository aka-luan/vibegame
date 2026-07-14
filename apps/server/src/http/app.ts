import Fastify, { type FastifyInstance } from "fastify";
import { ERROR_CODES } from "@gameish/protocol";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface HttpAppOptions {
  readinessProbe: ReadinessProbe;
  logger?: boolean | undefined;
}

export function createHttpApp(options: HttpAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  app.addHook("onSend", (request, reply, _payload, done) => {
    void reply.header("x-correlation-id", request.id);
    done();
  });

  app.get("/health", () => ({ status: "ok" as const }));

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
