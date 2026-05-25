import { create } from 'zustand'
import type { PlayerState } from '@shared/types'

interface RoomStore {
  roomId: string | null
  roomType: 'outside' | 'club' | null
  players: Map<string, PlayerState>
  queue: string[]            // userId[] в порядке очереди
  queuePosition: number      // позиция текущего игрока (0 = не в очереди)
  djUserId: string | null
  playerCount: number

  setRoom: (id: string, type: 'outside' | 'club') => void
  setPlayers: (players: Map<string, PlayerState>) => void
  upsertPlayer: (id: string, state: PlayerState) => void
  removePlayer: (id: string) => void
  setQueue: (queue: string[]) => void
  setQueuePosition: (pos: number) => void
  setDj: (userId: string | null) => void
  clearRoom: () => void
}

export const useRoomStore = create<RoomStore>()((set) => ({
  roomId: null,
  roomType: null,
  players: new Map(),
  queue: [],
  queuePosition: 0,
  djUserId: null,
  playerCount: 0,

  setRoom: (id, type) => set({ roomId: id, roomType: type }),

  setPlayers: (players) =>
    set({ players: new Map(players), playerCount: players.size }),

  upsertPlayer: (id, state) =>
    set((s) => {
      const next = new Map(s.players)
      next.set(id, state)
      return { players: next, playerCount: next.size }
    }),

  removePlayer: (id) =>
    set((s) => {
      const next = new Map(s.players)
      next.delete(id)
      return { players: next, playerCount: next.size }
    }),

  setQueue: (queue) => set({ queue }),
  setQueuePosition: (pos) => set({ queuePosition: pos }),
  setDj: (userId) => set({ djUserId: userId }),
  clearRoom: () =>
    set({
      roomId: null,
      roomType: null,
      players: new Map(),
      queue: [],
      queuePosition: 0,
      djUserId: null,
      playerCount: 0,
    }),
}))
