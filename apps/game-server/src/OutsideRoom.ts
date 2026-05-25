import { Room, Client } from 'colyseus'
import { Schema, MapSchema, type } from '@colyseus/schema'

class PlayerState extends Schema {
  @type('float32') x: number = 0
  @type('float32') z: number = 6
  @type('float32') rotY: number = 0
  @type('boolean') moving: boolean = false
  @type('string')  displayName: string = 'Аноним'
  @type('string')  topColor: string = '#222244'
  @type('string')  bottomColor: string = '#111133'
  @type('string')  hairColor: string = '#1a1008'
  @type('string')  skinTone: string = '#c8956c'
  @type('string')  faceTextureUrl: string = ''
}

class OutsideState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>()
}

export class OutsideRoom extends Room<OutsideState> {
  maxClients = 50

  onCreate() {
    this.setState(new OutsideState())
    console.log('OutsideRoom created')

    this.onMessage('move', (client, data: { x: number; z: number; rotY: number; moving: boolean }) => {
      const p = this.state.players.get(client.sessionId)
      if (!p) return
      p.x     = Math.max(-12, Math.min(12,  data.x  ?? p.x))
      p.z     = Math.max(-12, Math.min(10,  data.z   ?? p.z))
      p.rotY  = data.rotY   ?? p.rotY
      p.moving = !!data.moving
    })

    this.onMessage('joinQueue', (client) => {
      console.log(`${client.sessionId} wants to join queue`)
      // TODO: queue logic
    })

    this.onMessage('updateAvatar', (client, data: { top?: string; bottom?: string; hair?: string }) => {
      const p = this.state.players.get(client.sessionId)
      if (!p) return
      if (data.top)    p.topColor    = data.top
      if (data.bottom) p.bottomColor = data.bottom
      if (data.hair)   p.hairColor   = data.hair
    })
  }

  onJoin(client: Client, options: any) {
    const p = new PlayerState()
    p.displayName    = options.displayName    ?? 'Аноним'
    p.topColor       = options.topColor       ?? '#222244'
    p.bottomColor    = options.bottomColor    ?? '#111133'
    p.hairColor      = options.hairColor      ?? '#1a1008'
    p.skinTone       = options.skinTone       ?? '#c8956c'
    p.faceTextureUrl = options.faceTextureUrl ?? ''
    p.x = 0
    p.z = 6
    this.state.players.set(client.sessionId, p)
    console.log(`${client.sessionId} (${p.displayName}) joined. Total: ${this.clients.length}`)
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId)
    console.log(`${client.sessionId} left. Total: ${this.clients.length}`)
  }

  onDispose() {
    console.log('OutsideRoom disposed')
  }
}
