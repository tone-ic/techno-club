import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import '../src/env'
import { isPersistenceEnabled, loadPlayerPersistence, type PersistedPlayerState } from '../src/persistence'

type RoomName = 'outside' | 'club'
type SmokeMessage = Record<string, any>
type Predicate = (message: SmokeMessage) => boolean

const BAR_DRINK_ID = 'bass_tonic'
const DEFAULT_TIMEOUT_MS = 7_000

class SmokeClient {
  readonly label: string
  readonly userId: string
  id = ''

  private ws: WebSocket | null = null
  private messages: SmokeMessage[] = []
  private waiters: Array<{
    type: string
    predicate: Predicate
    resolve: (message: SmokeMessage) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []

  private constructor(label: string, userId: string) {
    this.label = label
    this.userId = userId
  }

  static async join(url: string, room: RoomName, label: string, requestedRole = 'guest', userId: string = randomUUID()) {
    const client = new SmokeClient(label, userId)
    await client.connect(url, room, requestedRole)
    return client
  }

  send(message: SmokeMessage) {
    this.ws?.send(JSON.stringify(message))
  }

  waitFor(type: string, predicate: Predicate = () => true, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const existing = this.messages.find((message) => message.type === type && predicate(message))
    if (existing) return Promise.resolve(existing)

    return new Promise<SmokeMessage>((resolve, reject) => {
      const waiter = {
        type,
        predicate,
        resolve: (message: SmokeMessage) => {
          clearTimeout(waiter.timer)
          this.waiters = this.waiters.filter((item) => item !== waiter)
          resolve(message)
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer)
          this.waiters = this.waiters.filter((item) => item !== waiter)
          reject(error)
        },
        timer: setTimeout(() => {
          waiter.reject(new Error(`${this.label}: timed out waiting for ${type}`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  close() {
    for (const waiter of this.waiters) waiter.reject(new Error(`${this.label}: connection closed`))
    this.waiters = []
    this.ws?.close()
    this.ws = null
  }

  private async connect(url: string, room: RoomName, requestedRole: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', (raw) => this.handleMessage(raw.toString()))

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${this.label}: connect timeout`)), DEFAULT_TIMEOUT_MS)
      this.ws!.once('open', () => {
        clearTimeout(timeout)
        this.send({
          type: 'join',
          room,
          userId: this.userId,
          displayName: this.label,
          role: requestedRole,
          topColor: '#2f6b58',
          bottomColor: '#161722',
          hairColor: '#22140f',
          skinTone: '#c8956c',
          faceTextureUrl: '',
          bodyTextureUrl: '',
          modelUrl: '',
          djName: this.label,
        })
        resolve()
      })
      this.ws!.once('error', reject)
    })

    const welcome = await this.waitFor('welcome')
    this.id = String(welcome.id || '')
    expect(Boolean(this.id), `${this.label}: welcome must include player id`)
  }

  private handleMessage(raw: string) {
    let message: SmokeMessage
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    this.messages.push(message)
    for (const waiter of [...this.waiters]) {
      if (message.type === waiter.type && waiter.predicate(message)) waiter.resolve(message)
    }
  }
}

async function main() {
  const url = process.env.SMOKE_WS_URL || `ws://127.0.0.1:${process.env.GAME_SERVER_PORT || process.env.PORT || 2567}`
  const clients: SmokeClient[] = []

  const join = async (room: RoomName, label: string, requestedRole = 'guest') => {
    const client = await SmokeClient.join(url, room, label, requestedRole)
    clients.push(client)
    return client
  }

  try {
    const opsOutside = await join('outside', 'smoke-ops-outside')
    opsOutside.send({ type: 'staffEntry', inviteRole: 'owner', password: 'nigga' })
    await opsOutside.waitFor('staffEntryAdmitted', (message) => message.role === 'owner')
    await opsOutside.waitFor('gameplayState', hasManagementPlayers)

    const bouncer = await join('outside', 'smoke-bouncer')
    bouncer.send({ type: 'staffEntry', inviteRole: 'facecontrol', password: 'face' })
    await bouncer.waitFor('staffEntryAdmitted', (message) => message.role === 'bouncer')

    const deniedGuest = await join('outside', 'smoke-denied-guest')
    deniedGuest.send({ type: 'joinQueue' })
    await deniedGuest.waitFor('queueJoined')
    await bouncer.waitFor('queueUpdate', (message) => queueHas(message, deniedGuest.id))
    bouncer.send({ type: 'deny', targetId: deniedGuest.id, reason: 'vibe_check' })
    const denied = await deniedGuest.waitFor('denied', (message) => Number(message.cooldownUntil) > Date.now())
    deniedGuest.send({ type: 'joinQueue' })
    await deniedGuest.waitFor('queueDenied', (message) => message.cooldownUntil === denied.cooldownUntil)

    const outsideGuest = await join('outside', 'smoke-approved-guest')
    outsideGuest.send({ type: 'joinQueue' })
    await outsideGuest.waitFor('queueJoined')
    await bouncer.waitFor('queueUpdate', (message) => queueHas(message, outsideGuest.id))
    bouncer.send({ type: 'approve', targetId: outsideGuest.id })
    await outsideGuest.waitFor('admitted')
    const approvedUserId = outsideGuest.userId
    outsideGuest.close()

    const bartender = await join('club', 'smoke-bartender')
    bartender.send({ type: 'staffEntry', inviteRole: 'barmen', password: 'toneic' })
    await bartender.waitFor('staffEntryAdmitted', (message) => message.role === 'bartender')

    const customer = await SmokeClient.join(url, 'club', 'smoke-customer', 'guest', approvedUserId)
    clients.push(customer)
    opsOutside.send({ type: 'managementAction', action: 'grantVip', targetId: customer.id })
    await customer.waitFor('gameplayEvent', (message) => message.event?.kind === 'vipGranted')
    await customer.waitFor('gameplayState', (message) => (
      Array.isArray(message.activeEntitlements) && message.activeEntitlements.includes('vip')
    ))

    customer.send({ type: 'gameplayAction', action: 'orderDrink', drinkId: BAR_DRINK_ID, tip: 20 })
    const bartenderState = await bartender.waitFor('gameplayState', (message) => (
      Array.isArray(message.barOrders) &&
      message.barOrders.some((order: any) => order.customerId === customer.id && order.drinkId === BAR_DRINK_ID)
    ))
    const order = bartenderState.barOrders.find((item: any) => item.customerId === customer.id && item.drinkId === BAR_DRINK_ID)
    bartender.send({ type: 'gameplayAction', action: 'serveDrink', orderId: order.id })
    await customer.waitFor('gameplayEvent', (message) => message.event?.kind === 'drinkServed')
    await customer.waitFor('gameplayState', (message) => (
      Array.isArray(message.drinks) &&
      message.drinks.some((drink: any) => drink.drinkId === BAR_DRINK_ID)
    ))

    const opsInside = await join('club', 'smoke-ops-inside')
    opsInside.send({ type: 'staffEntry', inviteRole: 'security', password: 'police' })
    await opsInside.waitFor('staffEntryAdmitted', (message) => message.role === 'guard')
    await opsInside.waitFor('gameplayState', hasManagementPlayers)

    await opsOutside.waitFor('gameplayState', (message) => hasManagementPlayers(message) && managementHas(message, customer.id))
    opsOutside.send({ type: 'managementAction', action: 'escortOutside', targetId: customer.id })
    await customer.waitFor('forcedOutside')

    if (await canAssertPersistence(deniedGuest.userId)) {
      await waitForPersistedState('denied guest cooldown', deniedGuest.userId, (state) => state.cooldownUntil >= denied.cooldownUntil)
      await waitForPersistedState('outside OPS owner role', opsOutside.userId, (state) => state.role === 'owner')
      await waitForPersistedState('inside OPS guard role', opsInside.userId, (state) => state.role === 'guard')
      await waitForPersistedState('customer drink purchase and VIP', customer.userId, (state) => (
        state.vipAccess &&
        state.activeEntitlements.includes('vip')
      ))
    }

    console.log('Smoke OK: queue deny/approve, club entry, bartender drink purchase, escort, and OPS inside/outside all passed.')
  } finally {
    clients.forEach((client) => client.close())
  }
}

function hasManagementPlayers(message: SmokeMessage) {
  return Array.isArray(message.managementPlayers)
}

function queueHas(message: SmokeMessage, playerId: string) {
  return Array.isArray(message.queue) && message.queue.some((entry: any) => entry.id === playerId)
}

function managementHas(message: SmokeMessage, playerId: string) {
  return message.managementPlayers.some((player: any) => player.id === playerId)
}

async function canAssertPersistence(preflightPlayerKey: string) {
  if (!isPersistenceEnabled()) return false
  await loadPlayerPersistence(preflightPlayerKey)
  if (isPersistenceEnabled()) return true
  console.warn('Smoke persistence assertions skipped: apply supabase/migrations/004_game_player_state.sql, then rerun for DB checks.')
  return false
}

async function waitForPersistedState(label: string, playerKey: string, predicate: (state: PersistedPlayerState) => boolean) {
  const startedAt = Date.now()
  let lastState: PersistedPlayerState | null = null

  while (Date.now() - startedAt < 10_000) {
    lastState = await loadPlayerPersistence(playerKey)
    if (lastState && predicate(lastState)) return lastState
    await delay(350)
  }

  throw new Error(`${label}: persisted state did not match. Last state: ${JSON.stringify(lastState)}`)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
