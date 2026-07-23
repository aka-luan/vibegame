import type { Client, Room } from "@colyseus/core";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type PartyResultMessage,
} from "@gameish/protocol";
import { z } from "zod";

import type { PartyActionDecision, PartyCoordinator } from "./coordinator.js";

const actionId = z.string().trim().min(1).max(64);
const entityId = z.string().trim().min(1).max(80);
const invitationId = z.string().trim().min(1).max(80);

const inviteSchema = z.object({ actionId, targetEntityId: entityId }).strict();
const invitationResponseSchema = z.object({ actionId, invitationId }).strict();
const leaveSchema = z.object({ actionId }).strict();
const changeLeaderSchema = z
  .object({ actionId, targetEntityId: entityId })
  .strict();
const travelToMemberSchema = z
  .object({ actionId, targetEntityId: entityId })
  .strict();

const MAX_PARTY_MESSAGE_BYTES = 256;

function parse<T>(schema: z.ZodType<T>, unsafe: unknown): T | undefined {
  const encoded = JSON.stringify(unsafe);
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded) > MAX_PARTY_MESSAGE_BYTES
  ) {
    return undefined;
  }
  const parsed = schema.safeParse(unsafe);
  return parsed.success ? parsed.data : undefined;
}

function rejectInvalid(client: Client, unsafe: unknown): void {
  const unsafeActionId =
    unsafe && typeof unsafe === "object" && "actionId" in unsafe
      ? (unsafe as { actionId?: unknown }).actionId
      : undefined;
  client.send(SERVER_MESSAGES.partyResult, {
    accepted: false,
    actionId:
      typeof unsafeActionId === "string" && unsafeActionId.length <= 64
        ? unsafeActionId
        : "invalid-party-action",
    code: ERROR_CODES.invalidPartyIntention,
  } satisfies PartyResultMessage);
}

function sendDecision(
  client: Client,
  actionIdValue: string,
  decision: PartyActionDecision,
): void {
  client.send(
    SERVER_MESSAGES.partyResult,
    decision.accepted
      ? ({
          accepted: true,
          actionId: actionIdValue,
        } satisfies PartyResultMessage)
      : ({
          accepted: false,
          actionId: actionIdValue,
          code: decision.code,
        } satisfies PartyResultMessage),
  );
}

export function registerPartyRoomHandlers(input: {
  room: Room;
  parties: PartyCoordinator;
  memberIdFor: (sessionId: string) => string | undefined;
  travelToMember: (
    client: Client,
    intention: { actionId: string; targetEntityId: string },
  ) => Promise<void>;
  recordUnexpectedTravelFailure?: (actionId: string) => void;
}): void {
  input.room.onMessage(CLIENT_MESSAGES.partyStateRequest, (client) => {
    const memberId = input.memberIdFor(client.sessionId);
    if (memberId) input.parties.sendState(memberId);
  });
  input.room.onMessage(CLIENT_MESSAGES.partyInvite, (client, unsafe) => {
    const intention = parse(inviteSchema, unsafe);
    const memberId = input.memberIdFor(client.sessionId);
    if (!intention || !memberId) return rejectInvalid(client, unsafe);
    sendDecision(
      client,
      intention.actionId,
      input.parties.invite(memberId, intention.targetEntityId),
    );
  });
  input.room.onMessage(CLIENT_MESSAGES.partyAccept, (client, unsafe) => {
    const intention = parse(invitationResponseSchema, unsafe);
    const memberId = input.memberIdFor(client.sessionId);
    if (!intention || !memberId) return rejectInvalid(client, unsafe);
    sendDecision(
      client,
      intention.actionId,
      input.parties.accept(memberId, intention.invitationId),
    );
  });
  input.room.onMessage(CLIENT_MESSAGES.partyDecline, (client, unsafe) => {
    const intention = parse(invitationResponseSchema, unsafe);
    const memberId = input.memberIdFor(client.sessionId);
    if (!intention || !memberId) return rejectInvalid(client, unsafe);
    sendDecision(
      client,
      intention.actionId,
      input.parties.decline(memberId, intention.invitationId),
    );
  });
  input.room.onMessage(CLIENT_MESSAGES.partyLeave, (client, unsafe) => {
    const intention = parse(leaveSchema, unsafe);
    const memberId = input.memberIdFor(client.sessionId);
    if (!intention || !memberId) return rejectInvalid(client, unsafe);
    sendDecision(client, intention.actionId, input.parties.leave(memberId));
  });
  input.room.onMessage(CLIENT_MESSAGES.partyChangeLeader, (client, unsafe) => {
    const intention = parse(changeLeaderSchema, unsafe);
    const memberId = input.memberIdFor(client.sessionId);
    if (!intention || !memberId) return rejectInvalid(client, unsafe);
    sendDecision(
      client,
      intention.actionId,
      input.parties.changeLeader(memberId, intention.targetEntityId),
    );
  });
  input.room.onMessage(
    CLIENT_MESSAGES.partyTravelToMember,
    (client, unsafe) => {
      const intention = parse(travelToMemberSchema, unsafe);
      const memberId = input.memberIdFor(client.sessionId);
      if (!intention || !memberId) return rejectInvalid(client, unsafe);
      void input.travelToMember(client, intention).catch(() => {
        input.parties.cancelTravel([memberId]);
        input.recordUnexpectedTravelFailure?.(intention.actionId);
        client.send(SERVER_MESSAGES.partyResult, {
          accepted: false,
          actionId: intention.actionId,
          code: ERROR_CODES.transitionUnavailable,
        } satisfies PartyResultMessage);
      });
    },
  );
}
