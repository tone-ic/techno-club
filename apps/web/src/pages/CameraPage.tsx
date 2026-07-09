import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AvatarConfig, GarmentPatternSize, OutfitAnalysisResult, OutfitDetectedItem } from '@shared/types'
import { analyzeOutfit, generateGarmentImage } from '@/avatar/fashionPipeline'
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

type Step = 'intro' | 'fullbody' | 'review' | 'outfitAnalyzing' | 'wardrobe' | 'generating' | 'preview' | 'saving'
type CameraFacing = 'user' | 'environment'
type TrellisNotice = {
  tone: 'pending' | 'success' | 'warning'
  message: string
} | null
type ImageGenerationStatus = 'idle' | 'loading' | 'success' | 'error'

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

interface ImageGenerationState {
  status: ImageGenerationStatus
  image: string | null
  error: string | null
}

type ItemImageMap = Record<number, ImageGenerationState>
type PatternImageMap = Record<number, Partial<Record<GarmentPatternSize, ImageGenerationState>>>

const PATTERN_SIZES: GarmentPatternSize[] = ['S', 'M', 'L', 'XL']

function idleImageState(): ImageGenerationState {
  return { status: 'idle', image: null, error: null }
}

function loadingImageState(): ImageGenerationState {
  return { status: 'loading', image: null, error: null }
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
  const [outfitAnalysis, setOutfitAnalysis] = useState<OutfitAnalysisResult | null>(null)
  const [selectedItemNumber, setSelectedItemNumber] = useState<number | null>(null)
  const [itemImages, setItemImages] = useState<ItemImageMap>({})
  const [patternImages, setPatternImages] = useState<PatternImageMap>({})
  const [similarImages, setSimilarImages] = useState<ItemImageMap>({})
  const [patternSize, setPatternSize] = useState<GarmentPatternSize>('M')
  const [similarity, setSimilarity] = useState(70)
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

  const resetOutfitState = useCallback(() => {
    setOutfitAnalysis(null)
    setSelectedItemNumber(null)
    setItemImages({})
    setPatternImages({})
    setSimilarImages({})
    setPatternSize('M')
    setSimilarity(70)
  }, [])

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
    resetOutfitState()
    setTrellisNotice(null)
    setGenerationProcess({ stage: 'source', sourceImage: null, kieImage: null, progress: 0, message: 'Готовим фото' })
    setPhotos({ fullbody: normalizedFullbody, face: normalizedFace })
    setStep('review')
  }, [resetOutfitState, stopStream])

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
        message: 'Быстрый аватар готов',
      })
      setTrellisNotice({ tone: 'pending', message: 'Подготавливаем фото' })

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
          tone: 'success',
          message: `3D-модель готова. ${formatAutorigMessage(result.autorig ?? result.avatar.autorig ?? null)}`,
        })
      } else {
        setTrellisNotice({
          tone: 'warning',
          message: `3D-модель не получилась, оставили быстрый аватар. ${cleanGenerationDetails(result.trellis.error ?? '')}`.trim(),
        })
      }
      setStep('preview')
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : 'Не удалось создать аватар'
      setError(formatGenerationError(message))
      setStep('review')
    }
  }, [photos.face, photos.fullbody])

  const handleAnalyzeOutfit = useCallback(async () => {
    const fullbodyPhoto = photos.fullbody
    if (!fullbodyPhoto) return

    setStep('outfitAnalyzing')
    setError(null)
    resetOutfitState()

    try {
      const analysis = await analyzeOutfit(fullbodyPhoto)
      setOutfitAnalysis(analysis)
      setSelectedItemNumber(analysis.items[0]?.number ?? null)
      setStep('wardrobe')
    } catch (analysisError) {
      const message = analysisError instanceof Error ? analysisError.message : 'Не удалось проанализировать одежду'
      setError(cleanGenerationDetails(message))
      setStep('review')
    }
  }, [photos.fullbody, resetOutfitState])

  const ensureGarmentExtract = useCallback(async (item: OutfitDetectedItem) => {
    const sourceImage = photos.fullbody
    if (!sourceImage) return

    const existing = itemImages[item.number]
    if (existing?.status === 'loading' || existing?.status === 'success') return

    setItemImages((current) => ({
      ...current,
      [item.number]: loadingImageState(),
    }))

    try {
      const result = await generateGarmentImage({
        mode: 'extract',
        sourceImage,
        item,
      })
      setItemImages((current) => ({
        ...current,
        [item.number]: { status: 'success', image: result.image, error: null },
      }))
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : 'Не удалось создать фото изделия'
      setItemImages((current) => ({
        ...current,
        [item.number]: { status: 'error', image: null, error: cleanGenerationDetails(message) },
      }))
    }
  }, [itemImages, photos.fullbody])

  const handleSelectOutfitItem = useCallback((item: OutfitDetectedItem) => {
    setSelectedItemNumber(item.number)
    setError(null)
    void ensureGarmentExtract(item)
  }, [ensureGarmentExtract])

  const handleGeneratePattern = useCallback(async () => {
    const item = outfitAnalysis?.items.find((candidate) => candidate.number === selectedItemNumber)
    if (!item) return

    const itemImage = itemImages[item.number]
    if (itemImage?.status !== 'success' || !itemImage.image) {
      setError('Сначала нужно сгенерировать отдельное фото изделия')
      return
    }

    setError(null)
    setPatternImages((current) => ({
      ...current,
      [item.number]: {
        ...(current[item.number] ?? {}),
        [patternSize]: loadingImageState(),
      },
    }))

    try {
      const result = await generateGarmentImage({
        mode: 'pattern',
        sourceImage: itemImage.image,
        item,
        patternSize,
      })
      setPatternImages((current) => ({
        ...current,
        [item.number]: {
          ...(current[item.number] ?? {}),
          [patternSize]: { status: 'success', image: result.image, error: null },
        },
      }))
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : 'Не удалось создать лекала'
      setPatternImages((current) => ({
        ...current,
        [item.number]: {
          ...(current[item.number] ?? {}),
          [patternSize]: { status: 'error', image: null, error: cleanGenerationDetails(message) },
        },
      }))
    }
  }, [itemImages, outfitAnalysis?.items, patternSize, selectedItemNumber])

  const handleGenerateSimilar = useCallback(async () => {
    const item = outfitAnalysis?.items.find((candidate) => candidate.number === selectedItemNumber)
    if (!item) return

    const itemImage = itemImages[item.number]
    if (itemImage?.status !== 'success' || !itemImage.image) {
      setError('Сначала нужно сгенерировать отдельное фото изделия')
      return
    }

    setError(null)
    setSimilarImages((current) => ({
      ...current,
      [item.number]: loadingImageState(),
    }))

    try {
      const result = await generateGarmentImage({
        mode: 'similar',
        sourceImage: itemImage.image,
        item,
        similarity,
      })
      setSimilarImages((current) => ({
        ...current,
        [item.number]: { status: 'success', image: result.image, error: null },
      }))
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : 'Не удалось создать похожее изделие'
      setSimilarImages((current) => ({
        ...current,
        [item.number]: { status: 'error', image: null, error: cleanGenerationDetails(message) },
      }))
    }
  }, [itemImages, outfitAnalysis?.items, selectedItemNumber, similarity])

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
    resetOutfitState()
    setError(null)
    setTrellisNotice(null)
    setGenerationProcess({ stage: 'source', sourceImage: null, kieImage: null, progress: 0, message: 'Готовим фото' })
    setCameraFacing('environment')
    setStep('intro')
  }, [resetOutfitState, stopStream])

  const selectedItem = outfitAnalysis?.items.find((item) => item.number === selectedItemNumber) ?? null
  const selectedItemImage = selectedItem ? itemImages[selectedItem.number] ?? idleImageState() : idleImageState()
  const selectedPatternImage = selectedItem
    ? patternImages[selectedItem.number]?.[patternSize] ?? idleImageState()
    : idleImageState()
  const selectedSimilarImage = selectedItem ? similarImages[selectedItem.number] ?? idleImageState() : idleImageState()

  if (step === 'intro') {
    return (
      <Screen>
        <div style={{ marginTop: 52 }} />
        <Brand />
        <div style={styles.title}>Исследуй одежду</div>
        <div style={{ ...styles.copy, maxWidth: 320, marginTop: 10 }}>
          Загрузи фото в полный рост: Gemini пронумерует одежду и аксессуары, а GPT Image 2 подготовит отдельные изделия.
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
        <div style={styles.title}>Фото образа</div>
        <div style={styles.copy}>
          Лучше всего работает кадр, где человек и детали одежды видны целиком
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
        <button style={styles.primaryButton} onClick={handleAnalyzeOutfit}>АНАЛИЗИРОВАТЬ ОДЕЖДУ</button>
        <button style={styles.ghostButton} onClick={handleGenerate}>Создать 3D аватар</button>
        <button style={styles.ghostButton} onClick={resetFlow}>Переснять всё</button>
      </Screen>
    )
  }

  if (step === 'outfitAnalyzing') {
    return (
      <Screen>
        <div style={{ marginTop: 48 }} />
        <Brand />
        <div style={styles.title}>Анализируем образ</div>
        <div style={{ ...styles.copy, marginTop: 12 }}>
          Gemini выделяет все элементы одежды и аксессуары
        </div>
        <OutfitAnalysisLoading sourceImage={photos.fullbody} />
      </Screen>
    )
  }

  if (step === 'wardrobe' && outfitAnalysis) {
    return (
      <Screen>
        <Brand />
        <div style={styles.title}>Элементы образа</div>
        <div style={{ ...styles.copy, maxWidth: 760 }}>{outfitAnalysis.overview}</div>
        {error && <div style={styles.error}>{error}</div>}
        <FashionWorkspace
          analysis={outfitAnalysis}
          sourceImage={photos.fullbody}
          selectedItem={selectedItem}
          selectedItemImage={selectedItemImage}
          selectedPatternImage={selectedPatternImage}
          selectedSimilarImage={selectedSimilarImage}
          patternSize={patternSize}
          similarity={similarity}
          onSelectItem={handleSelectOutfitItem}
          onPatternSizeChange={setPatternSize}
          onSimilarityChange={setSimilarity}
          onGeneratePattern={handleGeneratePattern}
          onGenerateSimilar={handleGenerateSimilar}
          onBackToPhoto={() => setStep('review')}
          onReset={resetFlow}
        />
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
          {step === 'saving' ? 'Секунду' : trellisNotice?.message ?? 'Собираем 3D-модель'}
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
    .replace(/KIE_API_KEYS/g, 'ключи модуля генерации')
    .replace(/Hugging Face Pixal3D/gi, 'модуль 3D-сборки')
    .replace(/Hugging Face TRELLIS\.?2?/gi, 'модуль 3D-сборки')
    .replace(/Pixal3D/gi, 'модуль 3D-сборки')
    .replace(/TRELLIS\.?2?/gi, 'модуль 3D-сборки')
    .replace(/\bKIE\b/gi, 'модуль подготовки фото')
    .replace(/ENOENT: no such file or directory, open '[^']*rigged\.(?:glb|3D-модель)'/gi, 'подготовка движений не создала файл 3D-модели')
    .replace(/\bGLB\b/gi, '3D-модель')
    .replace(/Blender autorig/gi, 'подготовка движений')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatGenerationError(message: string): string {
  if (isKiePreparationError(message)) {
    return `Не удалось подготовить фото для 3D-модели. ${cleanGenerationDetails(message)}`.trim()
  }

  return cleanGenerationDetails(message)
}

function formatAutorigMessage(autorig: AvatarConfig['autorig']): string {
  if (!autorig) return 'Подготовка движений: локальная анимация включена'
  if (autorig.status === 'generated') return 'Подготовка движений: готово'
  return 'Подготовка движений: локальная анимация включена'
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
    { key: 'fallback', label: 'Быстрый аватар' },
    { key: 'kie_upload', label: 'Загрузка фото' },
    { key: 'kie_create', label: 'Подготовка' },
    { key: 'kie_wait', label: 'Обработка фото' },
    { key: 'kie_download', label: 'Получение фото' },
    { key: 'kie_done', label: 'Фото готово' },
    { key: 'trellis_connect', label: '3D подключение' },
    { key: 'trellis_session', label: 'Очередь сборки' },
    { key: 'trellis_preprocess', label: 'Нормализация' },
    { key: 'trellis_generate', label: '3D сборка' },
    { key: 'trellis_upload', label: 'Сохранение модели' },
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
          <PipelineImage label="подготовленное фото" src={process.kieImage} wide={false} />
        )}
      </div>

      <div style={styles.pipelinePlaceholder}>
        {process.message || formatTrellisPipelineHint(process.stage)}
      </div>
    </div>
  )
}

