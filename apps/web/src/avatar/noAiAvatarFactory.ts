import type { AvatarConfig } from '@shared/types'

type ZoneName = 'top' | 'bottom' | 'shoes'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface RGB {
  r: number
  g: number
  b: number
}

interface PixelBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface DetectedFace {
  boundingBox: DOMRectReadOnly
}

type FaceDetectorCtor = new (options?: {
  fastMode?: boolean
  maxDetectedFaces?: number
}) => {
  detect: (source: CanvasImageSource) => Promise<DetectedFace[]>
}

type WindowWithFaceDetector = Window & {
  FaceDetector?: FaceDetectorCtor
}

export interface NoAiAvatarAnalysis {
  qualityScore: number
  bodyId: string
  headId: string
  hairStyle: string
  topStyle: string
  bottomStyle: string
  shoesStyle: string
  mood: AvatarConfig['mood']
  skinTone: string
  hairColor: string
  topColor: string
  bottomColor: string
  shoesColor: string
}

export interface GeneratedNoAiAvatar {
  config: AvatarConfig
  analysis: NoAiAvatarAnalysis
}

const BODY_ZONES: Record<ZoneName, Rect> = {
  top: { x: 0.34, y: 0.22, w: 0.32, h: 0.26 },
  bottom: { x: 0.36, y: 0.5, w: 0.28, h: 0.28 },
  shoes: { x: 0.35, y: 0.82, w: 0.3, h: 0.1 },
}

const FACE_SKIN_ZONE: Rect = { x: 0.28, y: 0.42, w: 0.44, h: 0.36 }
const FACE_HAIR_ZONE: Rect = { x: 0.18, y: 0.02, w: 0.64, h: 0.28 }
const FACE_SIDE_HAIR_ZONE: Rect = { x: 0.08, y: 0.22, w: 0.84, h: 0.48 }
const BODY_OUTPUT_RATIO = 3 / 4
const FACE_OUTPUT_RATIO = 4 / 5

export async function generateNoAiAvatar(
  fullbodyDataUrl: string,
  faceDataUrl: string,
): Promise<GeneratedNoAiAvatar> {
  const [bodyImage, faceImage] = await Promise.all([
    loadImage(fullbodyDataUrl),
    loadImage(faceDataUrl),
  ])

  const skinTone = colorToHex(sampleDominantColor(faceImage, FACE_SKIN_ZONE, {
    preferSkin: true,
    fallback: { r: 200, g: 149, b: 108 },
  }))

  const skinRgb = hexToRgb(skinTone)
  const hairColor = colorToHex(sampleDominantColor(faceImage, FACE_HAIR_ZONE, {
    preferDark: true,
    avoidColor: skinRgb,
    fallback: { r: 26, g: 16, b: 8 },
  }))

  const topColor = colorToHex(sampleDominantColor(bodyImage, BODY_ZONES.top, {
    avoidColor: skinRgb,
    fallback: { r: 34, g: 34, b: 68 },
  }))
  const bottomColor = colorToHex(sampleDominantColor(bodyImage, BODY_ZONES.bottom, {
    avoidColor: skinRgb,
    fallback: { r: 17, g: 17, b: 51 },
  }))
  const shoesColor = colorToHex(sampleDominantColor(bodyImage, BODY_ZONES.shoes, {
    fallback: { r: 17, g: 17, b: 17 },
  }))

  const analysis: NoAiAvatarAnalysis = {
    qualityScore: estimateQuality(bodyImage, faceImage),
    bodyId: estimateBodyId(bodyImage, topColor, bottomColor),
    headId: estimateHeadId(faceImage),
    hairStyle: estimateHairStyle(faceImage, skinRgb),
    topStyle: estimateTopStyle(topColor, bottomColor),
    bottomStyle: estimateBottomStyle(bottomColor, skinTone),
    shoesStyle: estimateShoesStyle(shoesColor),
    mood: estimateMood(topColor, bottomColor),
    skinTone,
    hairColor,
    topColor,
    bottomColor,
    shoesColor,
  }

  const [faceTextureUrl, bodyTextureUrl] = await Promise.all([
    createPs2FaceTexture(faceImage),
    createPs2BodyTexture(bodyImage),
  ])

  return {
    analysis,
    config: {
      bodyId: analysis.bodyId,
      headId: analysis.headId,
      skinTone: analysis.skinTone,
      hairStyle: analysis.hairStyle,
      hairColor: analysis.hairColor,
      topStyle: analysis.topStyle,
      topColor: analysis.topColor,
      bottomStyle: analysis.bottomStyle,
      bottomColor: analysis.bottomColor,
      shoesStyle: analysis.shoesStyle,
      shoesColor: analysis.shoesColor,
      accessory: null,
      mood: analysis.mood,
      faceTextureUrl,
      modelUrl: null,
      rpmGlbUrl: null,
      bodyTextureUrl,
    },
  }
}

