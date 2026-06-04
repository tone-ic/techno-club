import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { RemoteAudioTrack, Room, RoomEvent } from 'livekit-client'
import { getLiveKitToken, LIVEKIT_DJ_ROOM } from '@/utils/livekit'
import { gameClient, type MusicServerState } from '@/utils/wsClient'
import { preferPlaybackAudioSession } from '@/utils/audioSession'
import { useAudioStore } from '@/store/audioStore'

const FALLBACK_TRACKS = [
  '/music/Deas%20-%20Drifted%20Off.mp3',
  '/music/Hertz%20-%20Maverick%20(Original%20Mix).mp3',
  '/music/Kr!Z%20-%20Inferno.mp3',
  '/music/Maraxe%20-%20Rattle.mp3',
  '/music/Maraxe%20-%20Serpent.mp3',
  '/music/Maraxe%2CK.E.N.Y.U.%20-%20Serpent%20-%20K.E.N.Y.U.%20Remix.mp3',
  '/music/Maraxe%2CWater%20Please%20-%20Serpent%20-%20Water%20Please%20Remix.mp3',
  '/music/PREMIERE_Deaf_Toucan_-_Almeidas_Loop_Ponky_Remix_ADT004.mp3',
  '/music/Rattlesnake_-_Rat.mp3',
  '/music/Sicion%20-%20Dancing%20Shadows.mp3',
  '/music/Transition%20-%20Friday%20At%20Patterns.mp3',
  '/music/Uncertain%20-%20Pride.mp3',
]
export const MUSIC_BPM_EVENT = 'music-bpm'
export const MUSIC_OUTPUT_EVENT = 'music-output'
export const MUSIC_SERVER_STATE_EVENT = 'music-server-state'
const VOICE_CAPTURE_AUDIO_STATE_EVENT = 'voice-capture-audio-state'
const MUSIC_MANIFEST_URL = '/music/manifest.json'
const MUSIC_MANIFEST_REFRESH_MS = 5_000
const MUSIC_FILE_EXTENSIONS = /\.(mp3|ogg|wav|m4a|aac|flac|webm)(\?.*)?$/i
const BPM_MIN = 60
const BPM_MAX = 180
const BPM_NORMALIZE_MIN = 96
const BPM_BUCKETS = BPM_MAX - BPM_MIN + 1
const BPM_WINDOW_SEC = 5.5
const BPM_UPDATE_INTERVAL_SEC = 2
const BPM_MIN_ONSET_GAP_SEC = 0.09
const BPM_PHASE_LOCK_RADIUS_SEC = 0.14
const BPM_DOTTED_RELATION_MIN = 84
const BPM_DOTTED_RELATION_MAX = 112
const BPM_DISPLAY_FALLBACK = 124

type FluxSample = {
  time: number
  value: number
}

type OnsetSample = {
  time: number
  strength: number
}

class LiveBpmEstimator {
  private readonly spectrum: Uint8Array<ArrayBuffer>
  private readonly previousSpectrum: Uint8Array<ArrayBuffer>
  private readonly envelope: FluxSample[] = []
  private readonly recentOnsets: OnsetSample[] = []
  private readonly histogram = new Float32Array(BPM_BUCKETS)
  private avgFlux = 0
  private avgFluxSq = 0
  private warmedSamples = 0
  private lastOnsetAt = 0
  private lastTempoUpdateAt = 0
  private pendingBpm: number | null = null
  private pendingSinceSec = 0
  beatIntervalSec: number | null = null
  lastBeatAtSec: number | null = null
  bpm: number | null = null
  reportedBpm: number | null = null
  confidence = 0
  rhythmIntensity = 0
  kickIntensity = 0
  onsetStrength = 0

  constructor(private readonly analyser: AnalyserNode) {
    this.spectrum = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    this.previousSpectrum = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
  }

  reset() {
    this.envelope.length = 0
    this.recentOnsets.length = 0
    this.histogram.fill(0)
    this.previousSpectrum.fill(0)
    this.avgFlux = 0
    this.avgFluxSq = 0
    this.warmedSamples = 0
    this.lastOnsetAt = 0
    this.lastTempoUpdateAt = 0
    this.pendingBpm = null
    this.pendingSinceSec = 0
    this.beatIntervalSec = null
    this.lastBeatAtSec = null
    this.bpm = null
    this.reportedBpm = null
    this.confidence = 0
    this.rhythmIntensity = 0
    this.kickIntensity = 0
    this.onsetStrength = 0
  }

  sample(nowSec: number) {
    this.analyser.getByteFrequencyData(this.spectrum)
    const nyquist = this.analyser.context.sampleRate / 2
    const hzPerBin = nyquist / this.spectrum.length
    let kickFlux = 0
    let bodyFlux = 0
    let rhythmFlux = 0
    let kickWeightTotal = 0
    let bodyWeightTotal = 0
    let rhythmWeightTotal = 0
    let lowEnergy = 0
    let lowEnergyWeight = 0
    let percussionEnergy = 0
    let percussionEnergyWeight = 0

    for (let i = 1; i < this.spectrum.length; i += 1) {
      const hz = i * hzPerBin
      if (hz < 32 || hz > 3600) {
        this.previousSpectrum[i] = this.spectrum[i]
        continue
      }
      const kickWeight = hz >= 44 && hz <= 185 ? 3.4 : 0
      const bodyWeight = hz > 185 && hz <= 720 ? (hz <= 420 ? 1.05 : 0.62) : 0
      const rhythmWeight = hz > 720 && hz <= 3600 ? (hz <= 1800 ? 0.72 : 0.42) : 0
      const value = this.spectrum[i] / 255
      const previous = this.previousSpectrum[i] / 255
      const rise = Math.max(0, value - previous)
      const compressedRise = Math.log1p(rise * (hz <= 720 ? 18 : 14))
      const fluxValue = compressedRise * compressedRise
      if (kickWeight > 0) {
        kickFlux += fluxValue * kickWeight
        kickWeightTotal += kickWeight
        lowEnergy += value * value
        lowEnergyWeight += 1
      }
      if (bodyWeight > 0) {
        bodyFlux += fluxValue * bodyWeight
        bodyWeightTotal += bodyWeight
      }
      if (rhythmWeight > 0) {
        rhythmFlux += fluxValue * rhythmWeight
        rhythmWeightTotal += rhythmWeight
      }
      if (bodyWeight > 0 || rhythmWeight > 0) {
        const weight = bodyWeight + rhythmWeight
        percussionEnergy += value * value * weight
        percussionEnergyWeight += weight
      }
      this.previousSpectrum[i] = this.spectrum[i]
    }

    const kickNorm = kickWeightTotal > 0 ? kickFlux / kickWeightTotal : 0
    const bodyNorm = bodyWeightTotal > 0 ? bodyFlux / bodyWeightTotal : 0
    const rhythmNorm = rhythmWeightTotal > 0 ? rhythmFlux / rhythmWeightTotal : 0
    const flux = kickNorm * 0.52 + bodyNorm * 0.2 + rhythmNorm * 0.28
    const bassEnergy = lowEnergyWeight > 0 ? lowEnergy / lowEnergyWeight : 0
    const percussiveEnergy = percussionEnergyWeight > 0 ? percussionEnergy / percussionEnergyWeight : 0

    this.warmedSamples += 1
    this.avgFlux = this.avgFlux * 0.95 + flux * 0.05
    this.avgFluxSq = this.avgFluxSq * 0.95 + flux * flux * 0.05
    const variance = Math.max(0, this.avgFluxSq - this.avgFlux * this.avgFlux)
    const deviation = Math.sqrt(variance)
    const threshold = Math.max(0.00006, this.avgFlux + deviation * 0.82)
    const novelty = Math.max(0, flux - threshold)
    const onsetStrength = Math.min(3.2, novelty / (deviation + this.avgFlux * 0.55 + 0.00008))
    const bassBoost = Math.min(0.72, bassEnergy * 7.5)
    const rhythmBoost = Math.min(0.38, (bodyNorm + rhythmNorm) * 3.8 + percussiveEnergy * 1.8)
    const weightedOnset = onsetStrength * (1 + bassBoost + rhythmBoost)
    const instantOnset = Math.min(1, weightedOnset / 2.3)
    const instantKick = Math.min(1, kickNorm * 4.8 + bassEnergy * 2.2 + instantOnset * 0.28)
    const instantRhythm = Math.min(1, instantOnset * 0.65 + bodyNorm * 2.4 + rhythmNorm * 2.0 + instantKick * 0.28)
    this.onsetStrength = Math.max(this.onsetStrength * 0.72, instantOnset)
    this.kickIntensity = Math.max(this.kickIntensity * 0.82, instantKick)
    this.rhythmIntensity = Math.max(this.rhythmIntensity * 0.82, instantRhythm)

    this.pushEnvelope(nowSec, weightedOnset)

    if (this.warmedSamples > 10 && weightedOnset > 0.46 && nowSec - this.lastOnsetAt > BPM_MIN_ONSET_GAP_SEC) {
      this.lastOnsetAt = nowSec
      this.recentOnsets.push({ time: nowSec, strength: weightedOnset })
    }

    while (this.recentOnsets.length && nowSec - this.recentOnsets[0].time > BPM_WINDOW_SEC) {
      this.recentOnsets.shift()
    }

    if (this.lastTempoUpdateAt === 0) this.lastTempoUpdateAt = nowSec
    if (nowSec - this.lastTempoUpdateAt >= BPM_UPDATE_INTERVAL_SEC) {
      this.lastTempoUpdateAt = nowSec
      this.updateTempo(nowSec)
    }
  }

  private pushEnvelope(time: number, value: number) {
    this.envelope.push({ time, value: Math.max(0, Math.min(3.2, value)) })
    while (this.envelope.length && time - this.envelope[0].time > BPM_WINDOW_SEC) {
      this.envelope.shift()
    }
  }

  private updateTempo(nowSec: number) {
    if (this.envelope.length < 24 || nowSec - this.envelope[0].time < 3.2) return
    this.histogram.fill(0)

    this.addEnvelopeTempoScores()
    this.addOnsetIntervalScores(nowSec)

    let bestIdx = -1
    let bestScore = 0
    let secondScore = 0
    let totalScore = 0
    for (let i = 0; i < this.histogram.length; i += 1) {
      const score = this.histogram[i]
      totalScore += score
      if (score > bestScore) {
        if (bestIdx < 0 || Math.abs(i - bestIdx) > 4) secondScore = bestScore
        bestScore = score
        bestIdx = i
      } else if (Math.abs(i - bestIdx) > 4 && score > secondScore) {
        secondScore = score
      }
    }
    if (bestIdx < 0 || bestScore < 0.08 || totalScore <= 0) return

    let localScore = 0
    let weightedBpm = 0
    for (let offset = -2; offset <= 2; offset += 1) {
      const score = this.histogram[bestIdx + offset] ?? 0
      if (score <= 0) continue
      localScore += score
      weightedBpm += (bestIdx + offset + BPM_MIN) * score
    }

    let candidate = localScore > 0 ? weightedBpm / localScore : bestIdx + BPM_MIN
    candidate = this.correctTempoOctave(candidate, bestScore)

    const dominance = bestScore / Math.max(secondScore, 0.0001)
    const support = bestScore / Math.max(totalScore, 0.0001)
    const dominanceScore = secondScore > 0 ? Math.min(1, Math.max(0, (dominance - 1) * 0.5)) : 0.45
    const supportScore = Math.min(1, support * 16)
    const confidence = Math.max(0, Math.min(1, supportScore * (0.38 + dominanceScore * 0.62)))
    this.confidence = confidence
    if (!this.bpm && confidence < 0.18) return
    if (this.bpm && confidence < 0.12) {
      this.updateBeatAnchor(nowSec)
      return
    }

    if (this.bpm) {
      const lockedCandidate = this.bestCandidateNear(this.bpm, 7)
      if (
        lockedCandidate &&
        lockedCandidate.score >= bestScore * 0.64 &&
        Math.abs(candidate - this.bpm) <= 1.1
      ) {
        candidate = lockedCandidate.bpm
        this.pendingBpm = null
        this.pendingSinceSec = 0
      } else if (Math.abs(candidate - this.bpm) > 11) {
        if (!this.pendingBpm || Math.abs(candidate - this.pendingBpm) > 3) {
          this.pendingBpm = candidate
          this.pendingSinceSec = nowSec
        }
        const pendingAge = nowSec - this.pendingSinceSec
        if (pendingAge < 2.8 || confidence < 0.44) {
          this.updateBeatAnchor(nowSec)
          return
        }
      }
    }

    if (!this.bpm) {
      this.bpm = candidate
    } else {
      const delta = Math.max(-1.4, Math.min(1.4, candidate - this.bpm))
      this.bpm += delta * 0.28
    }
    const snappedBpm = this.snapReportedBpm(this.bpm, confidence)
    if (!this.reportedBpm) {
      this.reportedBpm = snappedBpm
    } else {
      const reportDelta = Math.max(-0.9, Math.min(0.9, snappedBpm - this.reportedBpm))
      this.reportedBpm += reportDelta * 0.36
    }
    this.beatIntervalSec = 60 / this.bpm
    this.updateBeatAnchor(nowSec)
  }

