import { Room, Client } from 'colyseus'
import { RoomStateSchema, PlayerSchema } from '../schemas/RoomState'
import { EVENTS, COOLDOWN_MS, MAX_BOUNCER_DENIALS_IN_ROW, MAX_PLAYERS_PER_OUTSIDE_ROOM } from '@doorclub/shared'
import type { MoveMessage, DenyEntryMessage, ApproveEntryMessage, DenyReason } from '@doorclub/shared'

// Трекер для автоэскалации фейсконтроля
const bouncerDenialCount = new Map<string, number>()

export class OutsideRoom extends Room<RoomStateSchema> {
  maxClients = MAX_PLAYERS_PER_OUTSIDE_ROOM

  onCreate() {
    this.setState(new RoomStateSchema())
    this.state.maxPlayers = MAX_PLAYERS_PER_OUTSIDE_ROOM

    this.onMessage(EVENTS.MOVE, (client, msg: MoveMessage) => {
      const player = this.state.players.get(client.sessionId)
      if (!player) return
      // TODO: валидация границ navmesh
      player.x = msg.x
      player.z = msg.z
      player.rotY = msg.rotY
    })

    this.onMessage(EVENTS.JOIN_QUEUE, (client) => {
      const player = this.state.players.get(client.sessionId)
      if (!player) return
      if (player.status !== 'outside') return

      // Проверить cooldown
      if (player.cooldownUntil > Date.now()) {
        client.send(EVENTS.QUEUE_UPDATE, { error: 'cooldown_active', cooldownUntil: player.cooldownUntil })
        return
      }

      if (!this.state.queue.includes(client.sessionId)) {
        this.state.queue.push(client.sessionId)
        player.status = 'queuing'
        this.broadcastQueueUpdate()
      }
    })

    this.onMessage(EVENTS.LEAVE_QUEUE, (client) => {
      this.removeFromQueue(client.sessionId)
    })

    this.onMessage(EVENTS.APPROVE_ENTRY, (client, msg: ApproveEntryMessage) => {
      const bouncer = this.state.players.get(client.sessionId)
      if (!bouncer || bouncer.role !== 'bouncer') return

      const guest = this.state.players.get(msg.guestId)
      if (!guest) return

      // Сбросить счётчик отказов для этой пары
      bouncerDenialCount.delete(`${client.sessionId}:${msg.guestId}`)

      guest.status = 'inside'
      this.removeFromQueue(msg.guestId)

      // Уведомить гостя
      const guestClient = this.clients.find((c) => c.sessionId === msg.guestId)
      guestClient?.send(EVENTS.ADMISSION_RESULT, { result: 'approved' })
    })

    this.onMessage(EVENTS.DENY_ENTRY, (client, msg: DenyEntryMessage) => {
      const bouncer = this.state.players.get(client.sessionId)
      if (!bouncer || bouncer.role !== 'bouncer') return

      const guest = this.state.players.get(msg.guestId)
      if (!guest) return

      // Cooldown
      const cooldownUntil = Date.now() + COOLDOWN_MS
      guest.cooldownUntil = cooldownUntil
      guest.status = 'denied'
      this.removeFromQueue(msg.guestId)

      // Счётчик отказов для авто-эскалации
      const key = `${client.sessionId}:${msg.guestId}`
      const count = (bouncerDenialCount.get(key) ?? 0) + 1
      bouncerDenialCount.set(key, count)

      if (count >= MAX_BOUNCER_DENIALS_IN_ROW) {
        // Эскалация — уведомить всех admin
        this.broadcast(EVENTS.ESCALATION, {
          bouncerId: client.sessionId,
          guestId: msg.guestId,
          reason: msg.reason,
          timestamp: Date.now(),
        })
        bouncerDenialCount.delete(key)
      }

      // Уведомить гостя
      const guestClient = this.clients.find((c) => c.sessionId === msg.guestId)
      guestClient?.send(EVENTS.ADMISSION_RESULT, {
        result: 'denied',
        reason: msg.reason,
        cooldownUntil,
      })
    })

    this.onMessage(EVENTS.REPORT_PLAYER, (_client, msg) => {
      // TODO: сохранить в Supabase через API
      console.log('[Report]', msg)
    })
  }

  onJoin(client: Client, options: { userId: string; displayName: string; avatarConfigJson: string; role?: string }) {
    const player = new PlayerSchema()
    player.userId = options.userId ?? client.sessionId
    player.displayName = options.displayName ?? 'Аноним'
    player.avatarConfigJson = options.avatarConfigJson ?? '{}'
    player.role = (options.role as string) ?? 'guest'
    player.x = Math.random() * 10 - 5   // случайная стартовая позиция на улице
    player.z = Math.random() * 5

    this.state.players.set(client.sessionId, player)
    console.log(`[Outside] join: ${player.displayName} (${client.sessionId})`)
  }

  onLeave(client: Client) {
    this.removeFromQueue(client.sessionId)
    this.state.players.delete(client.sessionId)
    console.log(`[Outside] leave: ${client.sessionId}`)
  }

  private removeFromQueue(sessionId: string) {
    const idx = this.state.queue.indexOf(sessionId)
    if (idx !== -1) {
      this.state.queue.splice(idx, 1)
      const player = this.state.players.get(sessionId)
      if (player && player.status === 'queuing') {
        player.status = 'outside'
      }
      this.broadcastQueueUpdate()
    }
  }

  private broadcastQueueUpdate() {
    this.state.queue.forEach((sessionId, idx) => {
      const client = this.clients.find((c) => c.sessionId === sessionId)
      client?.send(EVENTS.QUEUE_UPDATE, { position: idx + 1, total: this.state.queue.length })
    })
  }
}