export function compressCameraPhoto(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/jpeg', 0.82)
}

export async function normalizeFullBodyPhoto(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl)
  const source = imageToCanvas(image, 900)
  const subjectBounds = detectSubjectBounds(source)
  const crop = subjectBounds
    ? expandBounds(subjectBounds, source.width, source.height, 0.24, BODY_OUTPUT_RATIO)
    : fitCenterCrop(source.width, source.height, BODY_OUTPUT_RATIO)

  return renderCrop(source, crop, 768, 1024, 'image/jpeg', 0.82)
}

export async function normalizeFacePhoto(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl)
  const source = imageToCanvas(image, 900)
  const faceBounds = await detectFaceBounds(source)
  const crop = faceBounds
    ? expandBounds(faceBounds, source.width, source.height, 0.62, FACE_OUTPUT_RATIO)
    : fallbackFaceCrop(source)

  return renderCrop(source, crop, 512, 640, 'image/png')
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Не удалось прочитать фото'))
    image.src = dataUrl
  })
}

function imageToCanvas(image: HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

async function detectFaceBounds(canvas: HTMLCanvasElement): Promise<PixelBounds | null> {
  const Detector = (window as WindowWithFaceDetector).FaceDetector
  if (!Detector) return null

  try {
    const detector = new Detector({ fastMode: true, maxDetectedFaces: 1 })
    const faces = await detector.detect(canvas)
    const face = faces[0]?.boundingBox
    if (!face || face.width < 24 || face.height < 24) return null
    return {
      minX: face.x,
      minY: face.y,
      maxX: face.x + face.width,
      maxY: face.y + face.height,
    }
  } catch {
    return null
  }
}

function fallbackFaceCrop(canvas: HTMLCanvasElement): Rect {
  const subject = detectSubjectBounds(canvas)
  if (!subject) return fitCenterCrop(canvas.width, canvas.height, FACE_OUTPUT_RATIO)

  const subjectWidth = subject.maxX - subject.minX
  const subjectHeight = subject.maxY - subject.minY
  const faceGuess: PixelBounds = {
    minX: subject.minX + subjectWidth * 0.18,
    maxX: subject.maxX - subjectWidth * 0.18,
    minY: subject.minY,
    maxY: subject.minY + subjectHeight * 0.42,
  }

  return expandBounds(faceGuess, canvas.width, canvas.height, 0.55, FACE_OUTPUT_RATIO)
}

function detectSubjectBounds(canvas: HTMLCanvasElement): PixelBounds | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  const width = canvas.width
  const height = canvas.height
  const data = ctx.getImageData(0, 0, width, height).data
  const background = estimateBorderColor(data, width, height)
  const step = Math.max(1, Math.floor(Math.max(width, height) / 220))
  let bounds: PixelBounds = { minX: width, minY: height, maxX: 0, maxY: 0 }
  let count = 0

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4
      const color = { r: data[index], g: data[index + 1], b: data[index + 2] }
      if (!isLikelyForeground(color, background)) continue
      bounds.minX = Math.min(bounds.minX, x)
      bounds.minY = Math.min(bounds.minY, y)
      bounds.maxX = Math.max(bounds.maxX, x)
      bounds.maxY = Math.max(bounds.maxY, y)
      count += 1
    }
  }

  const minSamples = Math.max(18, Math.round((width * height) / (step * step) * 0.012))
  if (count < minSamples || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return null

  return bounds
}

