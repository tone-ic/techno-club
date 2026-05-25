import { spawn } from 'child_process'
import * as fs from 'fs'
import ffmpegStatic from 'ffmpeg-static'

export interface AudioBpmAnalysis {
  bpm: number | null
  confidence: number
  durationSec: number
  error?: string
}

const ANALYSIS_SAMPLE_RATE = 11_025
const ANALYSIS_START_SEC = 12
const ANALYSIS_DURATION_SEC = 120
const ANALYSIS_TIMEOUT_MS = 25_000
const ANALYSIS_MAX_BYTES = ANALYSIS_SAMPLE_RATE * ANALYSIS_DURATION_SEC * 2 + 8192
const BPM_MIN = 60
const BPM_MAX = 180
const BPM_BUCKETS = BPM_MAX - BPM_MIN + 1

export async function analyzeAudioBpm(fullPath: string): Promise<AudioBpmAnalysis> {
  const decoded = await decodeMonoPcm(fullPath)
  if (!decoded.pcm.length) {
    return {
      bpm: null,
      confidence: 0,
      durationSec: 0,
      error: decoded.error || 'empty decoded audio',
    }
  }

  return {
    ...estimateBpmFromPcm(decoded.pcm, ANALYSIS_SAMPLE_RATE),
    error: decoded.error,
  }
}

function ffmpegCommand() {
  const configured = process.env.FFMPEG_PATH || process.env.FFMPEG_BIN
  if (configured && fs.existsSync(configured)) return configured
  if (typeof ffmpegStatic === 'string' && ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic
  return 'ffmpeg'
}

function decodeMonoPcm(fullPath: string) {
  return new Promise<{ pcm: Buffer; error?: string }>((resolve) => {
    const command = ffmpegCommand()
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-ss', String(ANALYSIS_START_SEC),
      '-i', fullPath,
      '-vn',
      '-ac', '1',
      '-ar', String(ANALYSIS_SAMPLE_RATE),
      '-f', 's16le',
      '-t', String(ANALYSIS_DURATION_SEC),
      'pipe:1',
    ]
    const child = spawn(command, args, { windowsHide: true })
    const chunks: Buffer[] = []
    const stderr: Buffer[] = []
    let total = 0
    let settled = false
    let killedForLimit = false
    let killedForTimeout = false

    const finish = (pcm: Buffer, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ pcm, error })
    }

    const timeout = setTimeout(() => {
      killedForTimeout = true
      child.kill('SIGKILL')
    }, ANALYSIS_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      if (total >= ANALYSIS_MAX_BYTES) return
      const nextTotal = total + chunk.length
      if (nextTotal > ANALYSIS_MAX_BYTES) {
        chunks.push(chunk.subarray(0, ANALYSIS_MAX_BYTES - total))
        total = ANALYSIS_MAX_BYTES
        killedForLimit = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(chunk)
      total = nextTotal
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 4096) stderr.push(chunk)
    })

    child.on('error', (error) => {
      finish(Buffer.alloc(0), error.message)
    })

    child.on('close', (code) => {
      const pcm = Buffer.concat(chunks, total)
      const stderrText = Buffer.concat(stderr).toString('utf8').trim()
      if (pcm.length > ANALYSIS_SAMPLE_RATE * 8 * 2) {
        finish(pcm, killedForTimeout ? 'ffmpeg timeout; used partial audio' : killedForLimit ? 'audio analysis byte limit; used partial audio' : undefined)
        return
      }
      finish(
        pcm,
        code === 0
          ? undefined
          : stderrText || `ffmpeg exited with code ${code ?? 'unknown'}`,
      )
    })
  })
}