function OutfitAnalysisLoading({ sourceImage }: { sourceImage: string | null }) {
  return (
    <div style={styles.analysisLoading}>
      {sourceImage && <img src={sourceImage} alt="исходное фото" style={styles.analysisSourceImage} />}
      <div style={styles.loadingStack}>
        <div className="fashion-spinner" />
        <div style={styles.pipelinePlaceholder}>Готовим нумерованный список изделий</div>
      </div>
    </div>
  )
}

function FashionWorkspace({
  analysis,
  sourceImage,
  selectedItem,
  selectedItemImage,
  selectedPatternImage,
  selectedSimilarImage,
  patternSize,
  similarity,
  onSelectItem,
  onPatternSizeChange,
  onSimilarityChange,
  onGeneratePattern,
  onGenerateSimilar,
  onBackToPhoto,
  onReset,
}: {
  analysis: OutfitAnalysisResult
  sourceImage: string | null
  selectedItem: OutfitDetectedItem | null
  selectedItemImage: ImageGenerationState
  selectedPatternImage: ImageGenerationState
  selectedSimilarImage: ImageGenerationState
  patternSize: GarmentPatternSize
  similarity: number
  onSelectItem: (item: OutfitDetectedItem) => void
  onPatternSizeChange: (size: GarmentPatternSize) => void
  onSimilarityChange: (value: number) => void
  onGeneratePattern: () => void
  onGenerateSimilar: () => void
  onBackToPhoto: () => void
  onReset: () => void
}) {
  const productReady = selectedItemImage.status === 'success' && Boolean(selectedItemImage.image)

  return (
    <div style={styles.wardrobeLayout}>
      <div style={styles.outfitColumn}>
        {sourceImage && <img src={sourceImage} alt="исходное фото" style={styles.sourcePreviewImage} />}
        <div style={styles.outfitList}>
          {analysis.items.map((item) => {
            const active = selectedItem?.number === item.number
            return (
              <button
                key={item.number}
                style={{ ...styles.outfitButton, ...(active ? styles.outfitButtonActive : {}) }}
                onClick={() => onSelectItem(item)}
              >
                <span style={styles.itemNumberBadge}>{item.number}</span>
                <span style={styles.itemButtonText}>
                  <span style={styles.itemTitle}>{item.title}</span>
                  <span style={styles.itemMeta}>{item.category}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div style={styles.detailColumn}>
        {selectedItem ? (
          <>
            <div style={styles.detailHeader}>
              <div>
                <div style={styles.detailTitle}>#{selectedItem.number} {selectedItem.title}</div>
                <div style={styles.itemMeta}>{selectedItem.category} · уверенность {Math.round(selectedItem.confidence * 100)}%</div>
              </div>
            </div>

            <div style={styles.detailGrid}>
              <div style={styles.infoPanel}>
                <div style={styles.detailSectionTitle}>Описание</div>
                <div style={styles.detailText}>{selectedItem.detailedDescription}</div>
                <DetailTags label="Цвета" values={selectedItem.colors} />
                <DetailTags label="Материалы" values={selectedItem.materials} />
                <DetailTags label="Детали" values={selectedItem.visibleFeatures} />
                <DetailTags label="Конструкция" values={selectedItem.constructionNotes} />
              </div>

              <GeneratedImagePanel
                title="Фото изделия"
                state={selectedItemImage}
                aspect="square"
                idleText="Нажми элемент в списке, чтобы создать отдельное фото"
              />
            </div>

            <div style={styles.generationGrid}>
              <div style={styles.toolPanel}>
                <div style={styles.detailSectionTitle}>Лекала</div>
                <div style={styles.sizePicker}>
                  {PATTERN_SIZES.map((size) => (
                    <button
                      key={size}
                      style={{ ...styles.sizeButton, ...(patternSize === size ? styles.sizeButtonActive : {}) }}
                      onClick={() => onPatternSizeChange(size)}
                    >
                      {size}
                    </button>
                  ))}
                </div>
                <button
                  style={{ ...styles.primaryButton, ...styles.toolButton }}
                  onClick={onGeneratePattern}
                  disabled={!productReady || selectedPatternImage.status === 'loading'}
                >
                  {selectedPatternImage.status === 'loading' ? 'ГЕНЕРАЦИЯ' : `ЛЕКАЛА ${patternSize}`}
                </button>
                <GeneratedImagePanel
                  title={`Чертеж ${patternSize}`}
                  state={selectedPatternImage}
                  aspect="wide"
                  idleText="Лекала появятся здесь"
                />
              </div>

              <div style={styles.toolPanel}>
                <div style={styles.detailSectionTitle}>Похожее изделие</div>
                <div style={styles.sliderRow}>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={similarity}
                    onChange={(event) => onSimilarityChange(Number(event.target.value))}
                    style={styles.similaritySlider}
                  />
                  <div style={styles.sliderValue}>{similarity}%</div>
                </div>
                <button
                  style={{ ...styles.primaryButton, ...styles.toolButton }}
                  onClick={onGenerateSimilar}
                  disabled={!productReady || selectedSimilarImage.status === 'loading'}
                >
                  {selectedSimilarImage.status === 'loading' ? 'ГЕНЕРАЦИЯ' : 'СОЗДАТЬ ПОХОЖЕЕ'}
                </button>
                <GeneratedImagePanel
                  title="Вариант"
                  state={selectedSimilarImage}
                  aspect="square"
                  idleText="Похожее изделие появится здесь"
                />
              </div>
            </div>
          </>
        ) : (
          <div style={styles.emptySelection}>Выбери элемент из списка</div>
        )}

        <div style={styles.actions}>
          <button style={styles.ghostButton} onClick={onBackToPhoto}>Назад к фото</button>
          <button style={styles.ghostButton} onClick={onReset}>Новое фото</button>
        </div>
      </div>
    </div>
  )
}

function DetailTags({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null
  return (
    <div style={styles.tagBlock}>
      <div style={styles.tagLabel}>{label}</div>
      <div style={styles.tagList}>
        {values.map((value) => <span key={value} style={styles.tag}>{value}</span>)}
      </div>
    </div>
  )
}

function GeneratedImagePanel({
  title,
  state,
  aspect,
  idleText,
}: {
  title: string
  state: ImageGenerationState
  aspect: 'square' | 'wide'
  idleText: string
}) {
  const frameStyle = aspect === 'wide' ? styles.generatedWideFrame : styles.generatedSquareFrame
  return (
    <div style={styles.generatedPanel}>
      <div style={styles.detailSectionTitle}>{title}</div>
      <div style={frameStyle}>
        {state.status === 'loading' && (
          <div style={styles.loadingStack}>
            <div className="fashion-spinner" />
            <div style={styles.pipelinePlaceholder}>Генерируем изображение</div>
          </div>
        )}
        {state.status === 'success' && state.image && (
          <img src={state.image} alt={title} style={styles.generatedImage} />
        )}
        {state.status === 'error' && (
          <div style={styles.imageError}>{state.error ?? 'Генерация не удалась'}</div>
        )}
        {state.status === 'idle' && (
          <div style={styles.imageEmpty}>{idleText}</div>
        )}
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
  if (stage === 'fallback') return 'Быстрый аватар готов'
  if (stage.startsWith('kie_')) return 'Готовим фото для 3D-модели'
  if (stage.startsWith('trellis_')) return 'Собираем 3D-модель'
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
    aspectRatio: '9 / 16',
    maxHeight: 'min(52vh, 360px)',
    objectFit: 'contain',
    borderRadius: 8,
    border: '1px solid #2a2a3a',
    background: '#050509',
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
  analysisLoading: {
    width: '100%',
    maxWidth: 640,
    marginTop: 22,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
    alignItems: 'center',
    gap: 18,
  },
  analysisSourceImage: {
    width: '100%',
    aspectRatio: '9 / 16',
    maxHeight: 420,
    objectFit: 'contain',
    borderRadius: 8,
    border: '1px solid #2a2a3a',
    background: '#050509',
  },
  loadingStack: {
    minHeight: 120,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  wardrobeLayout: {
    width: '100%',
    maxWidth: 1080,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
    gap: 18,
    alignItems: 'start',
    marginTop: 18,
  },
  outfitColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minWidth: 0,
  },
  sourcePreviewImage: {
    width: '100%',
    aspectRatio: '9 / 16',
    maxHeight: 320,
    objectFit: 'contain',
    borderRadius: 8,
    border: '1px solid #2a2a3a',
    background: '#050509',
  },
  outfitList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  outfitButton: {
    minHeight: 56,
    display: 'grid',
    gridTemplateColumns: '30px minmax(0, 1fr)',
    alignItems: 'center',
    gap: 10,
    padding: '9px 10px',
    borderRadius: 6,
    border: '1px solid #303044',
    background: '#11111e',
    color: '#e8e8f0',
    textAlign: 'left',
  },
  outfitButtonActive: {
    borderColor: '#00e5ff',
    background: 'rgba(0,229,255,0.09)',
  },
  itemNumberBadge: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    background: '#00e5ff',
    color: '#050509',
    fontSize: 12,
    fontWeight: 700,
  },
  itemButtonText: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  itemTitle: {
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.25,
    overflowWrap: 'anywhere',
  },
  itemMeta: {
    color: '#888',
    fontSize: 10,
    lineHeight: 1.4,
  },
  detailColumn: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  detailHeader: {
    minHeight: 46,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottom: '1px solid #292938',
    paddingBottom: 10,
  },
  detailTitle: {
    fontSize: 17,
    fontWeight: 700,
    lineHeight: 1.25,
    overflowWrap: 'anywhere',
  },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
    gap: 14,
    alignItems: 'start',
  },
  infoPanel: {
    minWidth: 0,
    border: '1px solid #292938',
    borderRadius: 8,
    padding: 14,
    background: '#10101b',
  },
  detailSectionTitle: {
    color: '#00e5ff',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1,
    marginBottom: 8,
  },
  detailText: {
    color: '#d8d8e4',
    fontSize: 13,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  tagBlock: {
    marginTop: 12,
  },
  tagLabel: {
    color: '#777',
    fontSize: 10,
    marginBottom: 6,
  },
  tagList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    maxWidth: '100%',
    padding: '5px 7px',
    borderRadius: 4,
    border: '1px solid #303044',
    color: '#cfcfe6',
    background: '#151525',
    fontSize: 10,
    lineHeight: 1.2,
    overflowWrap: 'anywhere',
  },
  generatedPanel: {
    minWidth: 0,
  },
  generatedSquareFrame: {
    width: '100%',
    aspectRatio: '1 / 1',
    minHeight: 220,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    border: '1px solid #292938',
    background: '#050509',
    overflow: 'hidden',
  },
  generatedWideFrame: {
    width: '100%',
    aspectRatio: '16 / 9',
    minHeight: 160,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    border: '1px solid #292938',
    background: '#050509',
    overflow: 'hidden',
  },
  generatedImage: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  },
  imageEmpty: {
    maxWidth: 220,
    padding: 16,
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 1.5,
  },
  imageError: {
    maxWidth: 240,
    padding: 16,
    color: '#ff6b6b',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 1.45,
    overflowWrap: 'anywhere',
  },
  generationGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
    gap: 14,
  },
  toolPanel: {
    minWidth: 0,
    border: '1px solid #292938',
    borderRadius: 8,
    padding: 14,
    background: '#10101b',
  },
  sizePicker: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: 6,
  },
  sizeButton: {
    minHeight: 34,
    borderRadius: 4,
    border: '1px solid #303044',
    background: '#151525',
    color: '#d8d8e4',
    fontSize: 12,
    fontWeight: 700,
  },
  sizeButtonActive: {
    color: '#050509',
    borderColor: '#00e5ff',
    background: '#00e5ff',
  },
  toolButton: {
    width: '100%',
    marginTop: 12,
    marginBottom: 12,
    padding: '12px 14px',
    fontSize: 11,
    letterSpacing: 1,
  },
  sliderRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 46px',
    gap: 10,
    alignItems: 'center',
  },
  similaritySlider: {
    width: '100%',
    minWidth: 0,
    accentColor: '#00e5ff',
  },
  sliderValue: {
    color: '#d8d8e4',
    fontSize: 12,
    textAlign: 'right',
  },
  emptySelection: {
    minHeight: 240,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #292938',
    borderRadius: 8,
    color: '#777',
    fontSize: 13,
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