  private addEnvelopeTempoScores() {
    if (this.envelope.length < 8) return
    const first = this.envelope[0]
    const last = this.envelope[this.envelope.length - 1]
    const sampleStep = (last.time - first.time) / Math.max(1, this.envelope.length - 1)
    if (!Number.isFinite(sampleStep) || sampleStep <= 0) return

    for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm += 1) {
      const lagSamples = Math.max(1, Math.round((60 / bpm) / sampleStep))
      if (lagSamples >= this.envelope.length) continue

      let score = 0
      let weight = 0
      for (let i = lagSamples; i < this.envelope.length; i += 1) {
        const current = this.envelope[i].value
        if (current <= 0) continue
        const halfBeat = this.envelope[i - Math.round(lagSamples * 0.5)]?.value ?? 0
        const oneBeat = this.envelope[i - lagSamples]?.value ?? 0
        const twoBeat = this.envelope[i - lagSamples * 2]?.value ?? 0
        const fourBeat = this.envelope[i - lagSamples * 4]?.value ?? 0
        const recency = 0.35 + 0.65 * (i / this.envelope.length)
        score += current * (oneBeat + halfBeat * 0.22 + twoBeat * 0.62 + fourBeat * 0.38) * recency
        weight += current * recency
      }

      if (weight <= 0) continue
      this.histogram[bpm - BPM_MIN] += (score / weight) * this.tempoPrior(bpm) * 1.38
    }
  }

  private addOnsetIntervalScores(nowSec: number) {
    if (this.recentOnsets.length < 4) return
    for (let i = 0; i < this.recentOnsets.length; i += 1) {
      for (let j = i + 1; j < this.recentOnsets.length; j += 1) {
        const interval = this.recentOnsets[j].time - this.recentOnsets[i].time
        if (interval < 0.13 || interval > 2.4) continue
        let bpm = 60 / interval
        while (bpm < BPM_NORMALIZE_MIN) bpm *= 2
        while (bpm > BPM_MAX) bpm /= 2
        if (bpm < BPM_MIN || bpm > BPM_MAX) continue

        const bucket = Math.round(bpm) - BPM_MIN
        const age = nowSec - this.recentOnsets[j].time
        const strength = Math.sqrt(this.recentOnsets[i].strength * this.recentOnsets[j].strength)
        const score = Math.exp(-age / 12) * strength * (1 - Math.min(0.52, interval / 4)) * this.tempoPrior(bpm)
        this.addHistogramScore(bucket, score)

        const dottedCandidate = this.dottedRelationCandidate(bpm)
        if (dottedCandidate) {
          this.addHistogramScore(Math.round(dottedCandidate) - BPM_MIN, score * 0.58)
        }
      }
    }
  }

  private tempoPrior(bpm: number) {
    if (bpm >= 112 && bpm <= 156) return 1.12
    if (bpm >= 96 && bpm < 112) return 1.02
    if (bpm > 156 && bpm <= 168) return 1.0
    return 0.86
  }

  private correctTempoOctave(candidate: number, bestScore: number) {
    if (candidate < 108) {
      const doubled = candidate * 2
      const doubledScore = this.scoreAtBpm(doubled)
      if (doubled <= BPM_MAX && doubledScore >= bestScore * 0.5) return doubled
    }
    const dottedCandidate = this.dottedRelationCandidate(candidate)
    if (dottedCandidate) {
      const dottedScore = this.scoreNearBpm(dottedCandidate)
      if (dottedScore >= bestScore * 0.34) return dottedCandidate
    }
    if (candidate > 168) {
      const halved = candidate / 2
      const halvedScore = this.scoreAtBpm(halved)
      if (halved >= BPM_MIN && halvedScore >= bestScore * 0.6) return halved
    }
    return candidate
  }

  private snapReportedBpm(bpm: number, confidence: number) {
    const nearestInteger = Math.round(bpm)
    if (confidence >= 0.5 && Math.abs(bpm - nearestInteger) <= 0.18) return nearestInteger
    const nearestHalf = Math.round(bpm * 2) / 2
    if (confidence >= 0.38 && Math.abs(bpm - nearestHalf) <= 0.16) return nearestHalf
    return bpm
  }

  private updateBeatAnchor(nowSec: number) {
    if (!this.bpm) return
    const interval = 60 / this.bpm
    this.beatIntervalSec = interval
    const lookbackSec = Math.max(2.4, interval * 6)
    let strongest: OnsetSample | null = null
    for (const onset of this.recentOnsets) {
      if (nowSec - onset.time > lookbackSec) continue
      if (!strongest || onset.strength > strongest.strength) strongest = onset
    }

    if (this.lastBeatAtSec === null) {
      if (strongest) this.lastBeatAtSec = strongest.time
      return
    }

    let expected = this.lastBeatAtSec + Math.round((nowSec - this.lastBeatAtSec) / interval) * interval
    if (expected > nowSec) expected -= interval

    let match: OnsetSample | null = null
    let matchScore = 0
    const radius = Math.min(BPM_PHASE_LOCK_RADIUS_SEC, interval * 0.26)
    for (const onset of this.recentOnsets) {
      const distance = Math.abs(onset.time - expected)
      if (distance > radius) continue
      const score = onset.strength * (1 - distance / radius)
      if (score > matchScore) {
        match = onset
        matchScore = score
      }
    }

    if (match) {
      const correction = Math.max(-0.08, Math.min(0.08, match.time - expected))
      this.lastBeatAtSec += correction * 0.42
    }

    while (this.lastBeatAtSec + interval <= nowSec) {
      this.lastBeatAtSec += interval
    }
  }

  private bestCandidateNear(centerBpm: number, radiusBpm: number) {
    const min = Math.max(BPM_MIN, Math.round(centerBpm - radiusBpm))
    const max = Math.min(BPM_MAX, Math.round(centerBpm + radiusBpm))
    let bestBpm = 0
    let bestScore = 0
    for (let bpm = min; bpm <= max; bpm += 1) {
      const score = this.histogram[bpm - BPM_MIN] ?? 0
      if (score > bestScore) {
        bestScore = score
        bestBpm = bpm
      }
    }
    return bestScore > 0 ? { bpm: bestBpm, score: bestScore } : null
  }

  private scoreAtBpm(bpm: number) {
    const idx = Math.round(bpm) - BPM_MIN
    if (idx < 0 || idx >= this.histogram.length) return 0
    return this.histogram[idx] ?? 0
  }

  private scoreNearBpm(bpm: number) {
    const center = Math.round(bpm) - BPM_MIN
    let score = 0
    for (let offset = -2; offset <= 2; offset += 1) {
      const idx = center + offset
      if (idx < 0 || idx >= this.histogram.length) continue
      score += (this.histogram[idx] ?? 0) / (1 + Math.abs(offset))
    }
    return score
  }

  private addHistogramScore(bucket: number, score: number) {
    for (let offset = -2; offset <= 2; offset += 1) {
      const idx = bucket + offset
      if (idx < 0 || idx >= this.histogram.length) continue
      this.histogram[idx] += score / (1 + Math.abs(offset))
    }
  }

  private dottedRelationCandidate(bpm: number) {
    if (bpm < BPM_DOTTED_RELATION_MIN || bpm >= BPM_DOTTED_RELATION_MAX) return null
    const candidate = bpm * 1.5
    return candidate <= BPM_MAX ? candidate : null
  }
}

