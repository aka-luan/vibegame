import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, StateView, type, view } from "@colyseus/schema";
import { ERROR_CODES } from "@gameish/protocol";
import { z } from "zod";

const joinOptionsSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  privateValue: z.string().min(1).max(100),
});

class VisiblePlayer extends Schema {
  @type("string")
  displayName = "";

  @view()
  @type("string")
  privateValue = "";
}

class PrivacySpikeState extends Schema {
  @type({ map: VisiblePlayer })
  players = new MapSchema<VisiblePlayer>();
}

export class PrivacySpikeRoom extends Room<{ state: PrivacySpikeState }> {
  override state = new PrivacySpikeState();

  override onJoin(client: Client, unsafeOptions: unknown) {
    const result = joinOptionsSchema.safeParse(unsafeOptions);
    if (!result.success) {
      throw new ServerError(4_220, ERROR_CODES.invalidJoinOptions);
    }

    const player = new VisiblePlayer();
    player.displayName = result.data.displayName;
    player.privateValue = result.data.privateValue;

    client.view = new StateView();
    this.state.players.set(client.sessionId, player);
    client.view.add(player);
  }

  override onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }
}