function estimateBorderColor(data: Uint8ClampedArray, width: number, height: number): RGB {
  const samples: RGB[] = []
  const step = Math.max(1, Math.floor(Math.max(width, height) / 80))

  for (let x = 0; x < width; x += step) {
    samples.push(readPixel(data, width, x, 0))
    samples.push(readPixel(data, width, x, height - 1))
  }

  for (let y = 0; y < height; y += step) {
    samples.push(readPixel(data, width, 0, y))
    samples.push(readPixel(data, width, width - 1, y))
  }

  if (!samples.length) return { r: 128, g: 128, b: 128 }
  samples.sort((a, b) => luminance(a) - luminance(b))
  const mid = Math.floor(samples.length / 2)
  const range = samples.slice(Math.max(0, mid - 8), Math.min(samples.length, mid + 9))
  const sum = range.reduce((acc, color) => ({
    r: acc.r + color.r,
    g: acc.g + color.g,
    b: acc.b + color.b,
  }), { r: 0, g: 0, b: 0 })

  return {
    r: Math.round(sum.r / range.length),
    g: Math.round(sum.g / range.length),
    b: Math.round(sum.b / range.length),
  }
}

function readPixel(data: Uint8ClampedArray, width: number, x: number, y: number): RGB {
  const index = (y * width + x) * 4
  return { r: data[index], g: data[index + 1], b: data[index + 2] }
}

function isLikelyForeground(color: RGB, background: RGB): boolean {
  const distance = colorDistance(color, background)
  const colorSat = saturation(color)
  const backgroundSat = saturation(background)
  const lumGap = Math.abs(luminance(color) - luminance(background))
  const hasHumanTone = color.r > color.b + 10 && color.r > 55 && color.g > 35 && color.b > 22
  return distance > 38 || (lumGap > 28 && colorSat > 0.08) || (hasHumanTone && backgroundSat < 0.2)
}

function expandBounds(
  bounds: PixelBounds,
  sourceWidth: number,
  sourceHeight: number,
  padding: number,
  targetRatio: number,
): Rect {
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  let cropWidth = Math.max(32, (bounds.maxX - bounds.minX) * (1 + padding))
  let cropHeight = Math.max(32, (bounds.maxY - bounds.minY) * (1 + padding))
  const currentRatio = cropWidth / cropHeight

  if (currentRatio > targetRatio) cropHeight = cropWidth / targetRatio
  else cropWidth = cropHeight * targetRatio

  let x = centerX - cropWidth / 2
  let y = centerY - cropHeight / 2
  x = Math.max(0, Math.min(sourceWidth - cropWidth, x))
  y = Math.max(0, Math.min(sourceHeight - cropHeight, y))

  cropWidth = Math.min(cropWidth, sourceWidth)
  cropHeight = Math.min(cropHeight, sourceHeight)

  return {
    x: x / sourceWidth,
    y: y / sourceHeight,
    w: cropWidth / sourceWidth,
    h: cropHeight / sourceHeight,
  }
}

function fitCenterCrop(sourceWidth: number, sourceHeight: number, targetRatio: number): Rect {
  const sourceRatio = sourceWidth / Math.max(1, sourceHeight)
  let width = sourceWidth
  let height = sourceHeight
  if (sourceRatio > targetRatio) width = sourceHeight * targetRatio
  else height = sourceWidth / targetRatio

  return {
    x: (sourceWidth - width) / 2 / sourceWidth,
    y: (sourceHeight - height) / 2 / sourceHeight,
    w: width / sourceWidth,
    h: height / sourceHeight,
  }
}

function renderCrop(
  source: HTMLCanvasElement,
  crop: Rect,
  width: number,
  height: number,
  type: 'image/jpeg' | 'image/png',
  quality?: number,
): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return source.toDataURL(type, quality)
  ctx.drawImage(
    source,
    crop.x * source.width,
    crop.y * source.height,
    crop.w * source.width,
    crop.h * source.height,
    0,
    0,
    width,
    height,
  )
  return canvas.toDataURL(type, quality)
}