// ── Синглтон ─────────────────────────────────────────────────────────────────
let _audio:   HTMLAudioElement | null            = null
let _ctx:     AudioContext | null                = null
let _gain:    GainNode | null                    = null
let _filter:  BiquadFilterNode | null            = null
let _doorEq: DoorEqGraph | null                  = null
let _source:  MediaElementAudioSourceNode | null = null
let _trackBpmAnalyser: AnalyserNode | null        = null
let _trackBpmEstimator: LiveBpmEstimator | null   = null
let _lockscreenAudio: HTMLAudioElement | null     = null
let _lockscreenOutput: MediaStreamAudioDestinationNode | null = null
let _bpmSilentSink: GainNode | null = null
let _tracks = FALLBACK_TRACKS
let _tracksSignature = FALLBACK_TRACKS.join('\n')
let _currentTrackIdx = -1   // отслеживаем загруженный трек
let _serverOffsetMs = 0
let _volume = 0.4
let _environment: 'club' | 'outside' = 'club'
let _outsideDoorProximity = 0
let _musicTimeline: { trackIdx: number; startedAt: number } | null = null
let _serverMusicState: MusicServerState | null = null
let _serverMusicStateReceivedAt = 0
let _freshResumeMusicStateRequestedAt = 0
let _freshResumeMusicStateWaitUntil = 0
let _bestTimeSyncRttMs = Number.POSITIVE_INFINITY
let _lockscreenActive = false
let _lockscreenSource: 'track' | 'dj' | null = null
let _lockscreenSwitching = false
let _mainAudioRestoring = false
let _mainTrackRoutePromise: Promise<boolean> | null = null
let _lastOutsideRouteEnsureAt = 0
let _mainSpeakerConnected = false
let _djSpeakerConnected = false
let _audioRouteActive = false
let _lastBroadcastTimeSyncAtMs = 0
const IS_IOS_AUDIO =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const IS_MOBILE_AUDIO =
  typeof navigator !== 'undefined' &&
  (/Android|iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const MUSIC_DEADBAND_SEC = IS_IOS_AUDIO ? 0.08 : 0.12
const MUSIC_START_SEEK_DRIFT_SEC = IS_IOS_AUDIO ? 0.3 : 0.45
const MUSIC_RATE_HORIZON_SEC = 6
const MUSIC_MAX_RATE_DELTA = IS_IOS_AUDIO ? 0 : 0.006
const MUSIC_SYNC_INTERVAL_MS = IS_IOS_AUDIO ? 1200 : 500
const BROADCAST_TIME_SYNC_MIN_INTERVAL_MS = 1_000
const BROADCAST_TIME_SYNC_MAX_STEP_MS = 120
const MUSIC_RESTORE_RETRY_DELAYS_MS = [0, 80, 250, 700, 1500, 3000, 6000] as const
const OUTSIDE_ROUTE_ENSURE_INTERVAL_MS = 900
const OUTSIDE_PROXIMITY_APPLY_EPSILON = 0.01
const OUTSIDE_BASE_GAIN = 0.14
const OUTSIDE_DOOR_GAIN = 0.38
const OUTSIDE_EQ = {
  subShelfHz: 48,
  subShelfDb: 7.2,
  bassPeakHz: 88,
  bassPeakQ: 0.9,
  bassPeakDb: 5.8,
  lowMidPeakHz: 145,
  lowMidPeakQ: 0.95,
  lowMidPeakDb: 1.8,
  lowPassMinHz: 235,
  lowPassMaxHz: 520,
  lowPassQ: 0.72,
  secondLowPassScale: 1.34,
  midCutHz: 520,
  midCutQ: 0.85,
  midCutDb: -13.5,
  highCutHz: 1900,
  highCutQ: 0.62,
  highCutDb: -12.5,
  treblePocketHz: 9200,
  treblePocketQ: 0.95,
  treblePocketDb: 4.5,
} as const
const BPM_ANALYSIS_INTERVAL_MS = 250
const BPM_BROADCAST_INTERVAL_MS = 1_000
const LIVE_BPM_MIN_CONFIDENCE = 0.12
const SERVER_MUSIC_STATE_STALE_MS = 3_500
const MUSIC_OUTPUT_OWNER_STORAGE_KEY = 'doorclub:music-output-owner'
const MUSIC_OUTPUT_OWNER_CHANNEL = 'doorclub:music-output-owner'
const MUSIC_OUTPUT_OWNER_TTL_MS = 7_000
const MUSIC_OUTPUT_OWNER_HEARTBEAT_MS = 2_000

type MusicOutputOwnerRecord = {
  ownerId: string
  expiresAt: number
}

let _djRoom: Room | null = null
let _djSource: MediaStreamAudioSourceNode | null = null
let _djGain: GainNode | null = null
let _djDoorEq: DoorEqGraph | null = null
let _djBpmAnalyser: AnalyserNode | null = null
let _djBpmEstimator: LiveBpmEstimator | null = null
let _djTrack: RemoteAudioTrack | null = null
let _djElement: HTMLAudioElement | null = null
let _djLockscreenElement: HTMLAudioElement | null = null
let _djMediaStreamTrack: MediaStreamTrack | null = null
let _djLockscreenOutput: MediaStreamAudioDestinationNode | null = null
let _djActive = false
let _djPlaybackBlocked = false
let _djPlaybackReady = false
const _musicOutputTabId = createMusicOutputTabId()
let _musicOutputOwnerId: string | null = null
let _musicOutputOwnerExpiresAt = 0
let _musicOutputOwnerChannel: BroadcastChannel | null = null
let _musicOutputOwnerHeartbeat: number | null = null
let _hiddenSuspendedWithoutLockscreenAccess = false
let _forceTimelineSeekAfterHiddenSuspend = false
let _forceTimelineSeekAfterOutputHandoff = false
let _forceTimelineSeekAfterVisibilityRestore = false
let _lastKnownBpm: number | null = null
let _screenWakeLock: { release: () => Promise<void>; addEventListener?: (type: string, listener: () => void) => void } | null = null
let _screenWakeLockWanted = false

function serverNow() {
  return Date.now() + _serverOffsetMs
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

type DoorEqGraph = {
  nodes: BiquadFilterNode[]
  subShelf: BiquadFilterNode
  bassPeak: BiquadFilterNode
  lowMidPeak: BiquadFilterNode
  lowPassA: BiquadFilterNode
  lowPassB: BiquadFilterNode
  midCut: BiquadFilterNode
  highCut: BiquadFilterNode
  treblePocket: BiquadFilterNode
}

function createDoorEqGraph(ctx: AudioContext): DoorEqGraph {
  const subShelf = ctx.createBiquadFilter()
  const bassPeak = ctx.createBiquadFilter()
  const lowMidPeak = ctx.createBiquadFilter()
  const lowPassA = ctx.createBiquadFilter()
  const lowPassB = ctx.createBiquadFilter()
  const midCut = ctx.createBiquadFilter()
  const highCut = ctx.createBiquadFilter()
  const treblePocket = ctx.createBiquadFilter()

  subShelf.type = 'lowshelf'
  bassPeak.type = 'peaking'
  lowMidPeak.type = 'peaking'
  lowPassA.type = 'lowpass'
  lowPassB.type = 'lowpass'
  midCut.type = 'peaking'
  highCut.type = 'peaking'
  treblePocket.type = 'peaking'

  subShelf.frequency.value = OUTSIDE_EQ.subShelfHz
  bassPeak.frequency.value = OUTSIDE_EQ.bassPeakHz
  bassPeak.Q.value = OUTSIDE_EQ.bassPeakQ
  lowMidPeak.frequency.value = OUTSIDE_EQ.lowMidPeakHz
  lowMidPeak.Q.value = OUTSIDE_EQ.lowMidPeakQ
  midCut.frequency.value = OUTSIDE_EQ.midCutHz
  midCut.Q.value = OUTSIDE_EQ.midCutQ
  highCut.frequency.value = OUTSIDE_EQ.highCutHz
  highCut.Q.value = OUTSIDE_EQ.highCutQ
  treblePocket.frequency.value = OUTSIDE_EQ.treblePocketHz
  treblePocket.Q.value = OUTSIDE_EQ.treblePocketQ

  const nodes = [subShelf, bassPeak, lowMidPeak, lowPassA, lowPassB, midCut, highCut, treblePocket]
  return { nodes, subShelf, bassPeak, lowMidPeak, lowPassA, lowPassB, midCut, highCut, treblePocket }
}

function connectNodeChain(nodes: AudioNode[], destination: AudioNode) {
  nodes.forEach((node, index) => {
    const next = nodes[index + 1] ?? destination
    node.connect(next)
  })
}

function connectMainSpeaker() {
  if (hasActiveExternalMusicOutputOwner()) return
  if (!_ctx || !_gain || _mainSpeakerConnected) return
  _gain.connect(_ctx.destination)
  _mainSpeakerConnected = true
}

function disconnectMainSpeaker() {
  if (!_ctx || !_gain || !_mainSpeakerConnected) return
  try {
    _gain.disconnect(_ctx.destination)
  } catch {
    return
  }
  _mainSpeakerConnected = false
}

function connectDjSpeaker() {
  if (hasActiveExternalMusicOutputOwner()) return
  if (!_ctx || !_djGain || _djSpeakerConnected) return
  _djGain.connect(_ctx.destination)
  _djSpeakerConnected = true
}

function disconnectDjSpeaker() {
  if (!_ctx || !_djGain || !_djSpeakerConnected) return
  try {
    _djGain.disconnect(_ctx.destination)
  } catch {
    return
  }
  _djSpeakerConnected = false
}

function createMusicOutputTabId() {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return randomId
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function parseMusicOutputOwnerRecord(value: unknown): MusicOutputOwnerRecord | null {
  try {
    const record = typeof value === 'string' ? JSON.parse(value) : value
    if (!record || typeof record !== 'object') return null
    const owner = record as Partial<MusicOutputOwnerRecord>
    if (typeof owner.ownerId !== 'string' || typeof owner.expiresAt !== 'number') return null
    if (!owner.ownerId || !Number.isFinite(owner.expiresAt)) return null
    return { ownerId: owner.ownerId, expiresAt: owner.expiresAt }
  } catch {
    return null
  }
}

function rememberMusicOutputOwner(record: MusicOutputOwnerRecord | null) {
  _musicOutputOwnerId = record?.ownerId ?? null
  _musicOutputOwnerExpiresAt = record?.expiresAt ?? 0
}

function readMusicOutputOwner() {
  if (typeof window === 'undefined') return null
  try {
    const record = parseMusicOutputOwnerRecord(window.localStorage.getItem(MUSIC_OUTPUT_OWNER_STORAGE_KEY))
    if (record) rememberMusicOutputOwner(record)
    return record ?? (_musicOutputOwnerId
      ? { ownerId: _musicOutputOwnerId, expiresAt: _musicOutputOwnerExpiresAt }
      : null)
  } catch {
    return _musicOutputOwnerId
      ? { ownerId: _musicOutputOwnerId, expiresAt: _musicOutputOwnerExpiresAt }
      : null
  }
}

function isFreshMusicOutputOwner(record: MusicOutputOwnerRecord | null) {
  return Boolean(record && record.expiresAt > Date.now())
}

function hasActiveExternalMusicOutputOwner() {
  const owner = readMusicOutputOwner()
  return Boolean(isFreshMusicOutputOwner(owner) && owner!.ownerId !== _musicOutputTabId)
}

function postMusicOutputOwner(record: MusicOutputOwnerRecord) {
  try {
    _musicOutputOwnerChannel?.postMessage(record)
  } catch {
    // Another tab will also observe localStorage when available.
  }
}

function writeMusicOutputOwner(record: MusicOutputOwnerRecord) {
  rememberMusicOutputOwner(record)
  try {
    window.localStorage.setItem(MUSIC_OUTPUT_OWNER_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // localStorage can be blocked; BroadcastChannel plus in-memory state still helps.
  }
  postMusicOutputOwner(record)
}

function stopMusicOutputOwnerHeartbeat() {
  if (_musicOutputOwnerHeartbeat === null || typeof window === 'undefined') return
  window.clearInterval(_musicOutputOwnerHeartbeat)
  _musicOutputOwnerHeartbeat = null
}

function startMusicOutputOwnerHeartbeat() {
  if (_musicOutputOwnerHeartbeat !== null || typeof window === 'undefined') return
  _musicOutputOwnerHeartbeat = window.setInterval(() => {
    const owner = readMusicOutputOwner()
    if (!_audioRouteActive || (isFreshMusicOutputOwner(owner) && owner!.ownerId !== _musicOutputTabId)) {
      stopMusicOutputOwnerHeartbeat()
      return
    }
    writeMusicOutputOwner({
      ownerId: _musicOutputTabId,
      expiresAt: Date.now() + MUSIC_OUTPUT_OWNER_TTL_MS,
    })
  }, MUSIC_OUTPUT_OWNER_HEARTBEAT_MS)
}

function takeMusicOutputOwnership() {
  if (typeof window === 'undefined') return true
  writeMusicOutputOwner({
    ownerId: _musicOutputTabId,
    expiresAt: Date.now() + MUSIC_OUTPUT_OWNER_TTL_MS,
  })
  startMusicOutputOwnerHeartbeat()
  return true
}

function ensureMusicOutputOwnership() {
  if (typeof window === 'undefined') return true
  if (hasActiveExternalMusicOutputOwner()) return false
  return takeMusicOutputOwnership()
}

function releaseMusicOutputOwnership() {
  if (typeof window === 'undefined') return
  const owner = readMusicOutputOwner()
  if (owner?.ownerId === _musicOutputTabId) {
    try {
      window.localStorage.removeItem(MUSIC_OUTPUT_OWNER_STORAGE_KEY)
    } catch {
      // Nothing else to release when localStorage is blocked.
    }
    postMusicOutputOwner({ ownerId: _musicOutputTabId, expiresAt: 0 })
    rememberMusicOutputOwner(null)
  }
  stopMusicOutputOwnerHeartbeat()
}

function getBpmSilentSink(ctx: AudioContext) {
  if (!_bpmSilentSink) {
    _bpmSilentSink = ctx.createGain()
    _bpmSilentSink.gain.value = 0
    _bpmSilentSink.connect(ctx.destination)
  }
  return _bpmSilentSink
}

function createBpmAnalyser(ctx: AudioContext) {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 4096
  analyser.smoothingTimeConstant = 0.08
  analyser.connect(getBpmSilentSink(ctx))
  return analyser
}

function rememberServerTimeSample(clientSentAt: number, syncServerNow: number, clientReceivedAt: number) {
  const roundTripMs = clientReceivedAt - clientSentAt
  if (roundTripMs < 0 || roundTripMs > 350) return

  const offsetMs = syncServerNow + roundTripMs / 2 - clientReceivedAt
  if (!Number.isFinite(offsetMs)) return

  if (!Number.isFinite(_bestTimeSyncRttMs)) {
    _bestTimeSyncRttMs = roundTripMs
    _serverOffsetMs = offsetMs
    return
  }

  if (roundTripMs <= _bestTimeSyncRttMs + 8) {
    _bestTimeSyncRttMs = Math.min(_bestTimeSyncRttMs, roundTripMs)
    _serverOffsetMs = _serverOffsetMs * 0.82 + offsetMs * 0.18
  } else {
    _serverOffsetMs = _serverOffsetMs * 0.96 + offsetMs * 0.04
  }
}

function rememberBroadcastServerTime(syncServerNow: number, clientReceivedAt: number) {
  if (!Number.isFinite(syncServerNow) || !Number.isFinite(clientReceivedAt)) return
  const estimatedOneWayMs = Number.isFinite(_bestTimeSyncRttMs) ? _bestTimeSyncRttMs / 2 : 0
  const offsetMs = syncServerNow + estimatedOneWayMs - clientReceivedAt
  if (!Number.isFinite(offsetMs)) return
  if (!Number.isFinite(_bestTimeSyncRttMs)) {
    _serverOffsetMs = offsetMs
    return
  }

  const now = Date.now()
  if (now - _lastBroadcastTimeSyncAtMs < BROADCAST_TIME_SYNC_MIN_INTERVAL_MS) return
  _lastBroadcastTimeSyncAtMs = now
  const deltaMs = clamp(offsetMs - _serverOffsetMs, -BROADCAST_TIME_SYNC_MAX_STEP_MS, BROADCAST_TIME_SYNC_MAX_STEP_MS)
  _serverOffsetMs += deltaMs * 0.08
}

function isServerMusicState(value: unknown): value is MusicServerState {
  const state = value as Partial<MusicServerState> | null
  return Boolean(
    state &&
    (state.source === undefined || state.source === 'track' || state.source === 'dj') &&
    typeof state.trackIdx === 'number' &&
    typeof state.trackCount === 'number' &&
    typeof state.startedAt === 'number' &&
    typeof state.serverNow === 'number' &&
    typeof state.bpm === 'number' &&
    typeof state.beatStartedAt === 'number' &&
    typeof state.beatIntervalMs === 'number' &&
    typeof state.intensity === 'number' &&
    typeof state.rhythmIntensity === 'number' &&
    typeof state.kickIntensity === 'number' &&
    typeof state.onsetStrength === 'number'
  )
}

function applyServerMusicState(value: unknown, syncServerNow?: number, syncClientReceivedAt = Date.now()) {
  if (!isServerMusicState(value)) return
  const bpm = clamp(value.bpm, BPM_MIN, BPM_MAX)
  if (!Number.isFinite(bpm) || value.beatIntervalMs <= 0) return
  const wasServerDjSource = shouldUseServerDjSource()

  rememberBroadcastServerTime(
    typeof syncServerNow === 'number' && Number.isFinite(syncServerNow) ? syncServerNow : value.serverNow,
    syncClientReceivedAt,
  )
  _serverMusicState = {
    ...value,
    source: value.source === 'dj' ? 'dj' : 'track',
    bpm,
    intensity: clamp(value.intensity, 0, 1),
    rhythmIntensity: clamp(value.rhythmIntensity, 0, 1),
    kickIntensity: clamp(value.kickIntensity, 0, 1),
    onsetStrength: clamp(value.onsetStrength, 0, 1),
  }
  _serverMusicStateReceivedAt = Date.now()
  if (_serverMusicState.source === 'dj') {
    suspendLocalTrackForDj()
    void startDjAudioElement()
  } else {
    syncTimelineFromAuthoritativeTrackState()
    if (wasServerDjSource) void resumeLocalTrackAfterDj()
  }
  dispatchMusicBpm()
  dispatchMusicOutput()
}

function currentAuthoritativeMusicState() {
  if (!_serverMusicState) return null
  if (Date.now() - _serverMusicStateReceivedAt > SERVER_MUSIC_STATE_STALE_MS) return null
  return _serverMusicState
}

function shouldUseServerDjSource() {
  return currentAuthoritativeMusicState()?.source === 'dj'
}

function currentServerMusicState() {
  const state = currentAuthoritativeMusicState()
  if (!state || state.source !== 'track') return null
  if (_currentTrackIdx >= 0 && state.trackIdx !== _currentTrackIdx) return null
  return state
}

function currentTrackTimelineState() {
  if (!_serverMusicState || _serverMusicState.source !== 'track') return null
  return _serverMusicState
}

function syncTimelineFromAuthoritativeTrackState(force = false) {
  const state = currentTrackTimelineState()
  if (!state) return false
  if (
    !force &&
    _musicTimeline &&
    _musicTimeline.trackIdx === state.trackIdx &&
    _musicTimeline.startedAt === state.startedAt
  ) {
    return false
  }
  applyMusicState(state.trackIdx, state.startedAt, state.serverNow, _serverMusicStateReceivedAt || Date.now())
  return true
}

function getTrackPosition(startedAt: number, duration: number) {
  const elapsed = Math.max(0, (serverNow() - startedAt) / 1000)
  if (!Number.isFinite(duration) || duration <= 0) return elapsed
  return elapsed % duration
}

function signedTrackDriftSec(audioTime: number, targetTime: number, duration: number) {
  let drift = audioTime - targetTime
  if (Number.isFinite(duration) && duration > 0) {
    if (drift > duration / 2) drift -= duration
    else if (drift < -duration / 2) drift += duration
  }
  return drift
}

function seekAudioTo(audio: HTMLAudioElement, targetTime: number) {
  const duration = audio.duration
  const safeTime = Number.isFinite(duration) && duration > 0
    ? clamp(targetTime, 0, Math.max(0, duration - 0.02))
    : Math.max(0, targetTime)

  try {
    if ('fastSeek' in audio && typeof audio.fastSeek === 'function') {
      audio.fastSeek(safeTime)
    } else {
      audio.currentTime = safeTime
    }
    return true
  } catch {
    return false
  }
}

function alignMusicToTimeline(forceSeek = false) {
  if (!_musicTimeline || !_audio || _currentTrackIdx !== _musicTimeline.trackIdx) return false
  if (_audio.readyState < 1) return false

  const targetTime = getTrackPosition(_musicTimeline.startedAt, _audio.duration)
  if (!Number.isFinite(targetTime)) return false
  const drift = signedTrackDriftSec(_audio.currentTime, targetTime, _audio.duration)
  const absDrift = Math.abs(drift)

  if (forceSeek && absDrift >= MUSIC_DEADBAND_SEC) {
    if (!seekAudioTo(_audio, targetTime)) return false
    _audio.playbackRate = 1
    return true
  }

  if (absDrift > MUSIC_DEADBAND_SEC && MUSIC_MAX_RATE_DELTA > 0) {
    const rateDelta = clamp(-drift / MUSIC_RATE_HORIZON_SEC, -MUSIC_MAX_RATE_DELTA, MUSIC_MAX_RATE_DELTA)
    _audio.playbackRate = clamp(1 + rateDelta, 1 - MUSIC_MAX_RATE_DELTA, 1 + MUSIC_MAX_RATE_DELTA)
  } else {
    _audio.playbackRate = 1
  }
  return true
}

function alignMusicToTimelineAfterResume() {
  if (!_musicTimeline || !_audio || _currentTrackIdx !== _musicTimeline.trackIdx) return
  if (_audio.readyState < 1) return

  const targetTime = getTrackPosition(_musicTimeline.startedAt, _audio.duration)
  if (!Number.isFinite(targetTime)) return
  const drift = signedTrackDriftSec(_audio.currentTime, targetTime, _audio.duration)
  alignMusicToTimeline(Math.abs(drift) > MUSIC_START_SEEK_DRIFT_SEC)
}

function alignMusicToTimelineGently() {
  alignMusicToTimeline(false)
}

function markMusicTimelineInterrupted() {
  _forceTimelineSeekAfterVisibilityRestore = true
}

function requestFreshResumeMusicState(waitMs = 900) {
  const now = Date.now()
  _freshResumeMusicStateRequestedAt = now
  _freshResumeMusicStateWaitUntil = now + waitMs
  gameClient.requestTimeSync()
}

function shouldWaitForFreshResumeMusicState() {
  return (
    hasPendingForcedTimelineSeek() &&
    Date.now() < _freshResumeMusicStateWaitUntil &&
    _serverMusicStateReceivedAt < _freshResumeMusicStateRequestedAt
  )
}

function hasPendingForcedTimelineSeek() {
  return _forceTimelineSeekAfterHiddenSuspend || _forceTimelineSeekAfterOutputHandoff || _forceTimelineSeekAfterVisibilityRestore
}

function clearPendingForcedTimelineSeek() {
  _forceTimelineSeekAfterHiddenSuspend = false
  _forceTimelineSeekAfterOutputHandoff = false
  _forceTimelineSeekAfterVisibilityRestore = false
}

function alignMusicToTimelineForRouteRestore(wasPaused: boolean) {
  if (hasPendingForcedTimelineSeek()) {
    if (alignMusicToTimeline(true)) clearPendingForcedTimelineSeek()
    return
  }
  if (wasPaused) alignMusicToTimelineAfterResume()
  else alignMusicToTimelineGently()
}

function ensureTimelineAlignedBeforePlayback(force = false) {
  syncTimelineFromAuthoritativeTrackState(true)
  if (!_audio?.src || _audio.readyState < 1) return false
  if (hasPendingForcedTimelineSeek() || force) {
    if (!alignMusicToTimeline(true)) return false
    clearPendingForcedTimelineSeek()
    return true
  }
  return alignMusicToTimeline(true)
}

function forceAlignMusicToTimelineAfterInterruptedRoute() {
  if (!hasPendingForcedTimelineSeek()) return false
  syncTimelineFromAuthoritativeTrackState(true)
  if (!_audio?.src || _audio.readyState < 1) return false
  if (!alignMusicToTimeline(true)) return false
  clearPendingForcedTimelineSeek()
  return true
}

function playTimelineAudio(alignAfterStart = false) {
  if (!ensureMusicOutputOwnership()) {
    suspendLocalAudioForExternalOwner()
    return
  }
  if (shouldSuspendHiddenAudioWithoutAccess()) {
    suspendHiddenAudioWithoutAccess()
    return
  }
  if (shouldUseServerDjSource()) {
    suspendLocalTrackForDj()
    return
  }
  syncTimelineFromAuthoritativeTrackState()
  if (shouldWaitForFreshResumeMusicState()) return
  if (_lockscreenActive) {
    if (_lockscreenSource === 'dj') void playLockscreenDjAudio()
    else if (shouldKeepNativeLockscreenAudio()) void playLockscreenAudio(alignAfterStart)
    else void restoreTrackAudioFromLockscreen()
    return
  }
  if (!_audio) return
  if (!_audio.paused) {
    void resumeAudioContext(_ctx)
    if (alignAfterStart) alignMusicToTimelineAfterResume()
    return
  }
  void resumeAudioContext(_ctx)
  if (hasPendingForcedTimelineSeek() && !ensureTimelineAlignedBeforePlayback(true)) return
  if (alignAfterStart) alignMusicToTimeline(true)
  _audio.play()
    .then(() => {
      if (!alignAfterStart || !_audio || !_musicTimeline) return
      const targetTime = getTrackPosition(_musicTimeline.startedAt, _audio.duration)
      const drift = signedTrackDriftSec(_audio.currentTime, targetTime, _audio.duration)
      alignMusicToTimeline(Math.abs(drift) > MUSIC_START_SEEK_DRIFT_SEC)
    })
    .catch(() => {})
}

function normalizeMediaSrc(src: string) {
  return src ? new URL(src, window.location.href).href : ''
}

function normalizeTrackSrc(src: string) {
  try {
    const url = new URL(src, window.location.href)
    if (!MUSIC_FILE_EXTENSIONS.test(`${url.pathname}${url.search}`)) return ''
    return `${url.pathname}${url.search}`
  } catch {
    return ''
  }
}

function trackSignature(tracks: string[]) {
  return tracks.join('\n')
}

async function ensurePlayableMusicTimeline() {
  await refreshMusicTracks()
  return Boolean(_musicTimeline || _audio?.src || shouldUseServerDjSource())
}

async function refreshMusicTracks() {
  try {
    const response = await fetch(`${MUSIC_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) return false
    const manifest = await response.json() as { tracks?: Array<{ src?: string }> }
    const nextTracks = (manifest.tracks ?? [])
      .map((track) => normalizeTrackSrc(String(track.src || '')))
      .filter((src, index, tracks): src is string => Boolean(src) && tracks.indexOf(src) === index)

    if (nextTracks.length === 0) return false
    const nextSignature = trackSignature(nextTracks)
    if (nextSignature === _tracksSignature) return false

    _tracks = nextTracks
    _tracksSignature = nextSignature
    if (_currentTrackIdx >= _tracks.length) _currentTrackIdx = -1
    if (_musicTimeline) {
      applyMusicState(_musicTimeline.trackIdx, _musicTimeline.startedAt)
    }
    return true
  } catch {
    return false
  }
}

function configureMediaElement(audio: HTMLAudioElement) {
  audio.preload = 'auto'
  audio.crossOrigin = 'anonymous'
  audio.controls = false
  audio.setAttribute('playsinline', 'true')
  audio.setAttribute('webkit-playsinline', 'true')
}

function waitForCanPlay(audio: HTMLAudioElement, timeoutMs = 1600) {
  if (audio.readyState >= 2) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      audio.removeEventListener('canplay', onReady)
      audio.removeEventListener('loadeddata', onReady)
      audio.removeEventListener('error', onError)
      resolve(ok)
    }
    const onReady = () => finish(true)
    const onError = () => finish(false)
    const timeout = window.setTimeout(() => finish(audio.readyState >= 2), timeoutMs)
    audio.addEventListener('canplay', onReady, { once: true })
    audio.addEventListener('loadeddata', onReady, { once: true })
    audio.addEventListener('error', onError, { once: true })
  })
}

function getLockscreenTrackVolume() {
  return clamp(_volume * getEnvironmentGain() * (shouldUseServerDjSource() ? 0 : 1), 0, 1)
}

function getLockscreenDjVolume() {
  return clamp(getDjOutputVolume(), 0, 1)
}

function lockscreenElementVolume(element: HTMLAudioElement | null, processedStream: MediaStream | null, fallbackVolume: number) {
  return processedStream && element?.srcObject === processedStream ? 1 : fallbackVolume
}

function shouldUseNativeLockscreenAudio() {
  return IS_MOBILE_AUDIO
}

function canUseLockscreenAudioNow(environment = _environment) {
  return _audioRouteActive && environment === 'club'
}

function shouldKeepNativeLockscreenAudio() {
  return shouldUseNativeLockscreenAudio() && canUseLockscreenAudioNow() && isDocumentHidden()
}

function shouldKeepMainTrackRouteWhileHidden() {
  return !shouldUseNativeLockscreenAudio() && canUseLockscreenAudioNow()
}

function shouldIgnoreHiddenAudioEvents() {
  return !IS_MOBILE_AUDIO && _environment === 'club'
}

function isDocumentHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function isAudioContextRunning(ctx: AudioContext | null): ctx is AudioContext {
  return Boolean(ctx && ctx.state === 'running')
}

function resetMediaElement(element: HTMLAudioElement | null, removeFromDom = false) {
  if (!element) return
  element.pause()
  element.muted = true
  element.volume = 0
  element.srcObject = null
  element.removeAttribute('src')
  element.load()
  if (removeFromDom) element.remove()
}

function safeDisconnectNode(node: AudioNode | null | undefined) {
  try {
    node?.disconnect()
  } catch {
    // Already disconnected nodes are fine during teardown.
  }
}

async function resumeAudioContext(ctx: AudioContext | null) {
  if (!ctx || ctx.state === 'running') return
  await ctx.resume().catch(() => undefined)
}

async function ensureAudioContextRunning(ctx: AudioContext | null) {
  await resumeAudioContext(ctx)
  return isAudioContextRunning(ctx)
}

async function requestScreenWakeLock() {
  if (!_screenWakeLockWanted || isDocumentHidden() || _screenWakeLock) return
  const wakeLock = (navigator as any).wakeLock
  if (!wakeLock?.request) return
  try {
    const lock = await wakeLock.request('screen')
    _screenWakeLock = lock
    lock.addEventListener?.('release', () => {
      _screenWakeLock = null
    })
  } catch {
    _screenWakeLock = null
  }
}

function releaseScreenWakeLock() {
  const lock = _screenWakeLock
  _screenWakeLock = null
  void lock?.release().catch(() => undefined)
}

function setScreenWakeLockWanted(wanted: boolean) {
  _screenWakeLockWanted = wanted
  if (!wanted || isDocumentHidden()) {
    releaseScreenWakeLock()
    return
  }
  void requestScreenWakeLock()
}

function hasLockscreenMusicAccess() {
  return canUseLockscreenAudioNow()
}

function shouldSuspendHiddenAudioWithoutAccess() {
  return isDocumentHidden() && !canUseLockscreenAudioNow()
}

function getTrackTitle(trackIdx = _currentTrackIdx) {
  const path = _tracks[trackIdx] ?? ''
  const cleanPath = path.split('?')[0] ?? ''
  return decodeURIComponent(cleanPath.split('/').pop() ?? 'DOOR//CLUB')
    .replace(/\.[^.]+$/, '')
}

function updateMediaSession(playbackState: MediaSessionPlaybackState = 'playing') {
  if (!('mediaSession' in navigator)) return

  navigator.mediaSession.metadata = new MediaMetadata({
    title: shouldUseServerDjSource() ? 'DJ LIVE' : getTrackTitle(),
    artist: 'DOOR//CLUB',
    album: _environment === 'outside' ? 'Outside the club' : 'Club floor',
  })
  navigator.mediaSession.playbackState = playbackState

  const activeAudio = _lockscreenSource === 'dj'
    ? _djLockscreenElement
    : _lockscreenAudio && !_lockscreenAudio.srcObject ? _lockscreenAudio : _audio
  if (activeAudio && 'setPositionState' in navigator.mediaSession) {
    try {
      navigator.mediaSession.setPositionState({
        duration: Number.isFinite(activeAudio.duration) && activeAudio.duration > 0 ? activeAudio.duration : undefined,
        playbackRate: activeAudio.playbackRate || 1,
        position: Number.isFinite(activeAudio.currentTime) ? activeAudio.currentTime : 0,
      })
    } catch {
      // Some mobile browsers reject incomplete position state; metadata still works.
    }
  }

  try {
    navigator.mediaSession.setActionHandler('play', () => {
      if (_lockscreenSource === 'dj') void playLockscreenDjAudio()
      else if (_lockscreenActive) void playLockscreenAudio(true)
      else playTimelineAudio(true)
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      _audio?.pause()
      _lockscreenAudio?.pause()
      _djLockscreenElement?.pause()
      updateMediaSession('paused')
    })
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (_lockscreenSource === 'dj') return
      if (!_audio || typeof details.seekTime !== 'number') return
      seekAudioTo(_audio, details.seekTime)
      if (_lockscreenAudio && !_lockscreenAudio.srcObject) seekAudioTo(_lockscreenAudio, details.seekTime)
      updateMediaSession('playing')
    })
  } catch {
    // Action handlers are best-effort; unsupported handlers should not block playback.
  }
}

function getDjLockscreenElement() {
  if (!_djLockscreenElement) {
    _djLockscreenElement = new Audio()
    configureMediaElement(_djLockscreenElement)
    _djLockscreenElement.autoplay = true
    _djLockscreenElement.style.display = 'none'
    _djLockscreenElement.addEventListener('play', () => updateMediaSession('playing'))
    _djLockscreenElement.addEventListener('pause', () => {
      if (_lockscreenSource === 'dj') updateMediaSession('paused')
    })
    document.body.appendChild(_djLockscreenElement)
  }
  return _djLockscreenElement
}

function syncDjLockscreenElement(useNativeElement = shouldUseNativeLockscreenAudio()) {
  if (!_djMediaStreamTrack && !_djLockscreenOutput) return null
  const element = getDjLockscreenElement()
  const stream = element.srcObject instanceof MediaStream ? element.srcObject : null
  if (_djLockscreenOutput && !useNativeElement) {
    if (stream !== _djLockscreenOutput.stream) {
      element.srcObject = _djLockscreenOutput.stream
      element.removeAttribute('src')
    }
  } else if (_djMediaStreamTrack) {
    if (!stream || stream.getAudioTracks()[0] !== _djMediaStreamTrack) {
      element.srcObject = new MediaStream([_djMediaStreamTrack])
      element.removeAttribute('src')
    }
  }
  element.volume = lockscreenElementVolume(element, _djLockscreenOutput?.stream ?? null, getLockscreenDjVolume())
  element.muted = false
  return element
}

function getLockscreenAudio() {
  if (!_lockscreenAudio) {
    _lockscreenAudio = new Audio()
    configureMediaElement(_lockscreenAudio)
    _lockscreenAudio.loop = true
    _lockscreenAudio.addEventListener('play', () => updateMediaSession('playing'))
    _lockscreenAudio.addEventListener('pause', () => {
      if (_lockscreenActive) updateMediaSession('paused')
    })
  }
  return _lockscreenAudio
}

function syncLockscreenAudioFromMain(useNativeElement = shouldUseNativeLockscreenAudio()) {
  if (!_audio || !_audio.src) return null
  const lockscreenAudio = getLockscreenAudio()
  const src = _audio.currentSrc || _audio.src
  if (_lockscreenOutput && !useNativeElement) {
    if (lockscreenAudio.srcObject !== _lockscreenOutput.stream) {
      lockscreenAudio.pause()
      lockscreenAudio.srcObject = _lockscreenOutput.stream
      lockscreenAudio.removeAttribute('src')
    }
  } else {
    if (lockscreenAudio.srcObject) lockscreenAudio.srcObject = null
    if (normalizeMediaSrc(lockscreenAudio.src) !== normalizeMediaSrc(src)) {
      lockscreenAudio.src = src
      lockscreenAudio.load()
    }
    const drift = Math.abs((lockscreenAudio.currentTime || 0) - (_audio.currentTime || 0))
    if (drift > 0.12 && Number.isFinite(_audio.currentTime)) {
      seekAudioTo(lockscreenAudio, _audio.currentTime)
    }
    lockscreenAudio.playbackRate = _audio.playbackRate || 1
  }
  lockscreenAudio.volume = lockscreenElementVolume(lockscreenAudio, _lockscreenOutput?.stream ?? null, getLockscreenTrackVolume())
  lockscreenAudio.muted = false
  return lockscreenAudio
}

async function primeLockscreenAudio() {
  if (!IS_MOBILE_AUDIO) return
  if (hasActiveExternalMusicOutputOwner()) return
  if (!hasLockscreenMusicAccess()) return
  await primeTrackLockscreenAudio()
  await primeDjLockscreenAudio()
}

async function primeTrackLockscreenAudio() {
  if (!_audio?.src) return
  const lockscreenAudio = syncLockscreenAudioFromMain()
  if (!lockscreenAudio) return

  const previousVolume = lockscreenAudio.volume
  lockscreenAudio.volume = 0
  try {
    await lockscreenAudio.play()
    lockscreenAudio.pause()
  } catch {
    // The main audio element still works; this fallback will retry when the page hides.
  } finally {
    if (_lockscreenActive && _lockscreenSource === 'track') {
      lockscreenAudio.volume = previousVolume
    } else {
      lockscreenAudio.volume = 0
      lockscreenAudio.muted = true
    }
  }
}

async function primeDjLockscreenAudio() {
  const element = syncDjLockscreenElement()
  if (!element) return

  const previousVolume = element.volume
  element.volume = 0
  try {
    await element.play()
    element.pause()
  } catch {
    // Mobile browsers may only allow this once a remote DJ track is already audible.
  } finally {
    if (_lockscreenActive && _lockscreenSource === 'dj') {
      element.volume = previousVolume
    } else {
      element.volume = 0
      element.muted = true
    }
  }
}

async function playLockscreenAudio(alignAfterStart = false) {
  const useNativeElement = shouldUseNativeLockscreenAudio()
  const keepNativeRoute = useNativeElement && shouldKeepNativeLockscreenAudio()
  if (!ensureMusicOutputOwnership()) {
    suspendLocalAudioForExternalOwner()
    return false
  }
  if (!hasLockscreenMusicAccess()) {
    stopLockscreenAudio(true)
    return false
  }
  syncTimelineFromAuthoritativeTrackState()
  if (alignAfterStart) alignMusicToTimeline(true)
  if (_lockscreenActive && _lockscreenSource === 'track' && _lockscreenAudio && !_lockscreenAudio.paused) {
    if (!keepNativeRoute && !isDocumentHidden()) {
      return restoreTrackAudioFromLockscreen()
    }
    if (alignAfterStart) syncLockscreenAudioFromMain(useNativeElement)
    _lockscreenAudio.volume = lockscreenElementVolume(
      _lockscreenAudio,
      useNativeElement ? null : _lockscreenOutput?.stream ?? null,
      getLockscreenTrackVolume(),
    )
    if (keepNativeRoute) disconnectMainSpeaker()
    updateMediaSession('playing')
    return true
  }
  if (_lockscreenSwitching) return false
  _lockscreenSwitching = true
  try {
    await resumeAudioContext(_ctx)
    if (_audio) {
      await waitForCanPlay(_audio)
      alignMusicToTimeline(true)
    }
    if (_audio?.paused) await _audio.play().catch(() => undefined)
    if (alignAfterStart) alignMusicToTimeline(true)
    const lockscreenAudio = syncLockscreenAudioFromMain(useNativeElement)
    if (!lockscreenAudio) return false
    if (!isDocumentHidden() && !keepNativeRoute) {
      connectMainSpeaker()
      applyOutputState()
      return Boolean(_audio && !_audio.paused && isAudioContextRunning(_ctx))
    }
    disconnectMainSpeaker()
    _lockscreenActive = true
    _lockscreenSource = 'track'
    await lockscreenAudio.play()
    updateMediaSession('playing')
    return true
  } catch {
    _lockscreenActive = false
    _lockscreenSource = null
    connectMainSpeaker()
    return false
  } finally {
    _lockscreenSwitching = false
  }
}

async function playLockscreenDjAudio() {
  const useNativeElement = shouldUseNativeLockscreenAudio()
  if (!ensureMusicOutputOwnership()) {
    suspendLocalAudioForExternalOwner()
    return
  }
  if (!hasLockscreenMusicAccess()) {
    stopLockscreenAudio(true)
    return
  }
  if (_lockscreenActive && _lockscreenSource === 'dj' && _djLockscreenElement && !_djLockscreenElement.paused) {
    _djLockscreenElement.volume = lockscreenElementVolume(
      _djLockscreenElement,
      useNativeElement ? null : _djLockscreenOutput?.stream ?? null,
      getLockscreenDjVolume(),
    )
    updateMediaSession('playing')
    return
  }
  if (_lockscreenSwitching) return
  _lockscreenSwitching = true
  const element = syncDjLockscreenElement(useNativeElement)
  if (!element) {
    _lockscreenSwitching = false
    return
  }
  try {
    await resumeAudioContext(_ctx)
    await _djRoom?.startAudio().catch(() => undefined)
    if (!isDocumentHidden()) {
      connectDjSpeaker()
      applyOutputState()
      return
    }
    if (!useNativeElement) disconnectDjSpeaker()
    _lockscreenActive = true
    _lockscreenSource = 'dj'
    await element.play()
    if (_djElement) {
      _djElement.muted = true
      _djElement.volume = 0
    }
    updateMediaSession('playing')
  } catch {
    _lockscreenActive = false
    _lockscreenSource = null
    if (shouldUseDjOutput()) connectDjSpeaker()
  } finally {
    _lockscreenSwitching = false
  }
}

function stopLockscreenAudio(syncMain = true) {
  if (
    syncMain &&
    _lockscreenSource === 'track' &&
    _lockscreenAudio &&
    _audio &&
    !_lockscreenAudio.paused &&
    !_lockscreenAudio.srcObject &&
    Number.isFinite(_lockscreenAudio.currentTime)
  ) {
    seekAudioTo(_audio, _lockscreenAudio.currentTime)
  }
  _lockscreenAudio?.pause()
  if (_lockscreenAudio) _lockscreenAudio.volume = 0
  _djLockscreenElement?.pause()
  if (_djLockscreenElement) _djLockscreenElement.volume = 0
  _lockscreenActive = false
  _lockscreenSource = null
  if (shouldSuspendHiddenAudioWithoutAccess()) {
    disconnectMainSpeaker()
    disconnectDjSpeaker()
  } else {
    if (!shouldUseServerDjSource()) connectMainSpeaker()
    if (shouldUseDjOutput()) connectDjSpeaker()
  }
}

function suspendLocalAudioForExternalOwner() {
  _forceTimelineSeekAfterOutputHandoff = true
  _audio?.pause()
  _lockscreenAudio?.pause()
  if (_lockscreenAudio) {
    _lockscreenAudio.volume = 0
    _lockscreenAudio.muted = true
  }
  _djLockscreenElement?.pause()
  if (_djLockscreenElement) {
    _djLockscreenElement.volume = 0
    _djLockscreenElement.muted = true
  }
  _lockscreenActive = false
  _lockscreenSource = null
  disconnectMainSpeaker()
  disconnectDjSpeaker()
  if (_djTrack) _djTrack.setVolume(0)
  if (_djElement) {
    _djElement.muted = true
    _djElement.volume = 0
  }
  updateMediaSession('paused')
  dispatchMusicOutput(0)
}

function suspendHiddenAudioWithoutAccess() {
  stopLockscreenAudio(false)
  _hiddenSuspendedWithoutLockscreenAccess = true
  _forceTimelineSeekAfterHiddenSuspend = true
  markMusicTimelineInterrupted()
  _audio?.pause()
  _djLockscreenElement?.pause()
  disconnectMainSpeaker()
  disconnectDjSpeaker()
  if (_djTrack) _djTrack.setVolume(0)
  updateMediaSession('paused')
  dispatchMusicOutput()
}

async function restoreTrackAudioFromLockscreen() {
  if (!_audio) return false
  if (_mainAudioRestoring) return false
  _mainAudioRestoring = true

  try {
    const lockscreenAudio = _lockscreenAudio
    if (
      _lockscreenSource === 'track' &&
      lockscreenAudio &&
      !lockscreenAudio.paused &&
      !lockscreenAudio.srcObject &&
      Number.isFinite(lockscreenAudio.currentTime)
    ) {
      seekAudioTo(_audio, lockscreenAudio.currentTime)
    }

    if (lockscreenAudio) {
      lockscreenAudio.pause()
      lockscreenAudio.volume = 0
    }
    _lockscreenActive = false
    _lockscreenSource = null

    connectMainSpeaker()
    await resumeAudioContext(_ctx)
    applyOutputState()

    syncTimelineFromAuthoritativeTrackState()
    await waitForCanPlay(_audio)
    if (hasPendingForcedTimelineSeek()) {
      if (!ensureTimelineAlignedBeforePlayback(true)) return false
    } else {
      alignMusicToTimelineAfterResume()
    }
    await _audio.play()
    if (!(await ensureAudioContextRunning(_ctx))) return false
    if (hasPendingForcedTimelineSeek()) {
      if (!ensureTimelineAlignedBeforePlayback(true)) return false
    } else {
      alignMusicToTimelineAfterResume()
    }
    applyOutputState()
    return true
  } catch {
    if (_lockscreenAudio) {
      _lockscreenAudio.volume = getLockscreenTrackVolume()
      _lockscreenAudio.muted = false
    }
    updateMediaSession('playing')
    return false
  } finally {
    _mainAudioRestoring = false
  }
}

function needsMainTrackAudioRouteRestore() {
  if (!_audioRouteActive || isDocumentHidden() || shouldUseServerDjSource()) return false
  if (_hiddenSuspendedWithoutLockscreenAccess) return true
  if (!_audio?.src && _musicTimeline) return true
  if (!_audio?.src) return false
  if (_lockscreenActive && _lockscreenSource === 'track' && !shouldKeepNativeLockscreenAudio()) return true
  return _audio.paused || !isAudioContextRunning(_ctx) || (!_mainSpeakerConnected && !_lockscreenActive)
}

async function ensureMainTrackAudioRoute() {
  if (_mainTrackRoutePromise) return _mainTrackRoutePromise
  _mainTrackRoutePromise = ensureMainTrackAudioRouteInner().finally(() => {
    _mainTrackRoutePromise = null
  })
  return _mainTrackRoutePromise
}

async function ensureMainTrackAudioRouteInner() {
  if (!_audioRouteActive) return false
  if (!ensureMusicOutputOwnership()) {
    suspendLocalAudioForExternalOwner()
    return false
  }
  if (shouldSuspendHiddenAudioWithoutAccess()) {
    suspendHiddenAudioWithoutAccess()
    return false
  }
  if (isDocumentHidden()) return false

  preferPlaybackAudioSession()
  const { audio, ctx } = getAudioGraph()
  if (shouldUseServerDjSource()) {
    suspendLocalTrackForDj()
    await startDjAudioElement()
    return shouldUseDjOutput()
  }
  syncTimelineFromAuthoritativeTrackState()
  if (!audio.src && _musicTimeline) {
    _currentTrackIdx = -1
    applyMusicState(_musicTimeline.trackIdx, _musicTimeline.startedAt)
  }
  if (!audio.src) return false

  if (!(_lockscreenActive && _lockscreenSource === 'track' && shouldKeepNativeLockscreenAudio())) {
    connectMainSpeaker()
  }
  await resumeAudioContext(ctx)
  applyOutputState()

  if (_lockscreenActive && _lockscreenSource === 'track') {
    if (shouldKeepNativeLockscreenAudio()) {
      const ok = await playLockscreenAudio(true)
      if (ok) {
        applyOutputState()
        return true
      }
    }
    return restoreTrackAudioFromLockscreen()
  }

  try {
    const wasPaused = audio.paused
    await waitForCanPlay(audio)
    syncTimelineFromAuthoritativeTrackState()
    if (hasPendingForcedTimelineSeek()) {
      if (!ensureTimelineAlignedBeforePlayback(true)) return false
    } else {
      alignMusicToTimelineForRouteRestore(wasPaused)
    }
    await audio.play()
    if (!(await ensureAudioContextRunning(ctx))) return false
    if (hasPendingForcedTimelineSeek()) {
      if (!ensureTimelineAlignedBeforePlayback(true)) return false
    } else {
      alignMusicToTimelineForRouteRestore(wasPaused)
    }
    if (shouldKeepNativeLockscreenAudio()) {
      const ok = await playLockscreenAudio(true)
      if (ok) {
        applyOutputState()
        return true
      }
    }
    stopLockscreenAudio(false)
    applyOutputState()
    return true
  } catch {
    if (!audio.paused && isAudioContextRunning(ctx)) {
      alignMusicToTimeline(false)
      stopLockscreenAudio(false)
      applyOutputState()
      return true
    }
    return false
  }
}

function getAudioGraph() {
  if (!_audio) {
    _audio = new Audio()
    configureMediaElement(_audio)

    // Трек переключает сервер, чтобы у всех был один общий таймлайн.
    _audio.addEventListener('ended', () => {
      _audio?.pause()
      dispatchMusicOutput()
    })
    _audio.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(_audio!.duration) || _audio!.duration <= 0) return
      window.dispatchEvent(new CustomEvent('music-track-duration', {
        detail: { trackIdx: _currentTrackIdx, duration: _audio!.duration }
      }))
      forceAlignMusicToTimelineAfterInterruptedRoute()
      if (!_forceTimelineSeekAfterVisibilityRestore) alignMusicToTimelineAfterResume()
      updateMediaSession(_audio!.paused ? 'paused' : 'playing')
    })
    _audio.addEventListener('canplay', () => {
      forceAlignMusicToTimelineAfterInterruptedRoute()
    })
    _audio.addEventListener('play', () => {
      syncTimelineFromAuthoritativeTrackState(true)
      forceAlignMusicToTimelineAfterInterruptedRoute()
      if (!_forceTimelineSeekAfterVisibilityRestore) alignMusicToTimelineAfterResume()
      updateMediaSession('playing')
      dispatchMusicOutput()
      dispatchMusicBpm()
    })
    _audio.addEventListener('pause', () => {
      if (!_lockscreenActive) updateMediaSession('paused')
      dispatchMusicOutput()
      dispatchMusicBpm()
    })
  }
  if (!_ctx) {
    _ctx    = new AudioContext()
    _gain   = _ctx.createGain()
    _doorEq = createDoorEqGraph(_ctx)
    _filter = _doorEq.lowPassA
    _gain.gain.value = _volume
    _source = _ctx.createMediaElementSource(_audio)
    _trackBpmAnalyser = createBpmAnalyser(_ctx)
    _trackBpmEstimator = new LiveBpmEstimator(_trackBpmAnalyser)
    _source.connect(_doorEq.nodes[0])
    _source.connect(_trackBpmAnalyser)
    connectNodeChain(_doorEq.nodes, _gain)
    _lockscreenOutput = _ctx.createMediaStreamDestination()
    _gain.connect(_lockscreenOutput)
    connectMainSpeaker()
    applyEqState(_doorEq, false, 0, _ctx.currentTime, 0)
  }
  return { audio: _audio, gain: _gain!, filter: _filter!, ctx: _ctx! }
}

function dispatchDjState(active: boolean) {
  const wasActive = _djActive
  const wasDjOutput = shouldUseDjOutput()
  _djActive = active
  if (active !== wasActive) _lastKnownBpm = null
  if (shouldUseServerDjSource()) {
    suspendLocalTrackForDj()
  } else if (wasDjOutput || active || wasActive) {
    void resumeLocalTrackAfterDj()
  }
  if (_ctx && _gain) applyOutputState()
  window.dispatchEvent(new CustomEvent('dj-stream-state', {
    detail: { active, blocked: _djPlaybackBlocked }
  }))
  dispatchMusicBpm()
  dispatchMusicOutput()
}

function currentMusicBpm(serverState = currentServerMusicState()) {
  const authoritativeState = currentAuthoritativeMusicState()
  if (authoritativeState?.source === 'dj') {
    _lastKnownBpm = Math.round(clamp(authoritativeState.bpm, BPM_MIN, BPM_MAX) * 10) / 10
    return _lastKnownBpm
  }

  const useDjOutput = shouldUseDjOutput()
  if (!useDjOutput && serverState) {
    _lastKnownBpm = Math.round(clamp(serverState.bpm, BPM_MIN, BPM_MAX) * 10) / 10
    return _lastKnownBpm
  }

  const estimator = useDjOutput ? _djBpmEstimator : null
  if (estimator?.bpm && estimator.confidence >= LIVE_BPM_MIN_CONFIDENCE) {
    _lastKnownBpm = Math.round(clamp(estimator.reportedBpm ?? estimator.bpm, BPM_MIN, BPM_MAX) * 10) / 10
    return _lastKnownBpm
  }

  const sourcePlaying = useDjOutput
    ? Boolean(_djTrack || _djMediaStreamTrack || (_djElement && !_djElement.paused))
    : Boolean(_audio && !_audio.paused)
  if (!sourcePlaying) return null
  return _lastKnownBpm ?? BPM_DISPLAY_FALLBACK
}

function dispatchMusicBpm() {
  const authoritativeState = currentAuthoritativeMusicState()
  const serverDjState = authoritativeState?.source === 'dj' ? authoritativeState : null
  const useDjOutput = shouldUseDjOutput()
  const estimator = useDjOutput ? _djBpmEstimator : null
  const ctx = _ctx
  const serverState = currentServerMusicState()
  const bpm = currentMusicBpm(serverState)
  const liveBeatAtMs = estimator?.lastBeatAtSec !== null && estimator?.lastBeatAtSec !== undefined && ctx
    ? performance.now() - Math.max(0, ctx.currentTime - estimator.lastBeatAtSec) * 1000
    : null
  const serverBeatAtMs = serverState && !useDjOutput
    ? performance.now() - Math.max(0, serverNow() - serverState.beatStartedAt)
    : null
  const serverDjBeatAtMs = serverDjState
    ? performance.now() - Math.max(0, serverNow() - serverDjState.beatStartedAt)
    : null

  window.dispatchEvent(new CustomEvent(MUSIC_BPM_EVENT, {
    detail: {
      bpm,
      trackIdx: serverDjState ? serverDjState.trackIdx : serverState && !useDjOutput ? serverState.trackIdx : _currentTrackIdx,
      source: serverDjState ? 'dj' : 'track',
      bpmSource: serverDjState ? serverDjState.bpmSource ?? 'fallback' : useDjOutput ? 'live' : serverState?.bpmSource ?? 'fallback',
      confidence: serverDjState ? serverDjState.bpmConfidence ?? 0 : useDjOutput ? estimator?.confidence ?? 0 : serverState?.bpmConfidence ?? 0,
      beatAtMs: serverDjState ? serverDjBeatAtMs ?? liveBeatAtMs : useDjOutput ? liveBeatAtMs : serverBeatAtMs,
      beatIntervalSec: serverDjState?.beatIntervalMs
        ? serverDjState.beatIntervalMs / 1000
        : useDjOutput
        ? estimator?.beatIntervalSec ?? (bpm ? 60 / bpm : null)
        : serverState?.beatIntervalMs
          ? serverState.beatIntervalMs / 1000
          : bpm ? 60 / bpm : null,
      updatedAt: Date.now(),
    },
  }))
}

function getEnvironmentGain(environment = _environment, outsideDoorProximity = _outsideDoorProximity) {
  if (environment === 'club') return 1
  const doorLeak = Math.pow(outsideDoorProximity, 0.72)
  return OUTSIDE_BASE_GAIN + doorLeak * OUTSIDE_DOOR_GAIN
}

function dispatchMusicOutput(environmentGain = getEnvironmentGain()) {
  const outputBlocked = shouldSuspendHiddenAudioWithoutAccess() || hasActiveExternalMusicOutputOwner()
  const serverDjSource = shouldUseServerDjSource()
  const useDjOutput = shouldUseDjOutput()
  const maxEnvironmentGain = _environment === 'outside' ? OUTSIDE_BASE_GAIN + OUTSIDE_DOOR_GAIN : 1
  const heardVolume = outputBlocked || (serverDjSource && !useDjOutput) ? 0 : _volume * environmentGain
  const serverState = currentServerMusicState()
  const estimator = useDjOutput ? _djBpmEstimator : _trackBpmEstimator
  const useServerDynamics = Boolean(serverState && !useDjOutput)
  const sourcePlaying = outputBlocked
    ? false
    : useDjOutput
      ? Boolean(_djTrack || _djMediaStreamTrack || (_djElement && !_djElement.paused))
      : Boolean((_audio && !_audio.paused) || (_lockscreenAudio && !_lockscreenAudio.paused))
  const localRhythmIntensity = estimator?.rhythmIntensity ?? 0
  const localKickIntensity = estimator?.kickIntensity ?? 0
  const localOnsetStrength = estimator?.onsetStrength ?? 0
  const hasLocalDynamics = Boolean(
    estimator &&
    sourcePlaying &&
    (localRhythmIntensity > 0.001 || localKickIntensity > 0.001 || localOnsetStrength > 0.001),
  )
  const rhythmIntensity = hasLocalDynamics ? localRhythmIntensity : useServerDynamics ? serverState!.rhythmIntensity : serverState?.rhythmIntensity ?? 0
  const kickIntensity = hasLocalDynamics ? localKickIntensity : useServerDynamics ? serverState!.kickIntensity : serverState?.kickIntensity ?? 0
  const onsetStrength = hasLocalDynamics ? localOnsetStrength : useServerDynamics ? serverState!.onsetStrength : serverState?.onsetStrength ?? 0
  const reactiveIntensity = clamp(
    Math.max(rhythmIntensity * 0.9, kickIntensity * 0.86, onsetStrength * 0.8),
    0,
    1,
  )
  const musicIntensity = sourcePlaying
    ? useServerDynamics
      ? Math.max(serverState!.intensity, hasLocalDynamics ? reactiveIntensity : 0)
      : estimator
        ? Math.max(reactiveIntensity, serverState?.intensity ?? 0)
        : serverState?.intensity ?? 0.32
    : 0
  window.dispatchEvent(new CustomEvent(MUSIC_OUTPUT_EVENT, {
    detail: {
      environment: _environment,
      volume: _volume,
      environmentGain,
      heardVolume,
      audibleIntensity: clamp(maxEnvironmentGain > 0 ? heardVolume / maxEnvironmentGain : 0, 0, 1),
      intensity: musicIntensity,
      rhythmIntensity,
      kickIntensity,
      onsetStrength,
      djActive: _djActive,
      djAudible: useDjOutput,
      updatedAt: Date.now(),
    },
  }))
}

function sampleMusicBpm() {
  const ctx = _ctx
  if (!isAudioContextRunning(ctx)) {
    dispatchMusicOutput()
    return
  }
  const useDjOutput = shouldUseDjOutput()
  const sourcePlaying = useDjOutput
    ? Boolean(_djTrack || _djMediaStreamTrack || (_djElement && !_djElement.paused))
    : Boolean(_audio && !_audio.paused)
  if (sourcePlaying) {
    if (useDjOutput) _djBpmEstimator?.sample(ctx.currentTime)
    else _trackBpmEstimator?.sample(ctx.currentTime)
  }
  dispatchMusicOutput()
}

function shouldUseDjOutput() {
  return shouldUseServerDjSource() && _djActive && _djPlaybackReady && !_djPlaybackBlocked
}

function getDjOutputVolume() {
  return _volume * getEnvironmentGain()
}

function rampParam(param: AudioParam, value: number, now: number, rampSec = 0.18) {
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  if (rampSec <= 0) {
    param.setValueAtTime(value, now)
    return
  }
  param.linearRampToValueAtTime(value, now + rampSec)
}

function applyEqState(eq: DoorEqGraph | null, isOutside: boolean, doorLeak: number, now: number, rampSec = 0.18) {
  if (!eq) return
  const amount = isOutside ? 1 : 0
  const lowPassHz = isOutside
    ? OUTSIDE_EQ.lowPassMinHz + doorLeak * (OUTSIDE_EQ.lowPassMaxHz - OUTSIDE_EQ.lowPassMinHz)
    : 18_000

  rampParam(eq.subShelf.frequency, OUTSIDE_EQ.subShelfHz, now, rampSec)
  rampParam(eq.subShelf.gain, OUTSIDE_EQ.subShelfDb * amount, now, rampSec)

  rampParam(eq.bassPeak.frequency, OUTSIDE_EQ.bassPeakHz, now, rampSec)
  rampParam(eq.bassPeak.Q, OUTSIDE_EQ.bassPeakQ, now, rampSec)
  rampParam(eq.bassPeak.gain, OUTSIDE_EQ.bassPeakDb * amount, now, rampSec)

  rampParam(eq.lowMidPeak.frequency, OUTSIDE_EQ.lowMidPeakHz, now, rampSec)
  rampParam(eq.lowMidPeak.Q, OUTSIDE_EQ.lowMidPeakQ, now, rampSec)
  rampParam(eq.lowMidPeak.gain, OUTSIDE_EQ.lowMidPeakDb * amount, now, rampSec)

  rampParam(eq.lowPassA.frequency, lowPassHz, now, rampSec)
  rampParam(eq.lowPassA.Q, isOutside ? OUTSIDE_EQ.lowPassQ : 0.55, now, rampSec)
  rampParam(eq.lowPassB.frequency, isOutside ? lowPassHz * OUTSIDE_EQ.secondLowPassScale : 20_000, now, rampSec)
  rampParam(eq.lowPassB.Q, isOutside ? 0.52 : 0.55, now, rampSec)

  rampParam(eq.midCut.frequency, OUTSIDE_EQ.midCutHz, now, rampSec)
  rampParam(eq.midCut.Q, OUTSIDE_EQ.midCutQ, now, rampSec)
  rampParam(eq.midCut.gain, OUTSIDE_EQ.midCutDb * amount, now, rampSec)

  rampParam(eq.highCut.frequency, OUTSIDE_EQ.highCutHz, now, rampSec)
  rampParam(eq.highCut.Q, OUTSIDE_EQ.highCutQ, now, rampSec)
  rampParam(eq.highCut.gain, OUTSIDE_EQ.highCutDb * amount, now, rampSec)

  rampParam(eq.treblePocket.frequency, OUTSIDE_EQ.treblePocketHz, now, rampSec)
  rampParam(eq.treblePocket.Q, OUTSIDE_EQ.treblePocketQ, now, rampSec)
  rampParam(eq.treblePocket.gain, OUTSIDE_EQ.treblePocketDb * amount, now, rampSec)
}

function applyOutputState() {
  const { gain } = getAudioGraph()
  const now = gain.context.currentTime
  const isOutside = _environment === 'outside'
  const doorLeak = Math.pow(_outsideDoorProximity, 0.72)
  const environmentGain = getEnvironmentGain()
  const outputBlocked = shouldSuspendHiddenAudioWithoutAccess() || hasActiveExternalMusicOutputOwner()
  const serverDjSource = shouldUseServerDjSource()
  const useDjOutput = shouldUseDjOutput()
  const targetGain = outputBlocked ? 0 : _volume * environmentGain * (serverDjSource ? 0 : 1)

  gain.gain.cancelScheduledValues(now)
  gain.gain.setValueAtTime(gain.gain.value, now)
  gain.gain.linearRampToValueAtTime(targetGain, now + 0.08)
  if (outputBlocked) {
    disconnectMainSpeaker()
    disconnectDjSpeaker()
  } else if (serverDjSource || _lockscreenActive) disconnectMainSpeaker()
  else if (_audioRouteActive && !_lockscreenActive) connectMainSpeaker()

  applyEqState(_doorEq, isOutside, doorLeak, now)

  if (_djGain) {
    _djGain.gain.cancelScheduledValues(now)
    _djGain.gain.setValueAtTime(_djGain.gain.value, now)
    _djGain.gain.linearRampToValueAtTime(outputBlocked || !useDjOutput ? 0 : _volume * environmentGain, now + 0.08)
  }
  applyEqState(_djDoorEq, isOutside, doorLeak, now)

  const djVolume = getDjOutputVolume()
  _djTrack?.setVolume(outputBlocked || !useDjOutput || _djGain ? 0 : _lockscreenSource === 'dj' ? 0 : djVolume)
  if (_djElement) {
    _djElement.muted = true
    _djElement.volume = 0
  }
  if (_lockscreenAudio) {
    const trackLockscreenActive = _lockscreenActive && _lockscreenSource === 'track'
    _lockscreenAudio.volume = outputBlocked || !trackLockscreenActive
      ? 0
      : lockscreenElementVolume(_lockscreenAudio, _lockscreenOutput?.stream ?? null, getLockscreenTrackVolume())
    if (!trackLockscreenActive && !_lockscreenAudio.paused) _lockscreenAudio.pause()
  }
  if (_djLockscreenElement) {
    const djLockscreenActive = _lockscreenActive && _lockscreenSource === 'dj'
    _djLockscreenElement.volume = outputBlocked || !djLockscreenActive
      ? 0
      : lockscreenElementVolume(_djLockscreenElement, _djLockscreenOutput?.stream ?? null, getLockscreenDjVolume())
    if (!djLockscreenActive && !_djLockscreenElement.paused) _djLockscreenElement.pause()
  }
  updateMediaSession((outputBlocked || (!useDjOutput && _audio?.paused && !_lockscreenActive)) ? 'paused' : 'playing')
  dispatchMusicOutput(environmentGain)
}

function suspendLocalTrackForDj() {
  if (_lockscreenSource === 'track') {
    _lockscreenAudio?.pause()
    if (_lockscreenAudio) _lockscreenAudio.volume = 0
    _lockscreenActive = false
    _lockscreenSource = null
  }
  _audio?.pause()
  disconnectMainSpeaker()
}

async function resumeLocalTrackAfterDj() {
  if (!_audioRouteActive || isDocumentHidden() || shouldUseServerDjSource()) return
  if (!ensureMusicOutputOwnership()) {
    suspendLocalAudioForExternalOwner()
    return
  }
  if (_lockscreenSource === 'dj') {
    _djLockscreenElement?.pause()
    _lockscreenActive = false
    _lockscreenSource = null
  }
  if (!_musicTimeline || !_audio?.src) return
  connectMainSpeaker()
  await ensureAudioContextRunning(_ctx)
  applyOutputState()
  playTimelineAudio(true)
}

export function setMusicEnvironment(environment: 'club' | 'outside', outsideDoorProximity = _outsideDoorProximity) {
  const nextOutsideDoorProximity = Math.max(0, Math.min(1, outsideDoorProximity))
  if (
    environment === _environment &&
    Math.abs(nextOutsideDoorProximity - _outsideDoorProximity) < OUTSIDE_PROXIMITY_APPLY_EPSILON &&
    !shouldSuspendHiddenAudioWithoutAccess()
  ) {
    return
  }
  _environment = environment
  _outsideDoorProximity = nextOutsideDoorProximity
  applyOutputState()
}

async function startDjAudioElement() {
  if (!_djElement) return
  if (!ensureMusicOutputOwnership()) {
    suspendLocalAudioForExternalOwner()
    return
  }
  if (shouldSuspendHiddenAudioWithoutAccess()) {
    suspendHiddenAudioWithoutAccess()
    return
  }
  await _djRoom?.startAudio().catch(() => undefined)
  _djElement.muted = true
  _djElement.volume = 0
  _djElement.pause()
  if (_djMediaStreamTrack && _djGain) {
    _djPlaybackReady = isAudioContextRunning(_ctx)
    _djPlaybackBlocked = !_djPlaybackReady
  } else {
    try {
      await _djElement.play()
      _djPlaybackReady = true
      _djPlaybackBlocked = false
    } catch {
      _djPlaybackReady = false
      _djPlaybackBlocked = true
    }
  }
  dispatchDjState(_djActive)
}

function attachDjTrack(track: RemoteAudioTrack) {
  const { ctx } = getAudioGraph()
  detachDjTrack(false)

  _djTrack = track
  _djPlaybackReady = false
  _djPlaybackBlocked = true
  _djDoorEq = createDoorEqGraph(ctx)
  _djElement = track.attach() as HTMLAudioElement
  _djElement.autoplay = true
  _djElement.muted = true
  _djElement.volume = 0
  _djElement.style.display = 'none'
  document.body.appendChild(_djElement)
  track.setVolume(0)
  track.start()

  const attachedStream = _djElement.srcObject instanceof MediaStream ? _djElement.srcObject : null
  const mediaStreamTrack = ((track as any).mediaStreamTrack ?? attachedStream?.getAudioTracks()[0]) as MediaStreamTrack | undefined
  if (mediaStreamTrack) {
    _djMediaStreamTrack = mediaStreamTrack
    _djGain = ctx.createGain()
    _djGain.gain.value = 0
    _djLockscreenOutput = ctx.createMediaStreamDestination()
    _djBpmAnalyser = createBpmAnalyser(ctx)
    _djBpmEstimator = new LiveBpmEstimator(_djBpmAnalyser)
    _djSource = ctx.createMediaStreamSource(new MediaStream([mediaStreamTrack]))
    _djSource.connect(_djDoorEq.nodes[0])
    connectNodeChain(_djDoorEq.nodes, _djGain)
    _djGain.connect(_djLockscreenOutput)
    connectDjSpeaker()
    _djSource.connect(_djBpmAnalyser)
  } else {
    track.setAudioContext(ctx)
    track.setWebAudioPlugins(_djDoorEq.nodes)
    track.setVolume(0)
  }

  dispatchDjState(true)
  applyOutputState()
  startDjAudioElement()
  void primeDjLockscreenAudio()
}

function detachDjTrack(updateState = true) {
  const hadDjOutput = Boolean(
    _djActive ||
    _djTrack ||
    _djElement ||
    _djLockscreenElement ||
    _djMediaStreamTrack ||
    _djSource ||
    _djGain
  )
  if (_djTrack && _djElement) {
    _djTrack.detach(_djElement)
  } else {
    _djTrack?.detach()
  }
  resetMediaElement(_djElement, true)
  resetMediaElement(_djLockscreenElement, true)
  _djTrack = null
  _djElement = null
  _djLockscreenElement = null
  _djMediaStreamTrack = null
  safeDisconnectNode(_djSource)
  disconnectDjSpeaker()
  _djDoorEq?.nodes.forEach(safeDisconnectNode)
  safeDisconnectNode(_djGain)
  safeDisconnectNode(_djLockscreenOutput)
  safeDisconnectNode(_djBpmAnalyser)
  _djSource = null
  _djDoorEq = null
  _djGain = null
  _djLockscreenOutput = null
  _djBpmAnalyser = null
  _djBpmEstimator = null
  _djPlaybackReady = false
  _djPlaybackBlocked = false
  if (updateState && hadDjOutput) {
    dispatchDjState(false)
    applyOutputState()
  }
}

function isDjPublication(publication: any) {
  return publication?.trackName === 'dj_audio'
}

async function connectLiveKitDjRoom() {
  if (_djRoom) return _djRoom

  const { token, url } = await getLiveKitToken(LIVEKIT_DJ_ROOM, 'listener')
  const room = new Room({
    adaptiveStream: false,
    dynacast: false,
  })
  _djRoom = room

  const handleSubscribed = (track: any, publication: any) => {
    if (!isDjPublication(publication)) return
    if (track instanceof RemoteAudioTrack) attachDjTrack(track)
  }
  const handleUnsubscribed = (_track: any, publication: any) => {
    if (isDjPublication(publication)) detachDjTrack()
  }
  const handleDisconnected = () => {
    detachDjTrack()
    _djRoom = null
  }
  const handleAudioPlayback = (playing: boolean) => {
    if (_djMediaStreamTrack && _djGain) {
      _djPlaybackReady = isAudioContextRunning(_ctx)
      _djPlaybackBlocked = !_djPlaybackReady
    } else {
      _djPlaybackReady = playing
      _djPlaybackBlocked = !playing
    }
    dispatchDjState(_djActive)
  }

  room.on(RoomEvent.TrackSubscribed, handleSubscribed)
  room.on(RoomEvent.TrackUnsubscribed, handleUnsubscribed)
  room.on(RoomEvent.Disconnected, handleDisconnected)
  room.on(RoomEvent.AudioPlaybackStatusChanged, handleAudioPlayback)

  await room.connect(url, token, { autoSubscribe: true })

  room.remoteParticipants.forEach((participant: any) => {
    participant.trackPublications?.forEach((publication: any) => {
      if (isDjPublication(publication) && publication.track instanceof RemoteAudioTrack) {
        attachDjTrack(publication.track)
      }
    })
  })

  return room
}

function disconnectLiveKitDjRoom(updateState = true) {
  const room = _djRoom
  _djRoom = null
  detachDjTrack(updateState)
  if (!updateState) {
    try {
      ;(room as any)?.removeAllListeners?.()
    } catch {
      // Best-effort: older room instances may not expose EventEmitter helpers.
    }
  }
  room?.disconnect().catch(() => {})
}

function shutdownMusicAudioSingleton() {
  _audioRouteActive = false
  _lockscreenActive = false
  _lockscreenSource = null
  _lockscreenSwitching = false
  _mainAudioRestoring = false
  _mainTrackRoutePromise = null
  _hiddenSuspendedWithoutLockscreenAccess = false
  _djActive = false
  _djPlaybackReady = false
  _djPlaybackBlocked = false

  stopMusicOutputOwnerHeartbeat()
  releaseMusicOutputOwnership()
  _musicOutputOwnerChannel?.close()
  _musicOutputOwnerChannel = null
  releaseScreenWakeLock()
  disconnectLiveKitDjRoom(false)

  resetMediaElement(_audio)
  resetMediaElement(_lockscreenAudio)
  resetMediaElement(_djElement, true)
  resetMediaElement(_djLockscreenElement, true)

  disconnectMainSpeaker()
  disconnectDjSpeaker()
  safeDisconnectNode(_source)
  _doorEq?.nodes.forEach(safeDisconnectNode)
  safeDisconnectNode(_gain)
  safeDisconnectNode(_lockscreenOutput)
  safeDisconnectNode(_trackBpmAnalyser)
  safeDisconnectNode(_bpmSilentSink)
  const ctx = _ctx
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)

  _audio = null
  _ctx = null
  _gain = null
  _filter = null
  _doorEq = null
  _source = null
  _trackBpmAnalyser = null
  _trackBpmEstimator = null
  _lockscreenAudio = null
  _lockscreenOutput = null
  _bpmSilentSink = null
  _currentTrackIdx = -1
  _musicTimeline = null
  _mainSpeakerConnected = false
  _djSpeakerConnected = false
  _lastBroadcastTimeSyncAtMs = 0
}

// ── Синхронизация от сервера ──────────────────────────────────────────────────
export function applyMusicState(
  trackIdx: number,
  startedAt: number,
  syncServerNow?: number,
  syncClientReceivedAt = Date.now(),
) {
  const { audio, ctx } = getAudioGraph()
  if (_tracks.length === 0) return
  const nextTrackIdx = ((trackIdx % _tracks.length) + _tracks.length) % _tracks.length

  if (typeof syncServerNow === 'number') {
    rememberBroadcastServerTime(syncServerNow, syncClientReceivedAt)
  }
  _musicTimeline = { trackIdx: nextTrackIdx, startedAt }

  const blockedByExternalOwner = hasActiveExternalMusicOutputOwner()
  if (blockedByExternalOwner) suspendLocalAudioForExternalOwner()
  if (!blockedByExternalOwner && !shouldSuspendHiddenAudioWithoutAccess()) void resumeAudioContext(ctx)

  if (_currentTrackIdx !== nextTrackIdx) {
    // Новый трек — загружаем и встаём на нужную позицию
    _currentTrackIdx = nextTrackIdx
    _trackBpmEstimator?.reset()
    _lastKnownBpm = null
    const syncAtStart = () => {
      if (!ensureTimelineAlignedBeforePlayback(true)) return
      void ensureMainTrackAudioRoute()
    }
    audio.addEventListener('loadedmetadata', syncAtStart, { once: true })
    audio.addEventListener('canplay', syncAtStart, { once: true })
    audio.src = _tracks[nextTrackIdx]
    audio.load()
    updateMediaSession(audio.paused ? 'paused' : 'playing')
    dispatchMusicBpm()
  } else {
    dispatchMusicBpm()
    // Тот же трек — только коррекция дрейфа
    const doSync = () => {
      if (hasPendingForcedTimelineSeek()) {
        if (alignMusicToTimeline(true)) clearPendingForcedTimelineSeek()
      } else {
        alignMusicToTimelineGently()
      }
      void ensureMainTrackAudioRoute()
    }
    if (audio.readyState >= 3) {
      doSync()
    } else {
      audio.addEventListener('canplay', doSync, { once: true })
      playTimelineAudio()
    }
  }
}

// ── Компонент ─────────────────────────────────────────────────────────────────
export default function MusicPlayer() {
  const location = useLocation()
  const audioRoute = location.pathname === '/outside' || location.pathname === '/club'
  const volume = useAudioStore((state) => state.masterVolume)
  const [started, setStarted] = useState(false)
  const [resumeRequired, setResumeRequired] = useState(false)
  const [djLive, setDjLive] = useState(false)
  const [djBlocked, setDjBlocked] = useState(false)
  const unlockedRef = useRef(false)

  const enableAudio = async () => {
    _hiddenSuspendedWithoutLockscreenAccess = false
    preferPlaybackAudioSession()
    void requestScreenWakeLock()
    const { audio, ctx } = getAudioGraph()
    takeMusicOutputOwnership()
    stopLockscreenAudio(true)
    if (!(await ensureAudioContextRunning(ctx))) return false
    await ensurePlayableMusicTimeline()
    syncTimelineFromAuthoritativeTrackState()
    if (!audio.src && _musicTimeline) {
      _currentTrackIdx = -1
      applyMusicState(_musicTimeline.trackIdx, _musicTimeline.startedAt)
    }
    await startDjAudioElement()

    if (shouldUseServerDjSource()) {
      if (!isAudioContextRunning(ctx)) return false
      suspendLocalTrackForDj()
      const ready = shouldUseDjOutput()
      setStarted(ready)
      setResumeRequired(!ready)
      return ready
    }
    if (!audio.src) return false

    try {
      await waitForCanPlay(audio)
      syncTimelineFromAuthoritativeTrackState()
      alignMusicToTimeline(true)
      await audio.play()
      if (!(await ensureAudioContextRunning(ctx))) return false
      alignMusicToTimeline(true)
      if (shouldKeepNativeLockscreenAudio()) {
        const nativeReady = await playLockscreenAudio(true)
        if (nativeReady) {
          setStarted(true)
          return true
        }
      }
      void primeLockscreenAudio()
      setStarted(true)
      setResumeRequired(false)
      return true
    } catch {
      return false
    }
  }

  useEffect(() => {
    const { audio } = getAudioGraph()
    void refreshMusicTracks()

    const handleExternalMusicOutputOwner = (record: MusicOutputOwnerRecord | null) => {
      if (!isFreshMusicOutputOwner(record) || record!.ownerId === _musicOutputTabId) return
      rememberMusicOutputOwner(record)
      stopMusicOutputOwnerHeartbeat()
      suspendLocalAudioForExternalOwner()
      setStarted(false)
      setResumeRequired(false)
    }
    if (typeof BroadcastChannel !== 'undefined') {
      _musicOutputOwnerChannel?.close()
      _musicOutputOwnerChannel = new BroadcastChannel(MUSIC_OUTPUT_OWNER_CHANNEL)
      _musicOutputOwnerChannel.onmessage = (event) => {
        handleExternalMusicOutputOwner(parseMusicOutputOwnerRecord(event.data))
      }
    }
    const onMusicOutputOwnerStorage = (event: StorageEvent) => {
      if (event.key !== MUSIC_OUTPUT_OWNER_STORAGE_KEY) return
      handleExternalMusicOutputOwner(parseMusicOutputOwnerRecord(event.newValue))
    }
    const onSync = (e: Event) => {
      const { trackIdx, startedAt, serverNow, clientReceivedAt } = (e as CustomEvent).detail
      applyMusicState(trackIdx, startedAt, serverNow, clientReceivedAt)
    }
    let restoreTimers: number[] = []
    const clearRestoreTimers = () => {
      restoreTimers.forEach((timer) => window.clearTimeout(timer))
      restoreTimers = []
    }
    const restoreAfterFreshServerSync = () => {
      if (shouldIgnoreHiddenAudioEvents()) return
      if (isDocumentHidden() || !_audioRouteActive) return
      if (!hasPendingForcedTimelineSeek() && !needsMainTrackAudioRouteRestore()) return
      syncTimelineFromAuthoritativeTrackState(true)
      forceAlignMusicToTimelineAfterInterruptedRoute()
      void ensureMainTrackAudioRoute().then((ok) => {
        if (!ok) return
        clearRestoreTimers()
        _hiddenSuspendedWithoutLockscreenAccess = false
        setStarted(true)
        setResumeRequired(false)
      })
    }
    const onServerMusicState = (e: Event) => {
      const { musicState, serverNow, clientReceivedAt } = (e as CustomEvent).detail ?? {}
      applyServerMusicState(musicState, serverNow, clientReceivedAt)
      restoreAfterFreshServerSync()
      const serverDj = shouldUseServerDjSource()
      setDjLive(serverDj)
      setDjBlocked(serverDj && !shouldUseDjOutput())
      if (serverDj) {
        const ready = shouldUseDjOutput() && !hasActiveExternalMusicOutputOwner()
        setStarted(ready)
        setResumeRequired(!ready)
        return
      }
      if (_audio && !_audio.paused) setResumeRequired(false)
    }
    const onEnvironment = (e: Event) => {
      const { environment, outsideDoorProximity } = (e as CustomEvent).detail
      if (environment === 'club' || environment === 'outside') {
        setMusicEnvironment(environment, outsideDoorProximity)
        const now = Date.now()
        if (
          environment === 'outside' &&
          needsMainTrackAudioRouteRestore() &&
          (now - _lastOutsideRouteEnsureAt >= OUTSIDE_ROUTE_ENSURE_INTERVAL_MS || _hiddenSuspendedWithoutLockscreenAccess)
        ) {
          _lastOutsideRouteEnsureAt = now
          void ensureMainTrackAudioRoute().then((ok) => {
            if (ok) setStarted(true)
          })
        }
      }
    }
    const onServerTime = (e: Event) => {
      const { clientSentAt, serverNow, clientReceivedAt, musicState } = (e as CustomEvent).detail ?? {}
      if (
        typeof clientSentAt !== 'number' ||
        typeof serverNow !== 'number' ||
        typeof clientReceivedAt !== 'number'
      ) return
      rememberServerTimeSample(clientSentAt, serverNow, clientReceivedAt)
      if (musicState) applyServerMusicState(musicState, serverNow, clientReceivedAt)
      alignMusicToTimeline()
      if (musicState) restoreAfterFreshServerSync()
    }
    const onDjState = (e: Event) => {
      const { active, blocked } = (e as CustomEvent).detail ?? {}
      const serverDj = shouldUseServerDjSource()
      setDjLive(serverDj)
      setDjBlocked(serverDj && Boolean(blocked || !shouldUseDjOutput()))
      if (serverDj && active && !blocked) {
        setStarted(!hasActiveExternalMusicOutputOwner())
        return
      }
      if (serverDj) {
        setStarted(false)
        setResumeRequired(true)
        return
      }
      if (active || blocked) {
        void ensureMainTrackAudioRoute().then((ok) => {
          if (ok) setStarted(true)
        })
      }
    }
    const restoreMainAudio = async () => {
      if (isDocumentHidden() || !_audioRouteActive) return
      if (!ensureMusicOutputOwnership()) {
        suspendLocalAudioForExternalOwner()
        return
      }
      if (shouldWaitForFreshResumeMusicState()) return
      syncTimelineFromAuthoritativeTrackState(true)
      forceAlignMusicToTimelineAfterInterruptedRoute()
      if (_audio?.src) alignMusicToTimeline(true)
      const wasHiddenSuspendedWithoutAccess = _hiddenSuspendedWithoutLockscreenAccess
      if (wasHiddenSuspendedWithoutAccess) {
        _hiddenSuspendedWithoutLockscreenAccess = false
        stopLockscreenAudio(false)
        _hiddenSuspendedWithoutLockscreenAccess = true
      }
      const finishMainTrackRestore = (ok: boolean) => {
        if (ok) {
          clearRestoreTimers()
          _hiddenSuspendedWithoutLockscreenAccess = false
          setStarted(true)
          setResumeRequired(false)
          return
        }
        if (!isDocumentHidden()) setResumeRequired(true)
      }
      preferPlaybackAudioSession()
      void requestScreenWakeLock()
      if (shouldUseServerDjSource()) {
        stopLockscreenAudio(true)
        connectDjSpeaker()
        const ctxReady = await ensureAudioContextRunning(_ctx)
        await startDjAudioElement()
        applyOutputState()
        const ready = ctxReady && shouldUseDjOutput()
        if (ready) _hiddenSuspendedWithoutLockscreenAccess = false
        setStarted(ready)
        setResumeRequired(!ready)
        return
      }
      if (!_lockscreenActive && !needsMainTrackAudioRouteRestore()) {
        forceAlignMusicToTimelineAfterInterruptedRoute()
        if (_audio?.src) alignMusicToTimeline(true)
        finishMainTrackRestore(Boolean(_audio && !_audio.paused))
        return
      }
      if (!_lockscreenActive) {
        const ok = await ensureMainTrackAudioRoute()
        if (!ok) applyOutputState()
        finishMainTrackRestore(ok)
        return
      }
      const wasDjLockscreen = _lockscreenSource === 'dj'
      if (wasDjLockscreen) {
        stopLockscreenAudio(true)
        await ensureAudioContextRunning(_ctx)
        await startDjAudioElement()
      } else {
        const ok = await restoreTrackAudioFromLockscreen()
        finishMainTrackRestore(ok)
      }
      applyOutputState()
    }
    const scheduleMainAudioRestore = () => {
      clearRestoreTimers()
      MUSIC_RESTORE_RETRY_DELAYS_MS.forEach((delay) => {
        const timer = window.setTimeout(() => {
          void restoreMainAudio()
        }, delay)
        restoreTimers.push(timer)
      })
    }
    const claimAndScheduleMainAudioRestore = () => {
      if (shouldIgnoreHiddenAudioEvents()) return
      if (_audioRouteActive) takeMusicOutputOwnership()
      requestFreshResumeMusicState()
      scheduleMainAudioRestore()
    }
    const onVoiceCaptureAudioState = (event: Event) => {
      const active = Boolean((event as CustomEvent).detail?.active)
      if (active) {
        void ensureAudioContextRunning(_ctx)
        applyOutputState()
        return
      }
      scheduleMainAudioRestore()
    }
    const useLockscreenAudio = () => {
      if (shouldIgnoreHiddenAudioEvents()) {
        applyOutputState()
        return
      }
      markMusicTimelineInterrupted()
      if (hasActiveExternalMusicOutputOwner()) {
        suspendLocalAudioForExternalOwner()
        return
      }
      if (shouldKeepMainTrackRouteWhileHidden()) {
        syncTimelineFromAuthoritativeTrackState(true)
        if (_audio?.src) alignMusicToTimeline(true)
        applyOutputState()
        return
      }
      if (!hasLockscreenMusicAccess()) {
        suspendHiddenAudioWithoutAccess()
        setStarted(false)
        setResumeRequired(false)
        return
      }
      preferPlaybackAudioSession()
      if (shouldUseServerDjSource()) {
        void playLockscreenDjAudio()
        return
      }
      if (!_audio?.src) return
      if (_audio.paused && !(_lockscreenActive && _lockscreenSource === 'track')) return
      void playLockscreenAudio(true)
    }
    const onVisibilityChange = () => {
      if (shouldIgnoreHiddenAudioEvents()) return
      if (document.visibilityState === 'hidden') {
        markMusicTimelineInterrupted()
        useLockscreenAudio()
      } else {
        markMusicTimelineInterrupted()
        requestFreshResumeMusicState()
        claimAndScheduleMainAudioRestore()
      }
    }
    window.addEventListener('storage', onMusicOutputOwnerStorage)
    window.addEventListener('music-sync', onSync)
    window.addEventListener(MUSIC_SERVER_STATE_EVENT, onServerMusicState)
    window.addEventListener('music-environment', onEnvironment)
    window.addEventListener('server-time', onServerTime)
    window.addEventListener('dj-stream-state', onDjState)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', useLockscreenAudio)
    window.addEventListener('pageshow', claimAndScheduleMainAudioRestore)
    window.addEventListener('focus', claimAndScheduleMainAudioRestore)
    document.addEventListener('resume', scheduleMainAudioRestore)
    window.addEventListener(VOICE_CAPTURE_AUDIO_STATE_EVENT, onVoiceCaptureAudioState)

    const unlock = () => {
      if (!_audioRouteActive) return
      takeMusicOutputOwnership()
      const serverDj = shouldUseServerDjSource()
      const hasActiveAudio = serverDj
        ? shouldUseDjOutput() && isAudioContextRunning(_ctx)
        : Boolean(_audio && !_audio.paused && isAudioContextRunning(_ctx))
      const hasNativeLockscreenRoute = _lockscreenActive && _lockscreenSource === 'track' && Boolean(_lockscreenAudio && !_lockscreenAudio.paused)
      if (unlockedRef.current && !_hiddenSuspendedWithoutLockscreenAccess && (hasActiveAudio || hasNativeLockscreenRoute)) return
      void enableAudio().then((ok) => {
        if (ok) {
          unlockedRef.current = true
          setResumeRequired(false)
        } else if (!isDocumentHidden()) {
          setResumeRequired(true)
        }
      })
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('pointerup', unlock, true)
    window.addEventListener('touchstart', unlock, { capture: true, passive: true })
    window.addEventListener('touchend', unlock, { capture: true, passive: true })
    window.addEventListener('click', unlock, true)
    window.addEventListener('keydown',     unlock, true)

    const onPlay = () => {
      if (hasActiveExternalMusicOutputOwner()) {
        suspendLocalAudioForExternalOwner()
        setStarted(false)
        return
      }
      setStarted(true)
    }
    audio.addEventListener('play', onPlay)
    const syncTimer = window.setInterval(() => alignMusicToTimeline(), MUSIC_SYNC_INTERVAL_MS)
    const manifestTimer = window.setInterval(() => void refreshMusicTracks(), MUSIC_MANIFEST_REFRESH_MS)
    const bpmAnalysisTimer = window.setInterval(sampleMusicBpm, BPM_ANALYSIS_INTERVAL_MS)
    const bpmTimer = window.setInterval(dispatchMusicBpm, BPM_BROADCAST_INTERVAL_MS)
    dispatchMusicBpm()

    return () => {
      window.removeEventListener('music-sync', onSync)
      window.removeEventListener('storage', onMusicOutputOwnerStorage)
      window.removeEventListener(MUSIC_SERVER_STATE_EVENT, onServerMusicState)
      window.removeEventListener('music-environment', onEnvironment)
      window.removeEventListener('server-time', onServerTime)
      window.removeEventListener('dj-stream-state', onDjState)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', useLockscreenAudio)
      window.removeEventListener('pageshow', claimAndScheduleMainAudioRestore)
      window.removeEventListener('focus', claimAndScheduleMainAudioRestore)
      document.removeEventListener('resume', scheduleMainAudioRestore)
      window.removeEventListener(VOICE_CAPTURE_AUDIO_STATE_EVENT, onVoiceCaptureAudioState)
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('pointerup', unlock, true)
      window.removeEventListener('touchstart', unlock, true)
      window.removeEventListener('touchend', unlock, true)
      window.removeEventListener('click', unlock, true)
      window.removeEventListener('keydown',     unlock, true)
      audio.removeEventListener('play', onPlay)
      clearRestoreTimers()
      window.clearInterval(syncTimer)
      window.clearInterval(manifestTimer)
      window.clearInterval(bpmAnalysisTimer)
      window.clearInterval(bpmTimer)
      shutdownMusicAudioSingleton()
    }
  }, [])

  useEffect(() => {
    setScreenWakeLockWanted(audioRoute)
    if (!audioRoute) return

    const onWakeVisibility = () => {
      if (document.visibilityState === 'visible') void requestScreenWakeLock()
      else releaseScreenWakeLock()
    }
    const onWakeGesture = () => {
      void requestScreenWakeLock()
    }

    document.addEventListener('visibilitychange', onWakeVisibility)
    window.addEventListener('pointerdown', onWakeGesture, true)
    window.addEventListener('touchstart', onWakeGesture, { capture: true, passive: true })
    window.addEventListener('keydown', onWakeGesture, true)
    return () => {
      document.removeEventListener('visibilitychange', onWakeVisibility)
      window.removeEventListener('pointerdown', onWakeGesture, true)
      window.removeEventListener('touchstart', onWakeGesture, true)
      window.removeEventListener('keydown', onWakeGesture, true)
      setScreenWakeLockWanted(false)
    }
  }, [audioRoute])

  useEffect(() => {
    _audioRouteActive = audioRoute
    if (!audioRoute) {
      getAudioGraph().audio.pause()
      stopLockscreenAudio(false)
      disconnectLiveKitDjRoom()
      releaseMusicOutputOwnership()
      setStarted(false)
      setResumeRequired(false)
      setDjLive(false)
      setDjBlocked(false)
      return
    }

    if (!isDocumentHidden()) takeMusicOutputOwnership()
    setMusicEnvironment(location.pathname === '/club' ? 'club' : 'outside')
    if (shouldUseServerDjSource()) {
      suspendLocalTrackForDj()
      void startDjAudioElement().then(() => {
        setStarted(shouldUseDjOutput())
        setDjLive(true)
        setDjBlocked(!shouldUseDjOutput())
      })
      return
    }
    void ensureMainTrackAudioRoute().then((ok) => {
      if (ok) setStarted(true)
    })
  }, [audioRoute, location.pathname])

  useEffect(() => {
    if (!audioRoute) return

    let cancelled = false
    connectLiveKitDjRoom().catch((e) => {
      if (!cancelled) console.warn('LiveKit DJ stream unavailable:', e?.message || e)
    })

    return () => { cancelled = true }
  }, [audioRoute, location.pathname])

  // Громкость через GainNode — не затрагивает currentTime
  useEffect(() => {
    _volume = volume
    applyOutputState()
  }, [volume])

  if (!audioRoute) return null

  const needsAudioAttention = resumeRequired || (!started && !djLive) || djBlocked
  const playerLabel = djLive
    ? djBlocked ? 'DJ OFF' : 'DJ'
    : started ? 'MUSIC' : 'MUSIC OFF'
  const playerColor = needsAudioAttention
    ? '#ffb84d'
    : djLive
    ? djBlocked ? '#ffb84d' : '#00e676'
    : started ? '#e040fb' : '#666'
  const playerTop = 'calc(env(safe-area-inset-top, 0px) + 72px)'
  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: playerTop,
          right: 14,
          width: 64,
          minWidth: 64,
          minHeight: 28,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          background: 'rgba(13,13,26,0.7)', border: '1px solid #1a1a2e',
          borderRadius: 8, padding: '5px 9px',
          fontFamily: 'monospace', zIndex: 260, pointerEvents: 'none',
          cursor: 'default',
        }}
        aria-label={playerLabel}
      >
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: playerColor,
          boxShadow: djLive && !djBlocked ? '0 0 10px #00e676' : 'none',
        }} />
        <span style={{
          flex: '0 0 auto',
          fontSize: 9,
          color: playerColor,
          userSelect: 'none',
          letterSpacing: 0.8,
          fontWeight: 700,
        }}>
          {playerLabel}
        </span>
      </div>
    </>
  )
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    shutdownMusicAudioSingleton()
  })
}
