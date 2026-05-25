import { useEffect, useRef } from 'react'

type WakeLockSentinel = {
  released?: boolean
  release: () => Promise<void>
  addEventListener?: (type: 'release', listener: () => void) => void
}

export default function ScreenWakeLock() {
  const lockRef = useRef<WakeLockSentinel | null>(null)
  const requestingRef = useRef(false)

  useEffect(() => {
    let mounted = true

    const release = () => {
      const lock = lockRef.current
      lockRef.current = null
      void lock?.release().catch(() => undefined)
    }

    const request = async () => {
      if (!mounted || requestingRef.current || lockRef.current || document.visibilityState !== 'visible') return

      const wakeLock = (navigator as Navigator & {
        wakeLock?: { request?: (type: 'screen') => Promise<WakeLockSentinel> }
      }).wakeLock
      if (!wakeLock?.request) return

      requestingRef.current = true
      try {
        const lock = await wakeLock.request('screen')
        if (!mounted) {
          await lock.release().catch(() => undefined)
          return
        }

        lockRef.current = lock
        lock.addEventListener?.('release', () => {
          if (lockRef.current === lock) lockRef.current = null
        })
      } catch {
        lockRef.current = null
      } finally {
        requestingRef.current = false
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void request()
      else release()
    }
    const onUserGesture = () => {
      void request()
    }

    void request()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pointerdown', onUserGesture, true)
    window.addEventListener('touchstart', onUserGesture, { capture: true, passive: true })
    window.addEventListener('keydown', onUserGesture, true)
    const refreshTimer = window.setInterval(() => {
      void request()
    }, 30_000)

    return () => {
      mounted = false
      release()
      window.clearInterval(refreshTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pointerdown', onUserGesture, true)
      window.removeEventListener('touchstart', onUserGesture, true)
      window.removeEventListener('keydown', onUserGesture, true)
    }
  }, [])

  return null
}
