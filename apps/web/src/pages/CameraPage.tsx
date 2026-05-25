import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AvatarConfig } from '@shared/types'
import {
  generateNoAiAvatar,
  compressCameraPhoto,
  normalizeFacePhoto,
  normalizeFullBodyPhoto,
} from '@/avatar/noAiAvatarFactory'
import {
  generateTrellisAvatarStream,
  type AvatarPipelineEvent,
  type AvatarPipelineStage,
} from '@/avatar/trellisPipeline'
import AvatarPreview3D from '@/components/AvatarPreview3D'
import { usePlayerStore } from '@/store/playerStore'
import { supabase } from '@/utils/supabase'

type Step = 'intro' | 'fullbody' | 'review' | 'generating' | 'preview' | 'saving'
type CameraFacing = 'user' | 'environment'
type TrellisNotice = {
  tone: 'pending' | 'success' | 'warning'
  message: string
} | null

interface Photos {
  fullbody: string | null
  face: string | null
}

type PipelineStage = AvatarPipelineStage

interface GenerationProcess {
  stage: PipelineStage
  sourceImage: string | null
  kieImage: string | null
  progress: number
  message: string
}

async function attachStreamToVideo(video: HTMLVideoElement, stream: MediaStream): Promise<boolean> {
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', 'true')
  video.setAttribute('webkit-playsinline', 'true')

  try {
    await waitForVideoMetadata(video)
    await video.play()
    return waitForRenderableVideoFrame(video)
  } catch {
    return false
  }
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let timeoutId: number | null = null
    const finish = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId)
      video.removeEventListener('loadedmetadata', finish)
      video.removeEventListener('canplay', finish)
      resolve()
    }

    video.addEventListener('loadedmetadata', finish)
    video.addEventListener('canplay', finish)
    timeoutId = window.setTimeout(finish, 1200)
  })
}

function waitForRenderableVideoFrame(video: HTMLVideoElement): Promise<boolean> {
  const startedAt = performance.now()

  return new Promise((resolve) => {
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        resolve(true)
        return
      }

      if (performance.now() - startedAt > 2500) {
        resolve(false)
        return
      }

      window.requestAnimationFrame(check)
    }

    check()
  })
}

