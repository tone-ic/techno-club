type AudioSessionNavigator = Navigator & {
  audioSession?: {
    type?: string
  }
}

export type AudioSessionRelease = () => void

let activeCaptureSessionCount = 0

function setAudioSessionType(candidates: string[]) {
  if (typeof navigator === 'undefined') return
  const audioSession = (navigator as AudioSessionNavigator).audioSession
  if (!audioSession) return

  for (const type of candidates) {
    try {
      audioSession.type = type
      return
    } catch {}
  }
}

export function preferCaptureAudioSession() {
  setAudioSessionType(['play-and-record', 'auto'])
}

export function preferPlaybackAudioSession() {
  if (activeCaptureSessionCount > 0) {
    preferCaptureAudioSession()
    return
  }
  setAudioSessionType(['playback', 'ambient', 'auto'])
}

export function claimCaptureAudioSession(): AudioSessionRelease {
  activeCaptureSessionCount += 1
  preferCaptureAudioSession()

  let released = false
  return () => {
    if (released) return
    released = true
    activeCaptureSessionCount = Math.max(0, activeCaptureSessionCount - 1)
    preferPlaybackAudioSession()
  }
}
