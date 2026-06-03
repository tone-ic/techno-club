import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AudioStore {
  audioContextReady: boolean
  djTrackActive: boolean
  ambientActive: boolean
  masterVolume: number
  djVolume: number
  voiceVolume: number

  unlockAudioContext: () => void
  setDjTrackActive: (active: boolean) => void
  setAmbientActive: (active: boolean) => void
  setMasterVolume: (vol: number) => void
  setDjVolume: (vol: number) => void
  setVoiceVolume: (vol: number) => void
}

function clampVolume(vol: number) {
  return Math.max(0, Math.min(1, Number.isFinite(vol) ? vol : 0))
}

export const useAudioStore = create<AudioStore>()(
  persist(
    (set) => ({
      audioContextReady: false,
      djTrackActive: false,
      ambientActive: false,
      masterVolume: 0.4,
      djVolume: 0.75,
      voiceVolume: 1.0,

      // Вызывать при первом тапе пользователя — разблокирует AudioContext на iOS
      unlockAudioContext: () => set({ audioContextReady: true }),
      setDjTrackActive: (active) => set({ djTrackActive: active }),
      setAmbientActive: (active) => set({ ambientActive: active }),
      setMasterVolume: (vol) => set({ masterVolume: clampVolume(vol) }),
      setDjVolume: (vol) => set({ djVolume: clampVolume(vol) }),
      setVoiceVolume: (vol) => set({ voiceVolume: clampVolume(vol) }),
    }),
    {
      name: 'doorclub-audio',
      partialize: (state) => ({
        masterVolume: state.masterVolume,
        djVolume: state.djVolume,
        voiceVolume: state.voiceVolume,
      }),
    },
  ),
)
