import { useRef, useState, useCallback } from 'react'

export type CameraFacing = 'user' | 'environment'

interface UseCameraReturn {
  videoRef: React.RefObject<HTMLVideoElement>
  canvasRef: React.RefObject<HTMLCanvasElement>
  isStreaming: boolean
  error: string | null
  startCamera: (facing: CameraFacing) => Promise<void>
  stopCamera: () => void
  takePhoto: () => string | null   // returns base64 JPEG
  supportsGetUserMedia: boolean
}

export function useCamera(): UseCameraReturn {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const supportsGetUserMedia =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia

  const startCamera = useCallback(async (facing: CameraFacing) => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
        setIsStreaming(true)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Camera error'
      setError(msg)
      console.error('Camera error:', err)
    }
  }, [])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setIsStreaming(false)
  }, [])

  const takePhoto = useCallback((): string | null => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return null

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0)

    // Сжать до JPEG 80% качество
    return canvas.toDataURL('image/jpeg', 0.8)
  }, [])

  return { videoRef, canvasRef, isStreaming, error, startCamera, stopCamera, takePhoto, supportsGetUserMedia }
}
