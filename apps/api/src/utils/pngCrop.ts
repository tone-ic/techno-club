import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = makeCrcTable()
type AnyBuffer = Buffer<ArrayBufferLike>

interface PngChunk {
  type: string
  data: AnyBuffer
}

interface PngImage {
  width: number
  height: number
  bitDepth: number
  colorType: number
  chunks: PngChunk[]
  pixels: AnyBuffer
  bytesPerPixel: number
}

export function splitPngIntoVerticalThirds(source: AnyBuffer): AnyBuffer[] {
  const image = decodePng(source)
  if (image.width < 3) throw new Error('KIE PNG result is too narrow to split into 3 views')

  const firstWidth = Math.floor(image.width / 3)
  const secondWidth = Math.floor(image.width / 3)
  const thirdWidth = image.width - firstWidth - secondWidth
  const widths = [firstWidth, secondWidth, thirdWidth]
  let offsetX = 0

  return widths.map((width) => {
    const crop = findViewCrop(image, offsetX, width)
    const cropped = cropPixels(image, crop.x, crop.width)
    offsetX += width
    return encodePng({
      ...image,
      width: crop.width,
      pixels: cropped,
    })
  })
}

function decodePng(source: AnyBuffer): PngImage {
  if (!source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('KIE result is not a PNG image')
  }

  const chunks = readChunks(source)
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')
  if (!ihdr || ihdr.data.length !== 13) throw new Error('PNG missing IHDR chunk')

  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const compression = ihdr.data[10]
  const filter = ihdr.data[11]
  const interlace = ihdr.data[12]

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`)
  if (compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error('Unsupported PNG compression, filter, or interlace method')
  }

  const bytesPerPixel = getBytesPerPixel(colorType)
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data))
  const inflated = inflateSync(idat)
  const stride = width * bytesPerPixel
  const expected = (stride + 1) * height
  if (inflated.length < expected) throw new Error('PNG image data is truncated')

  const pixels = Buffer.alloc(stride * height)
  let inputOffset = 0
  let outputOffset = 0
  let previous: AnyBuffer = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[inputOffset]
    inputOffset += 1
    const raw = inflated.subarray(inputOffset, inputOffset + stride)
    inputOffset += stride
    const row = unfilterRow(filterType, raw, previous, bytesPerPixel)
    row.copy(pixels, outputOffset)
    previous = row
    outputOffset += stride
  }

  return { width, height, bitDepth, colorType, chunks, pixels, bytesPerPixel }
}

function encodePng(image: PngImage): AnyBuffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(image.width, 0)
  ihdr.writeUInt32BE(image.height, 4)
  ihdr[8] = image.bitDepth
  ihdr[9] = image.colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = image.width * image.bytesPerPixel
  const scanlines = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) {
    const sourceOffset = y * stride
    const targetOffset = y * (stride + 1)
    scanlines[targetOffset] = 0
    image.pixels.copy(scanlines, targetOffset + 1, sourceOffset, sourceOffset + stride)
  }

  const preservedChunks = image.chunks.filter((chunk) => (
    chunk.type !== 'IHDR' &&
    chunk.type !== 'IDAT' &&
    chunk.type !== 'IEND' &&
    chunk.type !== 'oFFs' &&
    chunk.type !== 'acTL' &&
    chunk.type !== 'fcTL' &&
    chunk.type !== 'fdAT'
  ))

  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    ...preservedChunks.map((chunk) => writeChunk(chunk.type, chunk.data)),
    writeChunk('IDAT', deflateSync(scanlines)),
    writeChunk('IEND', Buffer.alloc(0)),
  ])
}

function cropPixels(image: PngImage, x: number, width: number): AnyBuffer {
  const sourceStride = image.width * image.bytesPerPixel
  const targetStride = width * image.bytesPerPixel
  const cropped = Buffer.alloc(targetStride * image.height)

  for (let y = 0; y < image.height; y += 1) {
    const sourceOffset = y * sourceStride + x * image.bytesPerPixel
    const targetOffset = y * targetStride
    image.pixels.copy(cropped, targetOffset, sourceOffset, sourceOffset + targetStride)
  }

  return cropped
}

function findViewCrop(image: PngImage, x: number, width: number): { x: number; width: number } {
  const overlap = Math.max(4, Math.round(width * 0.16))
  const searchStart = Math.max(0, x - overlap)
  const searchEnd = Math.min(image.width, x + width + overlap)
  const subject = findSubjectBoundsX(image, searchStart, searchEnd, x, width)
  if (!subject) return { x, width }

  const pad = Math.max(6, Math.round(width * 0.075))
  const subjectWidth = subject.maxX - subject.minX + 1
  const cropWidth = Math.min(
    searchEnd - searchStart,
    Math.max(width, subjectWidth + pad * 2),
  )
  const subjectCenter = (subject.minX + subject.maxX) / 2
  const minCropX = Math.max(0, searchStart)
  const maxCropX = Math.min(image.width - cropWidth, searchEnd - cropWidth)
  const cropX = clampInt(Math.round(subjectCenter - cropWidth / 2), minCropX, Math.max(minCropX, maxCropX))
  return { x: cropX, width: cropWidth }
}

function findSubjectBoundsX(
  image: PngImage,
  startX: number,
  endX: number,
  nominalX: number,
  nominalWidth: number,
): { minX: number; maxX: number } | null {
  const columnThreshold = Math.max(2, Math.floor(image.height * 0.003))
  const activeColumns: boolean[] = []
  for (let x = startX; x < endX; x += 1) {
    activeColumns.push(countForegroundPixelsInColumn(image, x) >= columnThreshold)
  }

  const maxGap = Math.max(2, Math.round(nominalWidth * 0.012))
  let gapStart = -1
  for (let i = 0; i <= activeColumns.length; i += 1) {
    if (activeColumns[i]) {
      if (gapStart >= 0 && i - gapStart <= maxGap) {
        for (let j = gapStart; j < i; j += 1) activeColumns[j] = true
      }
      gapStart = -1
    } else if (gapStart < 0) {
      gapStart = i
    }
  }

  const nominalCenter = nominalX + nominalWidth / 2
  let best: { minX: number; maxX: number; score: number } | null = null
  let runStart = -1
  for (let i = 0; i <= activeColumns.length; i += 1) {
    if (activeColumns[i]) {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart < 0) continue

    const minX = startX + runStart
    const maxX = startX + i - 1
    const overlap = Math.max(0, Math.min(maxX, nominalX + nominalWidth) - Math.max(minX, nominalX))
    const center = (minX + maxX) / 2
    const distancePenalty = Math.abs(center - nominalCenter) / Math.max(1, nominalWidth)
    const score = overlap + (maxX - minX) * 0.04 - distancePenalty * nominalWidth * 0.2
    if (!best || score > best.score) best = { minX, maxX, score }
    runStart = -1
  }

  return best ? { minX: best.minX, maxX: best.maxX } : null
}

function countForegroundPixelsInColumn(image: PngImage, x: number): number {
  const stride = image.width * image.bytesPerPixel
  let count = 0
  for (let y = 0; y < image.height; y += 1) {
    const offset = y * stride + x * image.bytesPerPixel
    if (isForegroundPixel(image, offset)) count += 1
  }
  return count
}

function isForegroundPixel(image: PngImage, offset: number): boolean {
  const bpp = image.bytesPerPixel
  const colorType = image.colorType
  if (colorType === 6 && bpp >= 4 && image.pixels[offset + 3] <= 8) return false
  if (colorType === 4 && bpp >= 2 && image.pixels[offset + 1] <= 8) return false

  const r = image.pixels[offset] ?? 0
  const g = colorType === 0 || colorType === 4 ? r : image.pixels[offset + 1] ?? r
  const b = colorType === 0 || colorType === 4 ? r : image.pixels[offset + 2] ?? r
  return Math.max(r, g, b) > 18
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function readChunks(source: AnyBuffer): PngChunk[] {
  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length

  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset)
    const type = source.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > source.length) throw new Error('PNG chunk is truncated')
    chunks.push({ type, data: source.subarray(dataStart, dataEnd) })
    offset = dataEnd + 4
    if (type === 'IEND') break
  }

  return chunks
}

function getBytesPerPixel(colorType: number): number {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 3) return 1
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  throw new Error(`Unsupported PNG color type: ${colorType}`)
}

function unfilterRow(
  filterType: number,
  raw: AnyBuffer,
  previous: AnyBuffer,
  bytesPerPixel: number,
): AnyBuffer {
  const row = Buffer.alloc(raw.length)

  for (let i = 0; i < raw.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
    const up = previous[i] ?? 0
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0

    let value: number
    if (filterType === 0) value = raw[i]
    else if (filterType === 1) value = raw[i] + left
    else if (filterType === 2) value = raw[i] + up
    else if (filterType === 3) value = raw[i] + Math.floor((left + up) / 2)
    else if (filterType === 4) value = raw[i] + paeth(left, up, upLeft)
    else throw new Error(`Unsupported PNG filter type: ${filterType}`)

    row[i] = value & 0xff
  }

  return row
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upLeftDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
  if (upDistance <= upLeftDistance) return up
  return upLeft
}

function writeChunk(type: string, data: AnyBuffer): AnyBuffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBuffer.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return chunk
}

function crc32(buffer: AnyBuffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeCrcTable(): number[] {
  const table: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
}
