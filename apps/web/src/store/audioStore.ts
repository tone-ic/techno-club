import { create } from 'zustand'

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

export const useAudioStore = create<AudioStore>()((set) => ({
  audioContextReady: false,
  djTrackActive: false,
  ambientActive: false,
  masterVolume: 1.0,
  djVolume: 0.75,
  voiceVolume: 1.0,

  // Вызывать при первом тапе пользователя — разблокирует AudioContext на iOS
  unlockAudioContext: () => set({ audioContextReady: true }),
  setDjTrackActive: (active) => set({ djTrackActive: active }),
  setAmbientActive: (active) => set({ ambientActive: active }),
  setMasterVolume: (vol) => set({ masterVolume: vol }),
  setDjVolume: (vol) => set({ djVolume: vol }),
  setVoiceVolume: (vol) => set({ voiceVolume: vol }),
}))
