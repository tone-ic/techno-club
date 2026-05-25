import { Schema, type, MapSchema } from '@colyseus/schema'

export class PlayerSchema extends Schema {
  @type('string') userId = ''
  @type('string') displayName = ''
  @type('number') x = 0
  @type('number') z = 0
  @type('number') rotY = 0
  @type('string') status = 'outside'   // PlayerStatus
  @type('string') role = 'guest'       // UserRole
  @type('number') cooldownUntil = 0    // unix ms, 0 = no cooldown
  @type('boolean') isMuted = true
  @type('boolean') isTalking = false
  // avatarConfig передаётся как JSON-строка (Schema не поддерживает nested objects хорошо)
  @type('string') avatarConfigJson = '{}'
}

export class RoomStateSchema extends Schema {
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>()
  @type(['string']) queue: string[] = []   // userId[]
  @type('string') djUserId = ''
  @type('string') currentTrack = ''
  @type('number') maxPlayers = 50
}
