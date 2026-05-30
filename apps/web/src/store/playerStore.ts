import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AvatarConfig, UserRole, PlayerStatus } from '@shared/types'

interface PlayerStore {
  // Auth
  userId: string | null
  accountEmail: string | null
  displayName: string
  djName: string

  // Avatar
  avatarConfig: AvatarConfig | null

  // Game state
  status: PlayerStatus
  role: UserRole
  clublesBalance: number
  lockscreenMusicUntil: number
  cooldownUntil: number | null   // unix ms

  // Audio
  isMuted: boolean
  isTalking: boolean

  // Reconnect
  lastRoomId: string | null
  lastPosition: { x: number; z: number } | null

  // Actions
  setUserId: (id: string | null) => void
  setAccountEmail: (email: string | null) => void
  setDisplayName: (name: string) => void
  setDjName: (name: string) => void
  setAvatarConfig: (config: AvatarConfig) => void
  setStatus: (status: PlayerStatus) => void
  setRole: (role: UserRole) => void
  setClublesBalance: (balance: number) => void
  setLockscreenMusicUntil: (until: number) => void
  setCooldown: (until: number | null) => void
  setMuted: (muted: boolean) => void
  setTalking: (talking: boolean) => void
  saveReconnectData: (roomId: string, x: number, z: number) => void
  clearReconnectData: () => void
  reset: () => void
}

export const usePlayerStore = create<PlayerStore>()(
  persist(
    (set) => ({
      userId: null,
      accountEmail: null,
      displayName: 'Аноним',
      djName: '',
      avatarConfig: null,
      status: 'outside',
      role: 'guest',
      clublesBalance: 1000,
      lockscreenMusicUntil: 0,
      cooldownUntil: null,
      isMuted: true,   // push-to-talk по умолчанию = мут
      isTalking: false,
      lastRoomId: null,
      lastPosition: null,

      setUserId: (id) => set({ userId: id }),
      setAccountEmail: (email) => set({ accountEmail: email ? email.trim().toLowerCase() : null }),
      setDisplayName: (name) => set({ displayName: name }),
      setDjName: (name) => set({ djName: name }),
      setAvatarConfig: (config) => set({ avatarConfig: config }),
      setStatus: (status) => set({ status }),
      setRole: (role) => set({ role }),
      setClublesBalance: (balance) => set({ clublesBalance: Math.max(0, Math.floor(balance)) }),
      setLockscreenMusicUntil: (until) => set({ lockscreenMusicUntil: Math.max(0, Math.floor(until)) }),
      setCooldown: (until) => set({ cooldownUntil: until }),
      setMuted: (muted) => set({ isMuted: muted }),
      setTalking: (talking) => set({ isTalking: talking }),
      saveReconnectData: (roomId, x, z) =>
        set({ lastRoomId: roomId, lastPosition: { x, z } }),
      clearReconnectData: () =>
        set({ lastRoomId: null, lastPosition: null }),
      reset: () =>
        set({
          userId: null,
          accountEmail: null,
          displayName: 'Аноним',
          djName: '',
          avatarConfig: null,
          status: 'outside',
          role: 'guest',
          clublesBalance: 1000,
          lockscreenMusicUntil: 0,
          cooldownUntil: null,
          isMuted: true,
          isTalking: false,
          lastRoomId: null,
          lastPosition: null,
        }),
    }),
    {
      name: 'doorclub-player',
      // Не сохранять talking/muted — сбрасывать при перезагрузке
      partialize: (state) => ({
  userId: state.userId,
  accountEmail: state.accountEmail,
  displayName: state.displayName,
  djName: state.djName,
  avatarConfig: state.avatarConfig ? {
    ...state.avatarConfig,
    faceTextureUrl: null,   // не хранить base64 в localStorage
    bodyTextureUrl: null,
  } : null,
  role: state.role,
  clublesBalance: state.clublesBalance,
  lockscreenMusicUntil: state.lockscreenMusicUntil,
  lastRoomId: state.lastRoomId,
  lastPosition: state.lastPosition,
}),
    }
  )
)