export default function CameraPage() {
  const navigate = useNavigate()
  const { userId, setAvatarConfig } = usePlayerStore()
  const [step, setStep] = useState<Step>('intro')
  const [photos, setPhotos] = useState<Photos>({ fullbody: null, face: null })
  const [generated, setGenerated] = useState<AvatarConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trellisNotice, setTrellisNotice] = useState<TrellisNotice>(null)
  const [generationProcess, setGenerationProcess] = useState<GenerationProcess>({
    stage: 'source',
    sourceImage: null,
    kieImage: null,
    progress: 0,
    message: 'Готовим фото',
  })
  const [isDetecting, setIsDetecting] = useState(false)
  const [isCameraReady, setIsCameraReady] = useState(false)
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>('environment')
  const [stream, setStream] = useState<MediaStream | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const stopStream = useCallback(() => {
    setIsCameraReady(false)
    if (videoRef.current?.srcObject === stream) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }
    stream?.getTracks().forEach((track) => track.stop())
    setStream(null)
  }, [stream])

  useEffect(() => {
    return () => stream?.getTracks().forEach((track) => track.stop())
  }, [stream])

  const startCamera = useCallback(async (facing: CameraFacing) => {
    stopStream()
    setCameraFacing(facing)
    setError(null)
    setIsCameraReady(false)
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Камера недоступна — загрузи фото из галереи')
      return
    }

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      setStream(nextStream)
      if (videoRef.current) {
        const ready = await attachStreamToVideo(videoRef.current, nextStream)
        if (videoRef.current?.srcObject === nextStream) setIsCameraReady(ready)
      }
    } catch {
      setError('Камера недоступна — загрузи фото из галереи')
    }
  }, [stopStream])

  const handleSwitchCamera = useCallback(() => {
    const nextFacing: CameraFacing = cameraFacing === 'environment' ? 'user' : 'environment'
    void startCamera(nextFacing)
  }, [cameraFacing, startCamera])

  useEffect(() => {
    if (step !== 'fullbody' || !stream || !videoRef.current) return

    let cancelled = false
    setIsCameraReady(false)
    void attachStreamToVideo(videoRef.current, stream).then((ready) => {
      if (!cancelled && videoRef.current?.srcObject === stream) setIsCameraReady(ready)
    })

    return () => {
      cancelled = true
    }
  }, [step, stream])

  const takePhoto = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return null
    if (!isCameraReady || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      setError('Камера ещё запускается — подожди секунду и попробуй снова')
      return null
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return compressCameraPhoto(canvas)
  }, [isCameraReady])

  const acceptPhoto = useCallback(async (dataUrl: string) => {
    setIsDetecting(true)
    setError(null)

    let normalizedFullbody = dataUrl
    let normalizedFace = dataUrl
    try {
      const [fullbody, face] = await Promise.all([
        normalizeFullBodyPhoto(dataUrl),
        normalizeFacePhoto(dataUrl),
      ])
      normalizedFullbody = fullbody
      normalizedFace = face
    } catch {
      normalizedFullbody = dataUrl
      normalizedFace = dataUrl
    } finally {
      setIsDetecting(false)
    }

    stopStream()
    setGenerated(null)
    setTrellisNotice(null)
    setGenerationProcess({ stage: 'source', sourceImage: null, kieImage: null, progress: 0, message: 'Готовим фото' })
    setPhotos({ fullbody: normalizedFullbody, face: normalizedFace })
    setStep('review')
  }, [stopStream])

  const handleCapture = useCallback(async () => {
    const dataUrl = takePhoto()
    if (dataUrl) {
      await acceptPhoto(dataUrl)
      return
    }

    cameraInputRef.current?.click()
  }, [acceptPhoto, takePhoto])

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (readerEvent) => {
      const dataUrl = readerEvent.target?.result
      if (typeof dataUrl === 'string') void acceptPhoto(dataUrl)
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }, [acceptPhoto])

  const handleGenerate = useCallback(async () => {
    const fullbodyPhoto = photos.fullbody
    if (!fullbodyPhoto) return
    const facePhoto = photos.face ?? fullbodyPhoto
    setStep('generating')
    setError(null)
    setGenerationProcess({
      stage: 'source',
      sourceImage: fullbodyPhoto,
      kieImage: null,
      progress: 5,
      message: 'Готовим исходное фото',
    })
    setTrellisNotice({ tone: 'pending', message: 'Собираем быстрый превью-аватар' })
    try {
      const nextGenerated = await generateNoAiAvatar(fullbodyPhoto, facePhoto)
      setGenerated(nextGenerated.config)
      setGenerationProcess({
        stage: 'fallback',
        sourceImage: fullbodyPhoto,
        kieImage: null,
        progress: 22,
        message: 'Быстрый аватар готов как fallback',
      })
      setTrellisNotice({ tone: 'pending', message: 'Отправляем фото в Kie' })

      const result = await generateTrellisAvatarStream(
        fullbodyPhoto,
        nextGenerated.config,
        (event) => {
          if (event.type === 'result') return
          setGenerationProcess((current) => processPipelineEvent(current, event, fullbodyPhoto))
          if (event.type !== 'error') {
            setTrellisNotice({ tone: 'pending', message: event.message })
          }
        },
      )
      setGenerated(result.avatar)
      setGenerationProcess({
        stage: 'done',
        sourceImage: fullbodyPhoto,
        kieImage: result.prepared?.image ?? null,
        progress: 100,
        message: 'Аватар готов',
      })
      if (result.trellis.status === 'generated') {
        setTrellisNotice({
          tone: result.autorig?.status === 'failed' ? 'warning' : 'success',
          message: `Pixal3D модель готова. ${formatAutorigMessage(result.autorig ?? result.avatar.autorig ?? null)}`,
        })
      } else {
        setTrellisNotice({
          tone: 'warning',
          message: `Pixal3D не вернул 3D-модель, оставили быстрый аватар. ${cleanGenerationDetails(result.trellis.error ?? '')}`.trim(),
        })
      }
      setStep('preview')
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : 'Не удалось создать аватар'
      setError(formatGenerationError(message))
      setStep('review')
    }
  }, [photos.face, photos.fullbody])

  const handleConfirm = useCallback(async () => {
    if (!photos.fullbody || !userId) return
    const facePhoto = photos.face ?? photos.fullbody
    setStep('saving')
    setError(null)
    try {
      const finalAvatar = generated ?? (await generateNoAiAvatar(photos.fullbody, facePhoto)).config
      const avatarPayload = {
        user_id: userId,
        glb_url: finalAvatar.modelUrl ?? finalAvatar.rpmGlbUrl,
        face_tex_url: finalAvatar.faceTextureUrl,
        config_json: finalAvatar,
      }

      const { data: existingAvatar, error: selectError } = await supabase
        .from('avatars')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (selectError) throw selectError

      const { error: dbError } = existingAvatar?.id
        ? await supabase.from('avatars').update(avatarPayload).eq('id', existingAvatar.id)
        : await supabase.from('avatars').insert(avatarPayload)
      if (dbError) throw dbError

      setAvatarConfig(finalAvatar)
      navigate('/outside')
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Не удалось сохранить аватар'
      setError(message)
      setStep('preview')
    }
  }, [generated, navigate, photos.face, photos.fullbody, setAvatarConfig, userId])

  const resetFlow = useCallback(() => {
    stopStream()
    setPhotos({ fullbody: null, face: null })
    setGenerated(null)
    setError(null)
    setTrellisNotice(null)
    setGenerationProcess({ stage: 'source', sourceImage: null, kieImage: null, progress: 0, message: 'Готовим фото' })
    setCameraFacing('environment')
    setStep('intro')
  }, [stopStream])

  if (step === 'intro') {
    return (
      <Screen>
        <div style={{ marginTop: 52 }} />
        <Brand />
        <div style={styles.title}>Создай аватар</div>
        <div style={{ ...styles.copy, maxWidth: 320, marginTop: 10 }}>
          Нужен один кадр в полный рост. Система сама найдёт силуэт и лицо, а затем превратит фото в стилизованную 3D-модель.
        </div>
        <div style={{ ...styles.copy, marginTop: 18, fontSize: 11, color: '#555' }}>
          Оригинальные фото не публикуются
        </div>
        <button
          style={styles.primaryButton}
          onClick={() => {
            setStep('fullbody')
            startCamera('environment')
          }}
        >
          НАЧАТЬ
        </button>
      </Screen>
    )
  }

  if (step === 'fullbody') {
    return (
      <Screen>
        <StepDots step={step} photos={photos} />
        <Brand text="ШАГ 1 из 1" />
        <div style={styles.title}>Полный рост</div>
        <div style={styles.copy}>
          Встань прямо: система сама найдёт силуэт тела и лицо
        </div>
        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.cameraFrame}>
          <video
            ref={videoRef}
            style={styles.video}
            playsInline
            muted
            autoPlay
          />
          {isDetecting && <div style={styles.detectingOverlay}>Определяем...</div>}
        </div>

        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <button style={styles.primaryButton} onClick={handleCapture} disabled={isDetecting}>
          {isDetecting ? 'ОБРАБОТКА' : 'СНЯТЬ'}
        </button>
        <button style={styles.ghostButton} onClick={handleSwitchCamera} disabled={isDetecting}>
          {cameraFacing === 'environment' ? 'ФРОНТАЛЬНАЯ КАМЕРА' : 'ЗАДНЯЯ КАМЕРА'}
        </button>
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture={cameraFacing}
          style={{ display: 'none' }}
          onChange={handleFileUpload}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileUpload}
        />
        <button style={styles.ghostButton} onClick={() => fileInputRef.current?.click()} disabled={isDetecting}>
          Загрузить из галереи
        </button>
      </Screen>
    )
  }

  if (step === 'review') {
    return (
      <Screen>
        <Brand />
        <div style={styles.title}>Проверь фото</div>
        <div style={styles.reviewGrid}>
          <PhotoReview
            label="ПОЛНЫЙ РОСТ"
            src={photos.fullbody}
            onRetake={() => {
              setGenerated(null)
              setStep('fullbody')
              startCamera('environment')
            }}
          />
        </div>
        {error && <div style={styles.error}>{error}</div>}
        <button style={styles.primaryButton} onClick={handleGenerate}>СОЗДАТЬ 3D АВАТАР</button>
        <button style={styles.ghostButton} onClick={resetFlow}>Переснять всё</button>
      </Screen>
    )
  }

  if (step === 'generating' || step === 'saving') {
    return (
      <Screen>
        <div style={{ marginTop: step === 'saving' ? 120 : 28 }} />
        <Brand />
        <div style={styles.title}>{step === 'saving' ? 'Сохраняем...' : 'Собираем персонажа...'}</div>
        <div style={{ ...styles.copy, marginTop: 12 }}>
          {step === 'saving' ? 'Секунду' : trellisNotice?.message ?? 'Генерируем 3D-модель в Pixal3D'}
        </div>
        {step === 'generating' && <GenerationProcessView process={generationProcess} />}
      </Screen>
    )
  }

  if (step === 'preview' && generated) {
    return (
      <Screen>
        <Brand />
        <div style={styles.title}>Твой персонаж</div>
        <AvatarPreview3D config={generated} width={280} height={380} />
        <div style={styles.swatches}>
          <span style={{ ...styles.swatch, background: generated.skinTone }} />
          <span style={{ ...styles.swatch, background: generated.hairColor }} />
          <span style={{ ...styles.swatch, background: generated.topColor }} />
          <span style={{ ...styles.swatch, background: generated.bottomColor }} />
          <span style={{ ...styles.swatch, background: generated.shoesColor }} />
        </div>
        {trellisNotice && (
          <div style={{ ...styles.notice, ...noticeToneStyle(trellisNotice.tone) }}>
            {trellisNotice.message}
          </div>
        )}
        {error && <div style={styles.error}>{error}</div>}
        <div style={styles.actions}>
          <button style={styles.primaryButton} onClick={handleConfirm}>В КЛУБ</button>
          <button style={{ ...styles.ghostButton, marginTop: 16 }} onClick={resetFlow}>Переснять</button>
        </div>
      </Screen>
    )
  }

  return null
}

