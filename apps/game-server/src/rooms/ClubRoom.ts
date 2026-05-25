import { Room, Client } from 'colyseus'
import { RoomStateSchema, PlayerSchema } from '../schemas/RoomState'
import { EVENTS, MAX_PLAYERS_PER_CLUB_ROOM } from '@doorclub/shared'
import type { MoveMessage } from '@doorclub/shared'

export class ClubRoom extends Room<RoomStateSchema> {
  maxClients = MAX_PLAYERS_PER_CLUB_ROOM

  onCreate() {
    this.setState(new RoomStateSchema())
    this.state.maxPlayers = MAX_PLAYERS_PER_CLUB_ROOM

    this.onMessage(EVENTS.MOVE, (client, msg: MoveMessage) => {
      const player = this.state.players.get(client.sessionId)
      if (!player) return
      player.x = msg.x
      player.z = msg.z
      player.rotY = msg.rotY
    })

    this.onMessage(EVENTS.EMOTE, (client, msg) => {
      // Broadcast эмоцию всем в комнате
      this.broadcast('emote', { sessionId: client.sessionId, emoteId: msg.emoteId }, { except: client })
    })

    // TODO: DJ канал, VIP-зона, бар — Неделя 5-6
  }

  onJoin(client: Client, options: { userId: string; displayName: string; avatarConfigJson: string; admissionToken?: string }) {
    // TODO: проверить admissionToken — Неделя 4
    const player = new PlayerSchema()
    player.userId = options.userId ?? client.sessionId
    player.displayName = options.displayName ?? 'Аноним'
    player.avatarConfigJson = options.avatarConfigJson ?? '{}'
    player.status = 'inside'
    player.x = 0
    player.z = 0

    this.state.players.set(client.sessionId, player)
    console.log(`[Club] join: ${player.displayName}`)
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId)
    console.log(`[Club] leave: ${client.sessionId}`)
  }
}
