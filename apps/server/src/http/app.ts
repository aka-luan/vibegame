import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ERROR_CODES } from "@gameish/protocol";
import { z } from "zod";

import type { DevelopmentPlayTickets } from "../development/play-tickets.js";
import { normalizeCharacterName } from "../identity/guest-account.js";
import type {
  GuestAccountService,
  SessionContext,
} from "../identity/guest-account.js";
import { CharacterNameTakenError } from "@gameish/database";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface HttpAppOptions {
  readinessProbe: ReadinessProbe;
  developmentPlayTickets?: DevelopmentPlayTickets | undefined;
  accountService?: GuestAccountService | undefined;
  allowedOrigin?: string | undefined;
  logger?: boolean | undefined;
}

const developmentTicketRequestSchema = z
  .object({ displayName: z.string().trim().min(1).max(40) })
  .strict();

const guestSessionRequestSchema = z.object({}).strict();
const characterRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} '\u002D]*$/u),
    requestId: z.string().trim().min(1).max(100),
  })
  .strict();
const playTicketRequestSchema = z
  .object({ characterId: z.string().trim().min(1).max(100).optional() })
  .strict();

function originAllowed(
  request: Pick<FastifyRequest, "headers" | "protocol">,
  configuredOrigin: string | undefined,
): boolean {
  const originHeader = request.headers.origin;
  if (!originHeader) return false;
  const origin =
    typeof originHeader === "string"
      ? originHeader
      : Array.isArray(originHeader) && typeof originHeader[0] === "string"
        ? originHeader[0]
        : undefined;
  if (!origin) return false;
  const host =
    typeof request.headers.host === "string" ? request.headers.host : "";
  const expected = configuredOrigin ?? `${request.protocol}://${host}`;
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

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

  if (options.accountService) {
    const accountService = options.accountService;
    const sessionFrom = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<SessionContext | undefined> => {
      const cookieHeader = request.headers.cookie;
      const cookie = Array.isArray(cookieHeader)
        ? cookieHeader.join("; ")
        : cookieHeader;
      try {
        const context = await accountService.ensureSession(cookie);
        if (context.setCookie) reply.header("set-cookie", context.setCookie);
        return context;
      } catch {
        request.log.warn(
          { code: ERROR_CODES.databaseUnavailable, correlationId: request.id },
          "Guest session persistence failed",
        );
        return undefined;
      }
    };

    const loadAccount = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      try {
        const context = await sessionFrom(request, reply);
        if (!context) return undefined;
        return {
          characters: await accountService.listCharacters(
            context.session.userId,
          ),
        };
      } catch {
        request.log.warn(
          { code: ERROR_CODES.databaseUnavailable, correlationId: request.id },
          "Guest account read failed",
        );
        return undefined;
      }
    };

    app.post("/api/guest/session", async (request, reply) => {
      if (!originAllowed(request, options.allowedOrigin)) {
        return reply.status(403).send({ code: ERROR_CODES.invalidOrigin });
      }
      const parsed = guestSessionRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ code: ERROR_CODES.invalidCharacterRequest });
      }
      const account = await loadAccount(request, reply);
      if (!account)
        return reply
          .status(503)
          .send({ code: ERROR_CODES.databaseUnavailable });
      return reply.status(200).send(account);
    });

    app.get("/api/account", async (request, reply) => {
      const account = await loadAccount(request, reply);
      if (!account)
        return reply
          .status(503)
          .send({ code: ERROR_CODES.databaseUnavailable });
      return reply.send(account);
    });

    app.delete("/api/guest/session", async (request, reply) => {
      if (!originAllowed(request, options.allowedOrigin)) {
        return reply.status(403).send({ code: ERROR_CODES.invalidOrigin });
      }
      const cookieHeader = request.headers.cookie;
      const cookie = Array.isArray(cookieHeader)
        ? cookieHeader.join("; ")
        : cookieHeader;
      try {
        await accountService.revokeSession(cookie);
      } catch {
        request.log.warn(
          { code: ERROR_CODES.databaseUnavailable, correlationId: request.id },
          "Guest session revocation failed",
        );
        return reply
          .status(503)
          .send({ code: ERROR_CODES.databaseUnavailable });
      }
      return reply
        .header(
          "set-cookie",
          "gameish_guest=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        )
        .send({ status: "revoked" as const });
    });

    app.post("/api/characters", async (request, reply) => {
      if (!originAllowed(request, options.allowedOrigin)) {
        return reply.status(403).send({ code: ERROR_CODES.invalidOrigin });
      }
      const parsed = characterRequestSchema.safeParse(request.body);
      if (
        !parsed.success ||
        normalizeCharacterName(parsed.data.name).length < 2
      ) {
        return reply
          .status(400)
          .send({ code: ERROR_CODES.invalidCharacterName });
      }
      try {
        const context = await sessionFrom(request, reply);
        if (!context)
          return reply
            .status(503)
            .send({ code: ERROR_CODES.databaseUnavailable });
        const character = await accountService.createCharacter(
          context.session.userId,
          parsed.data,
        );
        return reply.status(201).send({ character });
      } catch (error) {
        if (error instanceof CharacterNameTakenError) {
          return reply
            .status(409)
            .send({ code: ERROR_CODES.characterNameTaken });
        }
        request.log.error(
          { correlationId: request.id },
          "Character creation failed",
        );
        return reply
          .status(503)
          .send({ code: ERROR_CODES.databaseUnavailable });
      }
    });

    app.post<{ Params: { characterId: string } }>(
      "/api/characters/:characterId/select",
      async (request, reply) => {
        if (!originAllowed(request, options.allowedOrigin)) {
          return reply.status(403).send({ code: ERROR_CODES.invalidOrigin });
        }
        try {
          const context = await sessionFrom(request, reply);
          if (!context)
            return reply
              .status(503)
              .send({ code: ERROR_CODES.databaseUnavailable });
          const selected = await accountService.selectCharacter(
            context.session,
            request.params.characterId,
          );
          if (!selected)
            return reply
              .status(404)
              .send({ code: ERROR_CODES.characterNotFound });
          const characters = await accountService.listCharacters(
            context.session.userId,
          );
          return reply.send({
            character: characters.find(
              (character) => character.id === request.params.characterId,
            ),
          });
        } catch {
          request.log.warn(
            {
              code: ERROR_CODES.databaseUnavailable,
              correlationId: request.id,
            },
            "Character selection failed",
          );
          return reply
            .status(503)
            .send({ code: ERROR_CODES.databaseUnavailable });
        }
      },
    );

    app.post("/api/play-ticket", async (request, reply) => {
      if (!originAllowed(request, options.allowedOrigin)) {
        return reply.status(403).send({ code: ERROR_CODES.invalidOrigin });
      }
      const parsed = playTicketRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success)
        return reply
          .status(400)
          .send({ code: ERROR_CODES.invalidCharacterRequest });
      try {
        const context = await sessionFrom(request, reply);
        if (!context)
          return reply
            .status(503)
            .send({ code: ERROR_CODES.databaseUnavailable });
        const ticket = await accountService.issuePlayTicket(
          context.session,
          parsed.data.characterId,
        );
        if (!ticket)
          return reply
            .status(404)
            .send({ code: ERROR_CODES.characterNotFound });
        return reply.status(201).send(ticket);
      } catch {
        request.log.warn(
          { code: ERROR_CODES.databaseUnavailable, correlationId: request.id },
          "Play ticket issuance failed",
        );
        return reply
          .status(503)
          .send({ code: ERROR_CODES.databaseUnavailable });
      }
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