function Screen({ children }: { children: React.ReactNode }) {
  return <div style={styles.screen}>{children}</div>
}

function Brand({ text = 'DOOR//CLUB' }: { text?: string }) {
  return <div style={styles.brand}>{text}</div>
}

function isKiePreparationError(message: string): boolean {
  return message.includes('KIE') || message.includes('KIE_API_KEYS')
}

function cleanGenerationDetails(details: string): string {
  return details
    .replace(/<[^>]*>/g, ' ')
    .replace(/KIE_API_KEYS/g, 'ключи сервиса генерации')
    .replace(/KIE/gi, 'Kie')
    .replace(/Hugging Face Pixal3D/gi, 'Pixal3D')
    .replace(/Hugging Face TRELLIS\.?2?/gi, 'Pixal3D')
    .replace(/TRELLIS\.?2?/gi, 'Pixal3D')
    .replace(/GLB/gi, '3D-модель')
    .replace(/Blender autorig/gi, 'подготовка движений')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatGenerationError(message: string): string {
  if (isKiePreparationError(message)) {
    return `Kie не подготовил фото для Pixal3D. ${cleanGenerationDetails(message)}`.trim()
  }

  return cleanGenerationDetails(message)
}

function formatAutorigMessage(autorig: AvatarConfig['autorig']): string {
  if (!autorig) return 'Подготовка движений: статус не получен'
  if (autorig.status === 'generated') return 'Подготовка движений: готово'
  if (autorig.status === 'disabled') return 'Подготовка движений: выключена'
  const details = autorig.error ? ` (${cleanGenerationDetails(autorig.error).slice(0, 120)})` : ''
  return `Подготовка движений: ошибка${details}`
}

function noticeToneStyle(tone: NonNullable<TrellisNotice>['tone']): CSSProperties {
  if (tone === 'success') return { color: '#75ff9b' }
  if (tone === 'warning') return { color: '#ffcc66' }
  return { color: '#888' }
}

function processPipelineEvent(
  current: GenerationProcess,
  event: AvatarPipelineEvent,
  sourceImage: string,
): GenerationProcess {
  return {
    stage: event.stage,
    sourceImage,
    kieImage: event.prepared?.image ?? current.kieImage,
    progress: Math.max(current.progress, event.progress),
    message: event.message,
  }
}

function GenerationProcessView({ process }: { process: GenerationProcess }) {
  const stages: Array<{ key: PipelineStage; label: string }> = [
    { key: 'source', label: 'Исходное фото' },
    { key: 'fallback', label: 'Fallback' },
    { key: 'kie_upload', label: 'Kie upload' },
    { key: 'kie_create', label: 'Kie task' },
    { key: 'kie_wait', label: 'Kie generation' },
    { key: 'kie_download', label: 'Kie download' },
    { key: 'kie_done', label: 'Kie photo' },
    { key: 'trellis_connect', label: 'Pixal3D connect' },
    { key: 'trellis_session', label: 'Pixal3D session' },
    { key: 'trellis_preprocess', label: 'Pixal3D preprocess' },
    { key: 'trellis_generate', label: 'Pixal3D GLB' },
    { key: 'trellis_upload', label: 'GLB save' },
    { key: 'autorig', label: 'Движения' },
    { key: 'save', label: 'Сохранение' },
    { key: 'done', label: 'Готово' },
  ]
  const activeIndex = Math.max(0, stages.findIndex((stage) => stage.key === process.stage))
  const showProgress = process.stage !== 'source'

  return (
    <div style={styles.pipelinePanel}>
      <div style={styles.pipelineSteps}>
        {stages.map((stage, index) => (
          <div
            key={stage.key}
            style={{
              ...styles.pipelineStep,
              ...(index < activeIndex ? styles.pipelineStepDone : {}),
              ...(index === activeIndex ? styles.pipelineStepActive : {}),
            }}
          >
            {stage.label}
          </div>
        ))}
      </div>

      {showProgress && (
        <div style={styles.progressWrap}>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${Math.max(0, Math.min(100, process.progress))}%` }} />
          </div>
          <div style={styles.progressText}>{Math.round(process.progress)}%</div>
        </div>
      )}

      <div style={styles.pipelineImages}>
        {process.sourceImage && (
          <PipelineImage label="исходное фото" src={process.sourceImage} wide={false} />
        )}
        {process.kieImage && (
          <PipelineImage label="фото из Kie" src={process.kieImage} wide={false} />
        )}
      </div>

      <div style={styles.pipelinePlaceholder}>
        {process.message || formatTrellisPipelineHint(process.stage)}
      </div>
    </div>
  )
}

function PipelineImage({ label, src, wide }: { label: string; src: string; wide: boolean }) {
  return (
    <div style={wide ? styles.pipelineImageWideWrap : styles.pipelineImageWrap}>
      <div style={styles.photoLabel}>{label}</div>
      <img
        src={src}
        alt={label}
        style={wide ? styles.pipelineImageWide : styles.pipelineImage}
      />
    </div>
  )
}

function formatTrellisPipelineHint(stage: PipelineStage): string {
  if (stage === 'fallback') return 'Локальный аватар готов как fallback'
  if (stage.startsWith('kie_')) return 'Kie готовит фото, которое пойдёт в Pixal3D'
  if (stage.startsWith('trellis_')) return 'Pixal3D строит 3D-модель по фото из Kie'
  if (stage === 'autorig') return 'Подготавливаем модель для движения'
  if (stage === 'save') return 'Сохраняем аватар'
  if (stage === 'done') return '3D-модель готова для персонажа'
  if (stage === 'failed') return 'Генерация остановилась'
  return 'Готовим фото'
}

function StepDots({ step, photos }: { step: Step; photos: Photos }) {
  return (
    <div style={styles.stepDots}>
      {(['fullbody', 'review'] as const).map((key) => (
        <div
          key={key}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background:
              key === 'fullbody' && photos.fullbody
                ? '#e040fb'
                : step === key
                  ? '#fff'
                  : '#333',
          }}
        />
      ))}
    </div>
  )
}

function PhotoReview({ label, src, onRetake }: {
  label: string
  src: string | null
  onRetake: () => void
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={styles.photoLabel}>{label}</div>
      {src && <img src={src} style={styles.photo} alt={label} />}
      <button style={{ ...styles.ghostButton, marginTop: 8 }} onClick={onRetake}>Переснять</button>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  screen: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100vh',
    maxHeight: '100dvh',
    minHeight: '100svh',
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehaviorY: 'contain',
    touchAction: 'pan-y',
    background: '#0d0d1a',
    color: '#e8e8f0',
    fontFamily: 'monospace',
    padding: '20px 16px calc(32px + env(safe-area-inset-bottom, 0px))',
  },
  brand: {
    fontSize: 11,
    color: '#e040fb',
    letterSpacing: 3,
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 8,
  },
  copy: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
    lineHeight: 1.6,
  },
  primaryButton: {
    marginTop: 16,
    padding: '14px 32px',
    minHeight: 44,
    background: '#e040fb',
    color: '#0d0d1a',
    border: 'none',
    borderRadius: 4,
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: 2,
  },
  ghostButton: {
    marginTop: 8,
    padding: '12px 24px',
    minHeight: 40,
    background: 'transparent',
    color: '#888',
    border: '1px solid #333',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
    cursor: 'pointer',
  },
  cameraFrame: {
    width: '100%',
    maxWidth: 400,
    marginTop: 16,
    position: 'relative',
  },
  video: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 8,
    border: '1px solid #2a2a3a',
    background: '#111',
    display: 'block',
  },
  detectingOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    background: 'rgba(13,13,26,0.68)',
    color: '#e8e8f0',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 2,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  photo: {
    width: '100%',
    maxWidth: 170,
    height: 220,
    objectFit: 'cover',
    borderRadius: 8,
    border: '1px solid #2a2a3a',
    background: '#111',
  },
  photoLabel: {
    fontSize: 11,
    color: '#888',
    marginBottom: 8,
  },
  reviewGrid: {
    display: 'flex',
    gap: 14,
    marginTop: 16,
    alignItems: 'flex-start',
  },
  error: {
    color: '#ff4444',
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
  notice: {
    fontSize: 12,
    marginTop: 10,
    maxWidth: 760,
    textAlign: 'center',
    lineHeight: 1.5,
  },
  pipelinePanel: {
    width: '100%',
    maxWidth: 640,
    marginTop: 18,
  },
  pipelineSteps: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 6,
    width: '100%',
  },
  pipelineStep: {
    minHeight: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px 6px',
    border: '1px solid #292938',
    borderRadius: 4,
    color: '#666',
    fontSize: 9,
    lineHeight: 1.15,
    textAlign: 'center',
    overflow: 'hidden',
    whiteSpace: 'normal',
  },
  pipelineStepDone: {
    color: '#b18bb9',
    borderColor: '#4a3050',
    background: 'rgba(224,64,251,0.08)',
  },
  pipelineStepActive: {
    color: '#0d0d1a',
    background: '#e040fb',
    borderColor: '#e040fb',
  },
  progressWrap: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 44px',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    background: '#1a1a28',
    border: '1px solid #292938',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    background: '#e040fb',
    transition: 'width 0.24s ease',
  },
  progressText: {
    color: '#e8e8f0',
    fontSize: 12,
    textAlign: 'right',
  },
  pipelineImages: {
    display: 'flex',
    gap: 12,
    justifyContent: 'center',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    marginTop: 16,
  },
  pipelineImageWrap: {
    width: 120,
    textAlign: 'center',
  },
  pipelineImageWideWrap: {
    width: 'min(100%, 360px)',
    textAlign: 'center',
  },
  pipelineImage: {
    width: 120,
    height: 220,
    objectFit: 'contain',
    objectPosition: 'center',
    borderRadius: 6,
    border: '1px solid #2a2a3a',
    background: '#050509',
  },
  pipelineImageWide: {
    width: '100%',
    aspectRatio: '4 / 3',
    objectFit: 'contain',
    borderRadius: 6,
    border: '1px solid #2a2a3a',
    background: '#050509',
  },
  pipelinePlaceholder: {
    marginTop: 18,
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
  },
  stepDots: {
    display: 'flex',
    gap: 8,
    marginBottom: 24,
  },
  actions: {
    display: 'flex',
    gap: 10,
    justifyContent: 'center',
    flexWrap: 'wrap',
    marginTop: 0,
  },
  swatches: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 3,
    border: '1px solid rgba(255,255,255,0.18)',
  },
}