export function estimateBpmFromPcm(pcm: Buffer, sampleRate: number): Omit<AudioBpmAnalysis, 'error'> {
  const sampleCount = Math.floor(pcm.length / 2)
  const durationSec = sampleCount / sampleRate
  if (durationSec < 8) return { bpm: null, confidence: 0, durationSec }

  const hopSize = Math.max(128, Math.round(sampleRate * 0.0232))
  const frameSize = Math.max(hopSize * 2, Math.round(sampleRate * 0.0929))
  const frameCount = Math.max(0, Math.floor((sampleCount - frameSize) / hopSize))
  if (frameCount < 64) return { bpm: null, confidence: 0, durationSec }

  const energies = new Float64Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize
    let sumSquares = 0
    let peak = 0
    for (let i = 0; i < frameSize; i += 1) {
      const sample = pcm.readInt16LE((start + i) * 2) / 32768
      const abs = Math.abs(sample)
      sumSquares += sample * sample
      if (abs > peak) peak = abs
    }
    const rms = Math.sqrt(sumSquares / frameSize)
    energies[frame] = Math.log1p((rms * 0.82 + peak * 0.18) * 42)
  }

  const envelope = onsetEnvelope(energies)
  const histogram = new Float64Array(BPM_BUCKETS)
  addAutocorrelationScores(histogram, envelope, hopSize / sampleRate)
  addOnsetIntervalScores(histogram, envelope, hopSize / sampleRate)

  return pickTempo(histogram, durationSec)
}

function onsetEnvelope(energies: Float64Array) {
  const envelope = new Float64Array(energies.length)
  let slow = energies[0] || 0
  let fast = slow
  let previous = slow
  let mean = 0
  let meanSq = 0

  for (let i = 0; i < energies.length; i += 1) {
    const energy = energies[i]
    slow = slow * 0.992 + energy * 0.008
    fast = fast * 0.72 + energy * 0.28
    const localRise = Math.max(0, energy - previous)
    const contourRise = Math.max(0, fast - slow)
    const novelty = Math.pow(localRise * 1.8 + contourRise * 0.9, 0.78)
    envelope[i] = novelty
    mean += novelty
    meanSq += novelty * novelty
    previous = energy
  }

  mean /= Math.max(1, envelope.length)
  meanSq /= Math.max(1, envelope.length)
  const deviation = Math.sqrt(Math.max(0, meanSq - mean * mean))
  const floor = Math.max(0, mean + deviation * 0.12)
  let max = 0
  for (let i = 0; i < envelope.length; i += 1) {
    envelope[i] = Math.max(0, envelope[i] - floor * 0.42)
    if (envelope[i] > max) max = envelope[i]
  }
  if (max > 0) {
    for (let i = 0; i < envelope.length; i += 1) envelope[i] /= max
  }
  return envelope
}

function addAutocorrelationScores(histogram: Float64Array, envelope: Float64Array, hopSec: number) {
  for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm += 1) {
    const lag = Math.max(1, Math.round((60 / bpm) / hopSec))
    const score =
      normalizedCorrelation(envelope, lag) +
      normalizedCorrelation(envelope, lag * 2) * 0.48 +
      normalizedCorrelation(envelope, Math.max(1, Math.round(lag / 2))) * 0.18
    histogram[bpm - BPM_MIN] += score * tempoPrior(bpm) * 1.35
  }
}

function normalizedCorrelation(values: Float64Array, lag: number) {
  if (lag <= 0 || lag >= values.length) return 0
  let sum = 0
  let aSq = 0
  let bSq = 0
  for (let i = lag; i < values.length; i += 1) {
    const a = values[i]
    const b = values[i - lag]
    sum += a * b
    aSq += a * a
    bSq += b * b
  }
  const denom = Math.sqrt(aSq * bSq)
  return denom > 0 ? sum / denom : 0
}

function addOnsetIntervalScores(histogram: Float64Array, envelope: Float64Array, hopSec: number) {
  const peaks = pickOnsetPeaks(envelope, hopSec)
  if (peaks.length < 4) return

  for (let i = 0; i < peaks.length; i += 1) {
    for (let j = i + 1; j < peaks.length; j += 1) {
      const intervalSec = (peaks[j].frame - peaks[i].frame) * hopSec
      if (intervalSec > 3.2) break
      if (intervalSec < 0.24) continue
      const bpm = foldBpmToDanceRange(60 / intervalSec)
      if (!bpm) continue
      const ageWeight = 0.72 + 0.28 * (j / peaks.length)
      const intervalWeight = 1 - Math.min(0.42, intervalSec / 8)
      const score = Math.sqrt(peaks[i].strength * peaks[j].strength) * ageWeight * intervalWeight * tempoPrior(bpm)
      addBpmScore(histogram, bpm, score, 1.55)
    }
  }
}