function sampleDominantColor(
  image: HTMLImageElement,
  rect: Rect,
  options: {
    fallback: RGB
    avoidColor?: RGB
    preferDark?: boolean
    preferSkin?: boolean
  },
): RGB {
  const canvas = document.createElement('canvas')
  canvas.width = 36
  canvas.height = 36
  const ctx = canvas.getContext('2d')
  if (!ctx) return options.fallback

  ctx.drawImage(
    image,
    image.width * rect.x,
    image.height * rect.y,
    image.width * rect.w,
    image.height * rect.h,
    0,
    0,
    canvas.width,
    canvas.height,
  )

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const buckets = new Map<string, { color: RGB; count: number }>()
  let avg = { r: 0, g: 0, b: 0 }
  let avgCount = 0

  for (let i = 0; i < data.length; i += 4) {
    const color = { r: data[i], g: data[i + 1], b: data[i + 2] }
    const lum = luminance(color)
    const sat = saturation(color)

    if (lum < 12 || lum > 244) continue
    if (options.avoidColor && colorDistance(color, options.avoidColor) < 42) continue
    if (options.preferDark && lum > 150) continue
    if (options.preferSkin && (sat < 0.08 || color.b > color.r || color.g > color.r + 38)) continue

    avg.r += color.r
    avg.g += color.g
    avg.b += color.b
    avgCount += 1

    const weight = options.preferDark ? Math.max(1, 190 - lum) : Math.max(1, Math.round(sat * 60))
    const key = `${Math.round(color.r / 28)}-${Math.round(color.g / 28)}-${Math.round(color.b / 28)}`
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.count += weight
      bucket.color.r += color.r * weight
      bucket.color.g += color.g * weight
      bucket.color.b += color.b * weight
    } else {
      buckets.set(key, {
        color: { r: color.r * weight, g: color.g * weight, b: color.b * weight },
        count: weight,
      })
    }
  }

  let best: { color: RGB; count: number } | undefined
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket
  }

  if (best && best.count > 0) {
    return {
      r: Math.round(best.color.r / best.count),
      g: Math.round(best.color.g / best.count),
      b: Math.round(best.color.b / best.count),
    }
  }

  if (avgCount > 0) {
    return {
      r: Math.round(avg.r / avgCount),
      g: Math.round(avg.g / avgCount),
      b: Math.round(avg.b / avgCount),
    }
  }

  return options.fallback
}

function estimateQuality(bodyImage: HTMLImageElement, faceImage: HTMLImageElement): number {
  const bodyScore = Math.min(1, Math.min(bodyImage.width, bodyImage.height) / 720)
  const faceScore = Math.min(1, Math.min(faceImage.width, faceImage.height) / 240)
  const faceLight = normalizedLightScore(faceImage, FACE_SKIN_ZONE)
  const bodyLight = normalizedLightScore(bodyImage, BODY_ZONES.top)
  return clamp01(bodyScore * 0.25 + faceScore * 0.25 + faceLight * 0.3 + bodyLight * 0.2)
}

function normalizedLightScore(image: HTMLImageElement, rect: Rect): number {
  const color = sampleDominantColor(image, rect, { fallback: { r: 120, g: 120, b: 120 } })
  const lum = luminance(color)
  const distanceFromMiddle = Math.abs(lum - 128) / 128
  return clamp01(1 - distanceFromMiddle)
}

function estimateBodyId(image: HTMLImageElement, topColor: string, bottomColor: string): string {
  const aspect = image.height / Math.max(1, image.width)
  const topLum = luminance(hexToRgb(topColor))
  const bottomLum = luminance(hexToRgb(bottomColor))
  if (aspect > 1.55) return 'body_04'
  if (aspect < 1.05) return 'body_05'
  if ((topLum + bottomLum) / 2 > 145) return 'body_02'
  if ((topLum + bottomLum) / 2 < 58) return 'body_03'
  return 'body_01'
}

function estimateHeadId(faceImage: HTMLImageElement): string {
  const aspect = faceImage.width / Math.max(1, faceImage.height)
  if (aspect > 0.68) return 'head_02'
  if (aspect < 0.48) return 'head_03'
  return 'head_01'
}