function pickOnsetPeaks(envelope: Float64Array, hopSec: number) {
  let mean = 0
  let meanSq = 0
  for (const value of envelope) {
    mean += value
    meanSq += value * value
  }
  mean /= Math.max(1, envelope.length)
  meanSq /= Math.max(1, envelope.length)
  const deviation = Math.sqrt(Math.max(0, meanSq - mean * mean))
  const threshold = Math.max(0.08, mean + deviation * 0.45)
  const minGap = Math.max(1, Math.round(0.12 / hopSec))
  const peaks: Array<{ frame: number; strength: number }> = []
  let lastPeak = -Infinity

  for (let i = 1; i < envelope.length - 1; i += 1) {
    const value = envelope[i]
    if (value < threshold || value < envelope[i - 1] || value < envelope[i + 1]) continue
    if (i - lastPeak < minGap) {
      const previous = peaks[peaks.length - 1]
      if (previous && value > previous.strength) {
        previous.frame = i
        previous.strength = value
        lastPeak = i
      }
      continue
    }
    peaks.push({ frame: i, strength: value })
    lastPeak = i
  }

  return peaks
}

function addBpmScore(histogram: Float64Array, bpm: number, score: number, spread: number) {
  const center = bpm - BPM_MIN
  const min = Math.max(0, Math.floor(center - spread * 3))
  const max = Math.min(histogram.length - 1, Math.ceil(center + spread * 3))
  for (let idx = min; idx <= max; idx += 1) {
    const distance = idx - center
    histogram[idx] += score * Math.exp(-(distance * distance) / (2 * spread * spread))
  }
}

function foldBpmToDanceRange(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null
  let bpm = value
  while (bpm < 96 && bpm * 2 <= BPM_MAX) bpm *= 2
  while (bpm > BPM_MAX) bpm /= 2
  if (bpm < BPM_MIN || bpm > BPM_MAX) return null
  return bpm
}

function tempoPrior(bpm: number) {
  if (bpm >= 112 && bpm <= 156) return 1.16
  if (bpm >= 96 && bpm < 112) return 1.03
  if (bpm > 156 && bpm <= 168) return 0.98
  return 0.72
}

function pickTempo(histogram: Float64Array, durationSec: number): Omit<AudioBpmAnalysis, 'error'> {
  let bestIdx = -1
  let bestScore = 0
  let secondScore = 0
  let totalScore = 0

  for (let i = 0; i < histogram.length; i += 1) {
    const score = histogram[i]
    totalScore += score
    if (score > bestScore) {
      if (bestIdx < 0 || Math.abs(i - bestIdx) > 4) secondScore = bestScore
      bestScore = score
      bestIdx = i
    } else if (Math.abs(i - bestIdx) > 4 && score > secondScore) {
      secondScore = score
    }
  }

  if (bestIdx < 0 || bestScore <= 0 || totalScore <= 0) {
    return { bpm: null, confidence: 0, durationSec }
  }

  let weightedScore = 0
  let weightedBpm = 0
  for (let offset = -2; offset <= 2; offset += 1) {
    const idx = bestIdx + offset
    if (idx < 0 || idx >= histogram.length) continue
    const score = histogram[idx]
    if (score <= 0) continue
    weightedScore += score
    weightedBpm += (idx + BPM_MIN) * score
  }

  const bpm = weightedScore > 0 ? weightedBpm / weightedScore : bestIdx + BPM_MIN
  const support = bestScore / totalScore
  const dominance = bestScore / Math.max(secondScore, 0.0001)
  const confidence = clamp((support * 9.5) + Math.min(1, Math.max(0, dominance - 1) * 0.42), 0, 1)

  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence: Math.round(confidence * 1000) / 1000,
    durationSec,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