function estimateHairStyle(faceImage: HTMLImageElement, skinRgb: RGB): string {
  const topCoverage = colorCoverage(faceImage, FACE_HAIR_ZONE, (color) => {
    return luminance(color) < 145 && colorDistance(color, skinRgb) > 55
  })
  const sideCoverage = colorCoverage(faceImage, FACE_SIDE_HAIR_ZONE, (color) => {
    return luminance(color) < 145 && colorDistance(color, skinRgb) > 60
  })

  if (topCoverage < 0.08) return 'bald'
  if (sideCoverage > 0.34) return 'long_01'
  if (topCoverage > 0.26) return 'medium_01'
  return 'short_01'
}

function estimateTopStyle(topColor: string, bottomColor: string): string {
  const top = hexToRgb(topColor)
  const bottom = hexToRgb(bottomColor)
  const contrast = colorDistance(top, bottom)
  if (luminance(top) < 52 && contrast > 45) return 'jacket'
  if (saturation(top) < 0.12 && luminance(top) > 135) return 'shirt'
  if (luminance(top) < 88) return 'hoodie'
  return 'tshirt'
}

function estimateBottomStyle(bottomColor: string, skinTone: string): string {
  const bottom = hexToRgb(bottomColor)
  const skin = hexToRgb(skinTone)
  const hue = rgbToHsl(bottom).h
  if (colorDistance(bottom, skin) < 54) return 'shorts'
  if (hue > 190 && hue < 250 && saturation(bottom) > 0.18) return 'jeans'
  if (luminance(bottom) < 72) return 'cargo'
  return 'trousers'
}

function estimateShoesStyle(shoesColor: string): string {
  const shoes = hexToRgb(shoesColor)
  if (luminance(shoes) < 55) return 'boots'
  return 'sneakers'
}

function estimateMood(topColor: string, bottomColor: string): AvatarConfig['mood'] {
  const top = hexToRgb(topColor)
  const bottom = hexToRgb(bottomColor)
  const sat = (saturation(top) + saturation(bottom)) / 2
  const lum = (luminance(top) + luminance(bottom)) / 2
  if (sat > 0.45 && lum > 110) return 'hyper'
  if (lum < 58) return 'stoic'
  if (sat < 0.12) return 'tired'
  return 'chill'
}

function colorCoverage(
  image: HTMLImageElement,
  rect: Rect,
  predicate: (color: RGB) => boolean,
): number {
  const canvas = document.createElement('canvas')
  canvas.width = 28
  canvas.height = 28
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0
  ctx.drawImage(
    image,
    image.width * rect.x,
    image.height * rect.y,
    image.width * rect.w,
    image.height * rect.h,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let match = 0
  let total = 0
  for (let i = 0; i < data.length; i += 4) {
    const color = { r: data[i], g: data[i + 1], b: data[i + 2] }
    if (luminance(color) > 8 && luminance(color) < 248) {
      total += 1
      if (predicate(color)) match += 1
    }
  }
  return total ? match / total : 0
}

function createPs2FaceTexture(faceImage: HTMLImageElement): string {
  const size = 256
  const low = document.createElement('canvas')
  low.width = 96
  low.height = 120
  const lowCtx = low.getContext('2d')
  if (!lowCtx) return ''
  const faceCrop = fitCenterCrop(faceImage.width, faceImage.height, 4 / 5)
  lowCtx.drawImage(
    faceImage,
    faceCrop.x * faceImage.width,
    faceCrop.y * faceImage.height,
    faceCrop.w * faceImage.width,
    faceCrop.h * faceImage.height,
    0,
    0,
    low.width,
    low.height,
  )
  posterizeCanvas(low, 7)

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false

  const skin = sampleDominantColor(faceImage, FACE_SKIN_ZONE, {
    preferSkin: true,
    fallback: { r: 200, g: 149, b: 108 },
  })
  const hair = sampleDominantColor(faceImage, FACE_HAIR_ZONE, {
    preferDark: true,
    avoidColor: skin,
    fallback: { r: 26, g: 16, b: 8 },
  })

  ctx.fillStyle = colorToHex(skin)
  ctx.fillRect(0, 0, size, size)

  const skinShade = ctx.createLinearGradient(0, 0, 0, size)
  skinShade.addColorStop(0, colorToHex(lightenRgb(skin, 1.08)))
  skinShade.addColorStop(0.58, colorToHex(skin))
  skinShade.addColorStop(1, colorToHex(lightenRgb(skin, 0.68)))
  ctx.fillStyle = skinShade
  ctx.fillRect(0, 0, size, size)

  ctx.fillStyle = colorToHex(hair)
  ctx.fillRect(0, 0, size, 58)
  ctx.fillRect(176, 28, 80, 178)

  drawFacePatch(ctx, low, 64, 40)
  drawFacePatch(ctx, low, 192, 40)

  ctx.globalCompositeOperation = 'multiply'
  const shade = ctx.createLinearGradient(0, 0, size, size)
  shade.addColorStop(0, 'rgba(255,255,255,0.92)')
  shade.addColorStop(0.78, 'rgba(145,120,145,0.78)')
  shade.addColorStop(1, 'rgba(70,55,90,0.68)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'source-over'
  addDither(ctx, size, 0.08)

  return canvas.toDataURL('image/png')
}

function drawFacePatch(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  centerX: number,
  topY: number,
): void {
  ctx.save()
  ctx.beginPath()
  ctx.ellipse(centerX, topY + 72, 42, 62, 0, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(source, centerX - 48, topY, 96, 120)
  ctx.restore()
}

function createPs2BodyTexture(bodyImage: HTMLImageElement): string {
  const width = 256
  const height = Math.max(320, Math.round(width * bodyImage.height / Math.max(1, bodyImage.width)))

  const low = document.createElement('canvas')
  low.width = 96
  low.height = Math.max(120, Math.round(96 * bodyImage.height / Math.max(1, bodyImage.width)))
  const lowCtx = low.getContext('2d')
  if (!lowCtx) return ''
  lowCtx.drawImage(bodyImage, 0, 0, low.width, low.height)
  posterizeCanvas(low, 8)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(low, 0, 0, width, height)

  ctx.globalCompositeOperation = 'multiply'
  const shade = ctx.createLinearGradient(0, 0, 0, height)
  shade.addColorStop(0, 'rgba(255,255,255,0.98)')
  shade.addColorStop(0.46, 'rgba(210,200,230,0.9)')
  shade.addColorStop(1, 'rgba(115,105,150,0.72)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'source-over'
  addDither(ctx, width, 0.055, height)

  return canvas.toDataURL('image/jpeg', 0.58)
}

function posterizeCanvas(canvas: HTMLCanvasElement, levels: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const step = 255 / Math.max(2, levels - 1)
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = Math.round(image.data[i] / step) * step
    image.data[i + 1] = Math.round(image.data[i + 1] / step) * step
    image.data[i + 2] = Math.round(image.data[i + 2] / step) * step
  }
  ctx.putImageData(image, 0, 0)
}

function addDither(
  ctx: CanvasRenderingContext2D,
  width: number,
  opacity: number,
  height = width,
): void {
  ctx.fillStyle = `rgba(0,0,0,${opacity})`
  for (let y = 0; y < height; y += 4) {
    for (let x = (y / 4) % 2 === 0 ? 0 : 2; x < width; x += 4) {
      ctx.fillRect(x, y, 1, 1)
    }
  }
}

function colorToHex(color: RGB): string {
  return `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`
}

function lightenRgb(color: RGB, amount: number): RGB {
  return {
    r: Math.max(0, Math.min(255, Math.round(color.r * amount))),
    g: Math.max(0, Math.min(255, Math.round(color.g * amount))),
    b: Math.max(0, Math.min(255, Math.round(color.b * amount))),
  }
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

function hexToRgb(hex: string): RGB {
  const parsed = parseInt(hex.replace('#', ''), 16)
  if (Number.isNaN(parsed)) return { r: 0, g: 0, b: 0 }
  return {
    r: (parsed >> 16) & 255,
    g: (parsed >> 8) & 255,
    b: parsed & 255,
  }
}

function luminance(color: RGB): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722
}

function saturation(color: RGB): number {
  return rgbToHsl(color).s
}

function rgbToHsl(color: RGB): { h: number; s: number; l: number } {
  const r = color.r / 255
  const g = color.g / 255
  const b = color.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) return { h: 0, s: 0, l }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return { h, s, l }
}

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
