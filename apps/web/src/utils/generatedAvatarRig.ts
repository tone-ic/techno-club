import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'

export interface GeneratedAvatarRig {
  root: THREE.Object3D
  reset: () => void
  idle: (t: number, intensity?: number) => void
  walk: (t: number) => void
  dance: (t: number, moveFeet?: boolean, feetT?: number, danceId?: GeneratedDanceId, intensity?: number) => void
  talk: (talking: boolean, t: number, intensity?: number) => void
}

export type GeneratedDanceId =
  | 'dance_idle_groove_01'
  | 'dance_side_step_turn_02'
  | 'dance_head_touch_groove_03'
  | 'dance_hip_hop_fbx'

interface GeneratedAvatarRigOptions {
  rotationY?: number
  targetHeight?: number
}

interface RigBounds {
  box: THREE.Box3
  size: THREE.Vector3
  center: THREE.Vector3
  height: number
  width: number
  depth: number
  frontSign: 1 | -1
}

interface RigBones {
  root: THREE.Bone
  hips: THREE.Bone
  spine: THREE.Bone
  head: THREE.Bone
  jaw: THREE.Bone
  leftLeg: THREE.Bone
  rightLeg: THREE.Bone
  leftArm: THREE.Bone
  rightArm: THREE.Bone
}

const BONE_INDEX = {
  root: 0,
  hips: 1,
  spine: 2,
  head: 3,
  jaw: 4,
  leftLeg: 5,
  rightLeg: 6,
  leftArm: 7,
  rightArm: 8,
} as const

const LIMB_WEIGHT = 1
const TAU = Math.PI * 2
const NORMAL_POSITION_SCALE = 10_000
const GENERATED_ARM_REST_Z = 0.26
const GENERATED_ARM_IDLE_SWAY_Z = 0.014
const GENERATED_ARM_WALK_SWAY_Z = 0.024
const HIP_HOP_DANCE_URL = '/animations/hip-hop-dancing.fbx'
const HIP_HOP_DANCE_BEATS = 16
const FBX_POSITION_SCALE = 0.01
const VERTICAL_ALIGNMENT_MAX_POINTS = 12_000
const VERTICAL_ALIGNMENT_MIN_RADIANS = THREE.MathUtils.degToRad(2)
const VERTICAL_ALIGNMENT_MAX_RADIANS = THREE.MathUtils.degToRad(35)
const DANCE_BEATS: Record<GeneratedDanceId, number> = {
  dance_idle_groove_01: 8,
  dance_side_step_turn_02: 14,
  dance_head_touch_groove_03: 24,
  dance_hip_hop_fbx: HIP_HOP_DANCE_BEATS,
}
let hipHopClipPromise: Promise<THREE.AnimationClip | null> | null = null

interface GeneratedDanceRuntime {
  mixer: THREE.AnimationMixer
  actions: Record<GeneratedDanceId, THREE.AnimationAction>
  activeDance: GeneratedDanceId | null
}

type PreRiggedClipId = 'idle' | 'walk' | GeneratedDanceId

interface BaseTransform {
  object: THREE.Object3D
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
}

interface PreRiggedAvatarRuntime {
  mixer: THREE.AnimationMixer
  actions: Partial<Record<PreRiggedClipId, THREE.AnimationAction>>
  activeClip: PreRiggedClipId | null
  hipHopAction: THREE.AnimationAction | null
  hipHopLoading: Promise<void> | null
  hipHopFailed: boolean
  baseTransforms: BaseTransform[]
  baseX: number
  baseY: number
  baseZ: number
  baseRotationY: number
  isDoorclubAutoRig: boolean
  hips: THREE.Object3D | null
  spine: THREE.Object3D | null
  head: THREE.Object3D | null
  jaw: THREE.Object3D | null
  leftThigh: THREE.Object3D | null
  rightThigh: THREE.Object3D | null
  leftShin: THREE.Object3D | null
  rightShin: THREE.Object3D | null
  leftUpperArm: THREE.Object3D | null
  rightUpperArm: THREE.Object3D | null
  leftForearm: THREE.Object3D | null
  rightForearm: THREE.Object3D | null
  morphTargets: Array<THREE.SkinnedMesh | THREE.Mesh>
}

export async function loadGeneratedAvatarRig(
  modelUrl: string,
  options: GeneratedAvatarRigOptions = {},
): Promise<GeneratedAvatarRig> {
  const loader = new GLTFLoader()
  loader.setCrossOrigin('anonymous')
  const gltf = await loader.loadAsync(modelUrl)
  return createAvatarRigFromGltf(gltf.scene, gltf.animations ?? [], options)
}

export function createAvatarRigFromGltf(
  model: THREE.Object3D,
  animations: THREE.AnimationClip[] = [],
  options: GeneratedAvatarRigOptions = {},
): GeneratedAvatarRig {
  return hasEmbeddedRig(model, animations)
    ? createPreRiggedAvatarRig(model, animations, options)
    : createGeneratedAvatarRig(model, options)
}

export function createGeneratedAvatarRig(
  model: THREE.Object3D,
  options: GeneratedAvatarRigOptions = {},
): GeneratedAvatarRig {
  model.userData.isGeneratedModel = true
  model.rotation.y = options.rotationY ?? 0
  applyGeneratedModelMaterialPass(model)
  fitGeneratedModelToWorld(model, options.targetHeight ?? 2.15)

  const bounds = getRigBounds(model)
  const bones = createBones(bounds)
  model.add(bones.root)
  model.updateWorldMatrix(true, true)

  const skeleton = new THREE.Skeleton([
    bones.root,
    bones.hips,
    bones.spine,
    bones.head,
    bones.jaw,
    bones.leftLeg,
    bones.rightLeg,
    bones.leftArm,
    bones.rightArm,
  ])

  const morphTargets: Array<THREE.SkinnedMesh | THREE.Mesh> = []
  const skinnedMeshes = autoSkinModel(model, skeleton, bounds, morphTargets)
  const baseX = model.position.x
  const baseY = model.position.y
  const baseZ = model.position.z
  const baseRotationY = model.rotation.y
  model.userData.baseX = baseX
  model.userData.baseY = baseY
  model.userData.baseZ = baseZ
  model.userData.generatedSkeleton = skeleton
  model.userData.generatedBones = bones
  model.userData.generatedSkinnedMeshes = skinnedMeshes
  const tuckGeneratedArms = (leftSway = 0, rightSway = -leftSway) => {
    bones.leftArm.rotation.z = GENERATED_ARM_REST_Z + leftSway
    bones.rightArm.rotation.z = -GENERATED_ARM_REST_Z + rightSway
  }

  const resetBones = () => {
    Object.values(bones).forEach((bone) => {
      bone.rotation.set(0, 0, 0)
      bone.position.x = bone.userData.baseX ?? bone.position.x
      bone.position.y = bone.userData.baseY ?? bone.position.y
      bone.position.z = bone.userData.baseZ ?? bone.position.z
    })
    setJawOpen(morphTargets, 0)
  }
  const danceRuntime = createGeneratedDanceRuntime(model, bones, bounds)

  const rig: GeneratedAvatarRig = {
    root: model,
    reset: () => {
      stopGeneratedDance(danceRuntime)
      model.position.set(baseX, baseY, baseZ)
      model.rotation.x = 0
      model.rotation.y = baseRotationY
      model.rotation.z = 0
      resetBones()
    },
    idle: (t: number, intensity = 1) => {
      stopGeneratedDance(danceRuntime)
      resetBones()
      const amount = Math.max(0, Math.min(1, intensity))
      const pulse = Math.sin(t)
      const side = Math.sin(t * 0.5)
      model.position.set(baseX, baseY + (0.004 + Math.max(0, pulse) * 0.006) * amount, baseZ)
      model.rotation.x = 0
      model.rotation.y = baseRotationY
      model.rotation.z = side * 0.006 * amount
      bones.hips.rotation.y = side * 0.018 * amount
      bones.spine.rotation.x = (0.012 + pulse * 0.01) * amount
      bones.spine.rotation.z = -side * 0.016 * amount
      bones.head.rotation.x = pulse * 0.015 * amount
      bones.head.rotation.z = side * 0.012 * amount
      bones.leftArm.rotation.x = Math.sin(t + Math.PI) * 0.04 * amount
      bones.rightArm.rotation.x = Math.sin(t) * 0.04 * amount
      tuckGeneratedArms(GENERATED_ARM_IDLE_SWAY_Z * amount, -GENERATED_ARM_IDLE_SWAY_Z * amount)
    },
    walk: (t: number) => {
      stopGeneratedDance(danceRuntime)
      resetBones()
      model.position.set(baseX, baseY + Math.abs(Math.sin(t)) * 0.012, baseZ)
      model.rotation.x = 0
      model.rotation.y = baseRotationY
      model.rotation.z = 0
      bones.leftLeg.rotation.x = Math.sin(t) * 0.095
      bones.rightLeg.rotation.x = Math.sin(t + Math.PI) * 0.095
      bones.leftLeg.rotation.z = Math.sin(t + Math.PI / 2) * 0.01
      bones.rightLeg.rotation.z = Math.sin(t - Math.PI / 2) * 0.01
      bones.leftArm.rotation.x = Math.sin(t + Math.PI) * 0.28
      bones.rightArm.rotation.x = Math.sin(t) * 0.28
      tuckGeneratedArms(
        Math.sin(t + Math.PI / 2) * GENERATED_ARM_WALK_SWAY_Z,
        Math.sin(t - Math.PI / 2) * GENERATED_ARM_WALK_SWAY_Z,
      )
      bones.head.rotation.x = Math.sin(t * 0.5) * 0.035
      bones.head.rotation.z = Math.sin(t * 0.5 + Math.PI / 2) * 0.025
    },
    dance: (
      t: number,
      moveFeet = false,
      feetT = t * 0.5,
      danceId: GeneratedDanceId = 'dance_idle_groove_01',
      intensity = 1,
    ) => {
      const amount = clamp(intensity, 0, 1)
      if (amount <= 0.001) {
        stopGeneratedDance(danceRuntime)
        model.position.set(baseX, baseY, baseZ)
        model.rotation.x = 0
        model.rotation.y = baseRotationY
        model.rotation.z = 0
        resetBones()
        return
      }

      model.rotation.x = 0
      model.rotation.y = baseRotationY
      model.rotation.z = 0
      const beat = t / TAU
      const duration = DANCE_BEATS[danceId]
      const localBeat = ((beat % duration) + duration) % duration
      model.position.set(baseX, baseY + (moveFeet ? Math.max(0, Math.sin(feetT * 2)) * 0.018 * amount : 0), baseZ)
      resetBones()
      applyGeneratedDance(danceRuntime, danceId, localBeat)
      scaleGeneratedBonePose(bones, amount)
    },
    talk: (talking: boolean, t: number, intensity = 1) => {
      const amount = clamp(intensity, 0, 1)
      const openness = talking ? (0.35 + Math.max(0, Math.sin(t * 4)) * 0.65) * amount : 0
      bones.jaw.rotation.x = openness * 0.18
      bones.jaw.position.y = (bones.jaw.userData.baseY ?? bones.jaw.position.y) - openness * bounds.height * 0.008
      setJawOpen(morphTargets, openness)
    },
  }

  model.userData.generatedRig = rig
  return rig
}

function hasEmbeddedRig(model: THREE.Object3D, animations: THREE.AnimationClip[]): boolean {
  let hasSkinnedMesh = false
  model.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) hasSkinnedMesh = true
  })
  if (!hasSkinnedMesh && animations.length > 0) {
    console.warn('[Avatar rig] Embedded animations found without skinned meshes; falling back to client auto-skin')
  }
  return hasSkinnedMesh
}

function createPreRiggedAvatarRig(
  model: THREE.Object3D,
  animations: THREE.AnimationClip[],
  options: GeneratedAvatarRigOptions = {},
): GeneratedAvatarRig {
  model.userData.isGeneratedModel = true
  model.userData.isPreRiggedModel = true
  model.rotation.y = options.rotationY ?? 0
  applyGeneratedModelMaterialPass(model)
  fitGeneratedModelToWorld(model, options.targetHeight ?? 2.15, { alignVertical: false })
  model.updateWorldMatrix(true, true)
  const mixer = new THREE.AnimationMixer(model)

  const runtime: PreRiggedAvatarRuntime = {
    mixer,
    actions: createPreRiggedActions(mixer, animations),
    activeClip: null,
    hipHopAction: null,
    hipHopLoading: null,
    hipHopFailed: false,
    baseTransforms: captureBaseTransforms(model),
    baseX: model.position.x,
    baseY: model.position.y,
    baseZ: model.position.z,
    baseRotationY: model.rotation.y,
    isDoorclubAutoRig: isDoorclubAutoRig(model, animations),
    hips: findRigNode(model, ['hips']),
    spine: findRigNode(model, ['spine', 'chest']),
    head: findRigNode(model, ['head', 'neck']),
    jaw: findRigNode(model, ['jaw', 'mouth']),
    leftThigh: findRigNodeByWords(model, [['thigh', 'l'], ['thigh', 'left'], ['upper', 'leg', 'left'], ['leg', 'l']]),
    rightThigh: findRigNodeByWords(model, [['thigh', 'r'], ['thigh', 'right'], ['upper', 'leg', 'right'], ['leg', 'r']]),
    leftShin: findRigNodeByWords(model, [['shin', 'l'], ['shin', 'left'], ['lower', 'leg', 'left'], ['calf', 'left']]),
    rightShin: findRigNodeByWords(model, [['shin', 'r'], ['shin', 'right'], ['lower', 'leg', 'right'], ['calf', 'right']]),
    leftUpperArm: findRigNodeByWords(model, [['upper', 'arm', 'l'], ['upper', 'arm', 'left'], ['arm', 'left'], ['left', 'arm'], ['arm', 'l']]),
    rightUpperArm: findRigNodeByWords(model, [['upper', 'arm', 'r'], ['upper', 'arm', 'right'], ['arm', 'right'], ['right', 'arm'], ['arm', 'r']]),
    leftForearm: findRigNodeByWords(model, [['forearm', 'l'], ['forearm', 'left'], ['lower', 'arm', 'left'], ['left', 'forearm']]),
    rightForearm: findRigNodeByWords(model, [['forearm', 'r'], ['forearm', 'right'], ['lower', 'arm', 'right'], ['right', 'forearm']]),
    morphTargets: collectMorphTargets(model),
  }
  void ensureHipHopDanceAction(runtime)

  const stopAndRestore = () => {
    stopPreRiggedAnimation(runtime)
    model.position.set(runtime.baseX, runtime.baseY, runtime.baseZ)
    model.rotation.x = 0
    model.rotation.y = runtime.baseRotationY
    model.rotation.z = 0
  }

  const rig: GeneratedAvatarRig = {
    root: model,
    reset: stopAndRestore,
    idle: (t: number, intensity = 1) => {
      const amount = Math.max(0, Math.min(1, intensity))
      if (runtime.isDoorclubAutoRig && applyPreRiggedClip(runtime, 'idle', t, 8, amount)) return
      resetPreRiggedPose(runtime)
      const root = runtime.mixer.getRoot() as THREE.Object3D
      const pulse = Math.sin(t)
      const side = Math.sin(t * 0.5)
      root.position.set(runtime.baseX, runtime.baseY + (0.004 + Math.max(0, pulse) * 0.006) * amount, runtime.baseZ)
      root.rotation.x = 0
      root.rotation.y = runtime.baseRotationY
      root.rotation.z = side * 0.006 * amount
      addEuler(runtime.hips, 0, side * 0.018 * amount, side * 0.01 * amount)
      addEuler(runtime.spine, (0.012 + pulse * 0.01) * amount, side * 0.02 * amount, -side * 0.016 * amount)
      addEuler(runtime.head, pulse * 0.015 * amount, side * 0.026 * amount, side * 0.012 * amount)
      applyPreRiggedArmTuck(runtime, amount)
      addEuler(runtime.leftUpperArm, Math.sin(t + Math.PI) * 0.05 * amount, 0, 0.025 * amount)
      addEuler(runtime.rightUpperArm, Math.sin(t) * 0.05 * amount, 0, -0.025 * amount)
    },
    walk: (t: number) => {
      model.position.set(runtime.baseX, runtime.baseY, runtime.baseZ)
      model.rotation.x = 0
      model.rotation.y = runtime.baseRotationY
      model.rotation.z = 0
      if (runtime.isDoorclubAutoRig && applyPreRiggedClip(runtime, 'walk', t, 2)) return
      applyPreRiggedProceduralWalk(runtime, t)
    },
    dance: (
      t: number,
      moveFeet = false,
      feetT = t * 0.5,
      danceId: GeneratedDanceId = 'dance_idle_groove_01',
      intensity = 1,
    ) => {
      const amount = clamp(intensity, 0, 1)
      if (amount <= 0.001) {
        stopPreRiggedAnimation(runtime)
        model.position.set(runtime.baseX, runtime.baseY, runtime.baseZ)
        model.rotation.x = 0
        model.rotation.y = runtime.baseRotationY
        model.rotation.z = 0
        return
      }

      model.position.set(runtime.baseX, runtime.baseY + (moveFeet ? Math.max(0, Math.sin(feetT * 2)) * 0.018 * amount : 0), runtime.baseZ)
      model.rotation.x = 0
      model.rotation.y = runtime.baseRotationY
      model.rotation.z = 0
      if (danceId === 'dance_hip_hop_fbx' && applyPreRiggedHipHopDance(runtime, t, amount)) return
      if (runtime.isDoorclubAutoRig && applyPreRiggedClip(runtime, danceId, t, DANCE_BEATS[danceId], amount)) return
      applyPreRiggedProceduralDance(runtime, t, moveFeet, feetT, danceId)
      blendPreRiggedPoseWithBase(runtime, amount)
    },
    talk: (talking: boolean, t: number, intensity = 1) => {
      const amount = clamp(intensity, 0, 1)
      const openness = talking ? (0.35 + Math.max(0, Math.sin(t * 4)) * 0.65) * amount : 0
      if (runtime.jaw) {
        runtime.jaw.rotation.x = openness * 0.18
        runtime.jaw.position.y = (runtime.jaw.userData.baseY ?? runtime.jaw.position.y) - openness * 0.012
      } else if (runtime.head) {
        runtime.head.rotation.x += openness * 0.025
      }
      setJawOpen(runtime.morphTargets, openness)
    },
  }

  model.userData.generatedRig = rig
  return rig
}

function createPreRiggedActions(
  mixer: THREE.AnimationMixer,
  animations: THREE.AnimationClip[],
): Partial<Record<PreRiggedClipId, THREE.AnimationAction>> {
  const clips = {
    idle: findAnimationClip(animations, ['idle', 'standing', 'breathing']),
    walk: findAnimationClip(animations, ['walk', 'walking', 'locomotion']),
    dance_idle_groove_01:
      findAnimationClip(animations, ['groove']) ??
      findAnimationClip(animations, ['dance']) ??
      findAnimationClip(animations, ['idle', 'standing']),
    dance_side_step_turn_02:
      findAnimationClip(animations, ['side', 'step']) ??
      findAnimationClip(animations, ['dance']) ??
      animations[0],
    dance_head_touch_groove_03:
      findAnimationClip(animations, ['head', 'touch']) ??
      findAnimationClip(animations, ['gesture']) ??
      findAnimationClip(animations, ['dance']) ??
      animations[0],
  } satisfies Partial<Record<PreRiggedClipId, THREE.AnimationClip | undefined>>

  const actions: Partial<Record<PreRiggedClipId, THREE.AnimationAction>> = {}
  ;(Object.entries(clips) as Array<[PreRiggedClipId, THREE.AnimationClip | undefined]>).forEach(([id, clip]) => {
    if (!clip) return
    const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.clampWhenFinished = false
    action.enabled = true
    actions[id] = action
  })
  return actions
}

function findAnimationClip(animations: THREE.AnimationClip[], words: string[]): THREE.AnimationClip | undefined {
  return animations.find((clip) => {
    const name = clip.name.toLowerCase().replace(/[_-]+/g, ' ')
    return words.every((word) => name.includes(word))
  })
}

function stopPreRiggedAnimation(runtime: PreRiggedAvatarRuntime): void {
  if (runtime.activeClip) runtime.mixer.stopAllAction()
  runtime.activeClip = null
  restoreBaseTransforms(runtime.baseTransforms)
  setJawOpen(runtime.morphTargets, 0)
}

function captureBaseTransforms(root: THREE.Object3D): BaseTransform[] {
  const transforms: BaseTransform[] = []
  root.traverse((object) => {
    transforms.push({
      object,
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    })
    object.userData.baseX = object.position.x
    object.userData.baseY = object.position.y
    object.userData.baseZ = object.position.z
  })
  return transforms
}

function restoreBaseTransforms(transforms: BaseTransform[]): void {
  transforms.forEach(({ object, position, quaternion, scale }) => {
    object.position.copy(position)
    object.quaternion.copy(quaternion)
    object.scale.copy(scale)
  })
}

function collectMorphTargets(root: THREE.Object3D): Array<THREE.SkinnedMesh | THREE.Mesh> {
  const targets: Array<THREE.SkinnedMesh | THREE.Mesh> = []
  root.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh | THREE.Mesh
    if (mesh.isMesh && mesh.morphTargetInfluences?.length) targets.push(mesh)
  })
  return targets
}

function findRigNode(root: THREE.Object3D, words: string[]): THREE.Object3D | null {
  let match: THREE.Object3D | null = null
  root.traverse((obj) => {
    if (match) return
    const name = obj.name.toLowerCase()
    if (words.some((word) => name.includes(word))) match = obj
  })
  return match
}

function isDoorclubAutoRig(root: THREE.Object3D, animations: THREE.AnimationClip[]): boolean {
  const clipNames = new Set(animations.map((clip) => clip.name))
  if (
    clipNames.has('dance_idle_groove_01') ||
    clipNames.has('dance_side_step_turn_02') ||
    clipNames.has('dance_head_touch_groove_03')
  ) {
    return true
  }
  return hasRigNode(root, 'doorclub autorig') || (
    Boolean(findRigNodeByWords(root, [['thigh', 'l']])) &&
    Boolean(findRigNodeByWords(root, [['shin', 'l']])) &&
    Boolean(findRigNodeByWords(root, [['upper', 'arm', 'l']]))
  )
}

function hasRigNode(root: THREE.Object3D, word: string): boolean {
  let found = false
  root.traverse((obj) => {
    if (found) return
    found = normalizeRigName(obj.name).includes(normalizeRigName(word))
  })
  return found
}

function findRigNodeByWords(root: THREE.Object3D, candidates: string[][]): THREE.Object3D | null {
  let match: THREE.Object3D | null = null
  root.traverse((obj) => {
    if (match) return
    const name = normalizeRigName(obj.name)
    const compactName = name.replace(/\s+/g, '')
    if (candidates.some((words) => words.every((word) => {
      const normalizedWord = normalizeRigName(word)
      return name.split(' ').includes(normalizedWord) || compactName.includes(normalizedWord)
    }))) match = obj
  })
  return match
}

function normalizeRigName(name: string): string {
  return name.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function resetPreRiggedPose(runtime: PreRiggedAvatarRuntime): void {
  if (runtime.activeClip) runtime.mixer.stopAllAction()
  runtime.activeClip = null
  restoreBaseTransforms(runtime.baseTransforms)
  setJawOpen(runtime.morphTargets, 0)
}

function applyPreRiggedArmTuck(runtime: PreRiggedAvatarRuntime, amount = 1): void {
  const tuck = Math.max(0, Math.min(1, amount))
  addEuler(runtime.leftUpperArm, 0, -0.065 * tuck, 0.2 * tuck)
  addEuler(runtime.rightUpperArm, 0, 0.065 * tuck, -0.2 * tuck)
  addEuler(runtime.leftForearm, -0.045 * tuck, 0, 0.07 * tuck)
  addEuler(runtime.rightForearm, -0.045 * tuck, 0, -0.07 * tuck)
}

function applyPreRiggedProceduralWalk(runtime: PreRiggedAvatarRuntime, t: number): void {
  resetPreRiggedPose(runtime)
  runtime.mixer.update(0)
  const root = runtime.mixer.getRoot() as THREE.Object3D
  root.position.set(runtime.baseX, runtime.baseY + Math.abs(Math.sin(t)) * 0.018, runtime.baseZ)
  root.rotation.x = Math.sin(t) * 0.012
  root.rotation.z = Math.sin(t + Math.PI) * 0.012
  addEuler(runtime.leftThigh, Math.sin(t) * 0.18, 0, 0)
  addEuler(runtime.rightThigh, Math.sin(t + Math.PI) * 0.18, 0, 0)
  addEuler(runtime.leftShin, Math.max(0, -Math.sin(t)) * 0.14, 0, 0)
  addEuler(runtime.rightShin, Math.max(0, Math.sin(t)) * 0.14, 0, 0)
  applyPreRiggedArmTuck(runtime, 1)
  addEuler(runtime.leftUpperArm, Math.sin(t + Math.PI) * 0.38, 0, Math.sin(t + Math.PI / 2) * 0.045)
  addEuler(runtime.rightUpperArm, Math.sin(t) * 0.38, 0, Math.sin(t - Math.PI / 2) * 0.045)
  addEuler(runtime.leftForearm, Math.max(0, Math.sin(t + Math.PI)) * 0.1, 0, 0)
  addEuler(runtime.rightForearm, Math.max(0, Math.sin(t)) * 0.1, 0, 0)
}

function applyPreRiggedProceduralDance(
  runtime: PreRiggedAvatarRuntime,
  t: number,
  moveFeet: boolean,
  feetT: number,
  danceId: GeneratedDanceId,
): void {
  resetPreRiggedPose(runtime)
  const root = runtime.mixer.getRoot() as THREE.Object3D
  root.position.set(runtime.baseX, runtime.baseY + (moveFeet ? Math.max(0, Math.sin(feetT * 2)) * 0.014 : 0), runtime.baseZ)
  const side = Math.sin(t * 0.5)
  const pulse = Math.sin(t)
  addEuler(runtime.hips, 0, side * 0.04, side * 0.025)
  addEuler(runtime.spine, 0.025 + pulse * 0.018, side * 0.05, -side * 0.035)
  addEuler(runtime.head, pulse * 0.045, side * 0.08, Math.sin(t + 0.8) * 0.035)
  addEuler(runtime.leftThigh, Math.sin(feetT) * 0.08, 0, 0)
  addEuler(runtime.rightThigh, Math.sin(feetT + Math.PI) * 0.08, 0, 0)
  applyPreRiggedArmTuck(runtime, 0.75)
  addEuler(runtime.leftUpperArm, Math.sin(t + 1.2) * 0.08, 0, 0.06 + side * 0.08)
  addEuler(runtime.rightUpperArm, Math.sin(t + 2.2) * 0.08, 0, -0.06 + side * 0.08)
  if (danceId === 'dance_side_step_turn_02') {
    addEuler(runtime.hips, 0, side * 0.05, side * 0.02)
  } else if (danceId === 'dance_head_touch_groove_03') {
    addEuler(runtime.rightUpperArm, 0.08, 0, 0.16)
  }
}

function applyPreRiggedClip(
  runtime: PreRiggedAvatarRuntime,
  clipId: PreRiggedClipId,
  t: number,
  cycleBeats = 1,
  intensity = 1,
): boolean {
  const action = runtime.actions[clipId]
  if (!action) return false

  if (runtime.activeClip !== clipId) {
    runtime.mixer.stopAllAction()
    restoreBaseTransforms(runtime.baseTransforms)
    action.reset()
    action.enabled = true
    action.play()
    runtime.activeClip = clipId
  }

  const clip = action.getClip()
  const duration = Math.max(0.001, clip.duration)
  const beat = ((t / TAU) % cycleBeats + cycleBeats) % cycleBeats
  action.time = (beat / Math.max(0.001, cycleBeats)) * duration
  runtime.mixer.update(0)
  blendPreRiggedPoseWithBase(runtime, intensity)
  setJawOpen(runtime.morphTargets, 0)
  return true
}

function applyPreRiggedHipHopDance(runtime: PreRiggedAvatarRuntime, t: number, intensity = 1): boolean {
  if (!runtime.hipHopAction) {
    void ensureHipHopDanceAction(runtime)
    return false
  }

  if (runtime.activeClip !== 'dance_hip_hop_fbx') {
    runtime.mixer.stopAllAction()
    restoreBaseTransforms(runtime.baseTransforms)
    runtime.hipHopAction.reset()
    runtime.hipHopAction.enabled = true
    runtime.hipHopAction.play()
    runtime.activeClip = 'dance_hip_hop_fbx'
  }

  const clip = runtime.hipHopAction.getClip()
  const beat = ((t / TAU) % HIP_HOP_DANCE_BEATS + HIP_HOP_DANCE_BEATS) % HIP_HOP_DANCE_BEATS
  runtime.hipHopAction.time = (beat / HIP_HOP_DANCE_BEATS) * clip.duration
  runtime.mixer.update(0)
  blendPreRiggedPoseWithBase(runtime, intensity)
  setJawOpen(runtime.morphTargets, 0)
  return true
}

function blendPreRiggedPoseWithBase(runtime: PreRiggedAvatarRuntime, intensity: number): void {
  const amount = clamp(intensity, 0, 1)
  runtime.baseTransforms.forEach(({ object, position, quaternion, scale }) => {
    object.position.lerpVectors(position, object.position, amount)
    object.quaternion.slerpQuaternions(quaternion, object.quaternion, amount)
    object.scale.lerpVectors(scale, object.scale, amount)
  })
}

function ensureHipHopDanceAction(runtime: PreRiggedAvatarRuntime): Promise<void> | null {
  if (runtime.hipHopAction || runtime.hipHopFailed) return null
  if (runtime.hipHopLoading) return runtime.hipHopLoading

  runtime.hipHopLoading = loadHipHopDanceClip()
    .then((clip) => {
      if (!clip) {
        runtime.hipHopFailed = true
        return
      }

      const action = runtime.mixer.clipAction(clip)
      action.setLoop(THREE.LoopRepeat, Infinity)
      action.clampWhenFinished = false
      action.enabled = true
      runtime.hipHopAction = action
    })
    .catch((error) => {
      runtime.hipHopFailed = true
      console.warn('[Avatar dance] Hip-hop FBX load failed:', error)
    })
    .finally(() => {
      runtime.hipHopLoading = null
    })

  return runtime.hipHopLoading
}

function loadHipHopDanceClip(): Promise<THREE.AnimationClip | null> {
  if (!hipHopClipPromise) {
    hipHopClipPromise = new FBXLoader()
      .loadAsync(HIP_HOP_DANCE_URL)
      .then((fbx) => retargetMixamoClip(fbx.animations[0]))
      .catch((error) => {
        console.warn('[Avatar dance] FBX animation unavailable:', error)
        return null
      })
  }
  return hipHopClipPromise
}

function retargetMixamoClip(source: THREE.AnimationClip | undefined): THREE.AnimationClip | null {
  if (!source) return null

  const tracks: THREE.KeyframeTrack[] = []
  source.tracks.forEach((track) => {
    const parsed = parseTrackName(track.name)
    if (!parsed) return

    const targetBone = mixamoToDoorclubBone(parsed.node)
    if (!targetBone) return

    if (parsed.property === 'quaternion') {
      tracks.push(makeRetargetedQuaternionTrack(track, targetBone))
      return
    }

    if (parsed.property === 'position' && targetBone === 'hips') {
      tracks.push(makeScaledHipPositionTrack(track, targetBone))
    }
  })

  if (!tracks.length) return null
  const clip = new THREE.AnimationClip('dance_hip_hop_fbx', source.duration, tracks)
  clip.tracks.forEach((track) => track.setInterpolation(THREE.InterpolateSmooth))
  return clip.optimize()
}

function makeRetargetedQuaternionTrack(track: THREE.KeyframeTrack, targetBone: string): THREE.QuaternionKeyframeTrack {
  if (targetBone !== 'hips') {
    return new THREE.QuaternionKeyframeTrack(
      `${targetBone}.quaternion`,
      Array.from(track.times),
      Array.from(track.values),
    )
  }

  const source = track.values
  const values: number[] = []
  const base = readQuaternionValue(source, 0)
  const baseInverse = base.clone().invert()
  let previous = base.clone()

  for (let i = 0; i + 3 < source.length; i += 4) {
    const current = readQuaternionValue(source, i)
    if (previous.dot(current) < 0) {
      current.set(-current.x, -current.y, -current.z, -current.w)
    }
    previous = current.clone()

    const relative = current.clone().premultiply(baseInverse).normalize()
    values.push(relative.x, relative.y, relative.z, relative.w)
  }

  return new THREE.QuaternionKeyframeTrack(`${targetBone}.quaternion`, Array.from(track.times), values)
}

function readQuaternionValue(values: ArrayLike<number>, offset: number): THREE.Quaternion {
  return new THREE.Quaternion(
    Number(values[offset] ?? 0),
    Number(values[offset + 1] ?? 0),
    Number(values[offset + 2] ?? 0),
    Number(values[offset + 3] ?? 1),
  ).normalize()
}

function makeScaledHipPositionTrack(track: THREE.KeyframeTrack, targetBone: string): THREE.VectorKeyframeTrack {
  const source = track.values
  const baseX = Number(source[0] ?? 0)
  const baseY = Number(source[1] ?? 0)
  const baseZ = Number(source[2] ?? 0)
  const values: number[] = []

  for (let i = 0; i + 2 < source.length; i += 3) {
    const x = clamp((Number(source[i]) - baseX) * FBX_POSITION_SCALE, -0.16, 0.16)
    const y = clamp((Number(source[i + 1]) - baseY) * FBX_POSITION_SCALE, -0.03, 0.12)
    const z = clamp((Number(source[i + 2]) - baseZ) * FBX_POSITION_SCALE, -0.16, 0.16)
    values.push(x, y, z)
  }

  return new THREE.VectorKeyframeTrack(`${targetBone}.position`, Array.from(track.times), values)
}

function parseTrackName(name: string): { node: string; property: string } | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot >= name.length - 1) return null
  return {
    node: name.slice(0, dot),
    property: name.slice(dot + 1).replace(/\[[^\]]+\]/g, '').toLowerCase(),
  }
}

function mixamoToDoorclubBone(name: string): string | null {
  const normalized = name
    .replace(/^mixamorig[:_]?/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()

  const map: Record<string, string> = {
    hips: 'hips',
    spine: 'spine',
    spine1: 'chest',
    spine2: 'chest',
    neck: 'neck',
    head: 'head',
    leftupleg: 'thigh.L',
    leftleg: 'shin.L',
    leftfoot: 'foot.L',
    rightupleg: 'thigh.R',
    rightleg: 'shin.R',
    rightfoot: 'foot.R',
    leftarm: 'upper_arm.L',
    leftforearm: 'forearm.L',
    lefthand: 'hand.L',
    rightarm: 'upper_arm.R',
    rightforearm: 'forearm.R',
    righthand: 'hand.R',
  }

  return map[normalized] ?? null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function addEuler(object: THREE.Object3D | null, x = 0, y = 0, z = 0): void {
  if (!object) return
  object.rotation.x += x
  object.rotation.y += y
  object.rotation.z += z
}

function createGeneratedDanceRuntime(
  model: THREE.Object3D,
  bones: RigBones,
  bounds: RigBounds,
): GeneratedDanceRuntime {
  const mixer = new THREE.AnimationMixer(model)
  const clips = createGeneratedDanceClips(bones, bounds)
  const actions = {
    dance_idle_groove_01: mixer.clipAction(clips.dance_idle_groove_01),
    dance_side_step_turn_02: mixer.clipAction(clips.dance_side_step_turn_02),
    dance_head_touch_groove_03: mixer.clipAction(clips.dance_head_touch_groove_03),
    dance_hip_hop_fbx: mixer.clipAction(clips.dance_hip_hop_fbx),
  }
  Object.values(actions).forEach((action) => {
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.clampWhenFinished = false
    action.enabled = true
  })
  return { mixer, actions, activeDance: null }
}

function applyGeneratedDance(runtime: GeneratedDanceRuntime, danceId: GeneratedDanceId, localBeat: number): void {
  if (runtime.activeDance !== danceId) {
    runtime.mixer.stopAllAction()
    const action = runtime.actions[danceId]
    action.reset()
    action.enabled = true
    action.play()
    runtime.activeDance = danceId
  }
  const action = runtime.actions[danceId]
  action.time = localBeat
  runtime.mixer.update(0)
}

function stopGeneratedDance(runtime: GeneratedDanceRuntime): void {
  if (!runtime.activeDance) return
  runtime.mixer.stopAllAction()
  runtime.activeDance = null
}

function scaleGeneratedBonePose(bones: RigBones, intensity: number): void {
  const amount = clamp(intensity, 0, 1)
  Object.values(bones).forEach((bone) => {
    const baseX = bone.userData.baseX ?? bone.position.x
    const baseY = bone.userData.baseY ?? bone.position.y
    const baseZ = bone.userData.baseZ ?? bone.position.z
    bone.position.set(
      baseX + (bone.position.x - baseX) * amount,
      baseY + (bone.position.y - baseY) * amount,
      baseZ + (bone.position.z - baseZ) * amount,
    )
    bone.rotation.x *= amount
    bone.rotation.y *= amount
    bone.rotation.z *= amount
  })
}

function createGeneratedDanceClips(
  bones: RigBones,
  bounds: RigBounds,
): Record<GeneratedDanceId, THREE.AnimationClip> {
  return {
    dance_idle_groove_01: makeClip('dance_idle_groove_01', DANCE_BEATS.dance_idle_groove_01, [
      vectorTrack(bones.hips, 'position', [0, 1, 2, 3, 4, 5, 6, 7, 8], [
        bonePosition(bones.hips, 0, 0, 0),
        bonePosition(bones.hips, -bounds.width * 0.016, -bounds.height * 0.004, 0),
        bonePosition(bones.hips, -bounds.width * 0.024, -bounds.height * 0.006, 0),
        bonePosition(bones.hips, 0, bounds.height * 0.002, 0),
        bonePosition(bones.hips, bounds.width * 0.018, -bounds.height * 0.004, 0),
        bonePosition(bones.hips, bounds.width * 0.026, -bounds.height * 0.005, 0),
        bonePosition(bones.hips, bounds.width * 0.008, bounds.height * 0.002, 0),
        bonePosition(bones.hips, -bounds.width * 0.006, -bounds.height * 0.002, 0),
        bonePosition(bones.hips, 0, 0, 0),
      ]),
      scalarTrack(bones.hips, 'rotation[x]', [0, 2, 4, 6, 8], [0, 0.014, 0, -0.012, 0]),
      scalarTrack(bones.hips, 'rotation[y]', [0, 2, 4, 6, 8], [0, -0.045, 0.012, 0.04, 0]),
      scalarTrack(bones.hips, 'rotation[z]', [0, 2, 4, 6, 8], [0, -0.028, 0, 0.032, 0]),
      scalarTrack(bones.spine, 'rotation[x]', [0, 1, 2, 3, 4, 5, 6, 7, 8], [0, 0.03, 0.045, 0.01, 0, -0.024, -0.036, -0.012, 0]),
      scalarTrack(bones.spine, 'rotation[y]', [0, 2, 4, 6, 8], [0, 0.028, 0, -0.024, 0]),
      scalarTrack(bones.spine, 'rotation[z]', [0, 2, 4, 6, 8], [0, -0.04, 0, 0.044, 0]),
      scalarTrack(bones.head, 'rotation[x]', [0, 1, 2, 3, 4, 5, 6, 7, 8], [0, 0.2, 0.28, 0.08, 0, -0.08, -0.18, -0.06, 0]),
      scalarTrack(bones.head, 'rotation[y]', [0, 2, 4.5, 5.5, 8], [0, -0.06, 0.28, 0.12, 0]),
      scalarTrack(bones.head, 'rotation[z]', [0, 2, 4, 6, 8], [0, 0.05, 0, -0.07, 0]),
      scalarTrack(bones.leftArm, 'rotation[x]', [0, 2, 4, 6, 8], [0, 0.05, 0.02, -0.04, 0]),
      scalarTrack(bones.rightArm, 'rotation[x]', [0, 2, 4, 6, 8], [0, -0.045, 0, 0.04, 0]),
      scalarTrack(bones.leftArm, 'rotation[z]', [0, 2, 4, 6, 8], [0.02, 0.07, 0.02, -0.01, 0.02]),
      scalarTrack(bones.rightArm, 'rotation[z]', [0, 2, 4, 6, 8], [-0.03, -0.06, -0.02, 0.0, -0.03]),
      scalarTrack(bones.leftLeg, 'rotation[z]', [0, 2, 4, 6, 8], [0, 0.025, 0, -0.022, 0]),
      scalarTrack(bones.rightLeg, 'rotation[z]', [0, 2, 4, 6, 8], [0, 0.025, 0, -0.022, 0]),
    ]),
    dance_side_step_turn_02: makeClip('dance_side_step_turn_02', DANCE_BEATS.dance_side_step_turn_02, [
      vectorTrack(bones.hips, 'position', [0, DANCE_BEATS.dance_side_step_turn_02], [
        bonePosition(bones.hips, 0, 0, 0),
        bonePosition(bones.hips, 0, 0, 0),
      ]),
      scalarTrack(bones.hips, 'rotation[y]', [0, 1.5, 3.5, 5.2, 7, 9, 11.5, 14], [0, 0.22, 0, -0.22, 0, 0.1, -0.08, 0]),
      scalarTrack(bones.hips, 'rotation[z]', [0, 1.5, 3.5, 5.2, 7, 9, 11.5, 14], [0, 0.025, 0, -0.025, 0, 0.014, -0.012, 0]),
      scalarTrack(bones.spine, 'rotation[x]', [0, 1.5, 3.5, 5.2, 7, 10, 14], [0.02, 0.06, 0.02, 0.058, 0.02, 0.035, 0.02]),
      scalarTrack(bones.spine, 'rotation[y]', [0, 1.5, 3.5, 5.2, 7, 9, 11.5, 14], [0, 0.16, 0, -0.16, 0, 0.08, -0.06, 0]),
      scalarTrack(bones.spine, 'rotation[z]', [0, 1.5, 3.5, 5.2, 7, 9, 11.5, 14], [0, 0.03, 0, -0.03, 0, 0.018, -0.016, 0]),
      scalarTrack(bones.head, 'rotation[x]', [0, 1.5, 3.5, 5.2, 7, 10, 14], [0, 0.12, 0.02, 0.12, 0, 0.08, 0]),
      scalarTrack(bones.head, 'rotation[y]', [0, 1.5, 3.5, 5.2, 7, 9, 11.5, 14], [0, 0.46, 0, -0.46, 0, 0.22, -0.18, 0]),
      scalarTrack(bones.leftArm, 'rotation[x]', [0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 14], [0, 0.08, -0.04, 0.05, -0.08, 0.04, -0.04, 0, 0.06, -0.05, 0]),
      scalarTrack(bones.rightArm, 'rotation[x]', [0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 14], [0, -0.08, 0.04, -0.05, 0.08, -0.04, 0.04, 0, -0.06, 0.05, 0]),
      scalarTrack(bones.leftArm, 'rotation[z]', [0, 1.5, 3.5, 5.2, 7, 14], [0.02, 0.08, 0.02, -0.02, 0.02, 0.02]),
      scalarTrack(bones.rightArm, 'rotation[z]', [0, 1.5, 3.5, 5.2, 7, 14], [-0.02, 0.02, -0.02, -0.08, -0.02, -0.02]),
      scalarTrack(bones.leftLeg, 'rotation[x]', [0, 1.5, 3.5, 5.2, 7, 14], [0, 0.1, 0, -0.08, 0, 0]),
      scalarTrack(bones.rightLeg, 'rotation[x]', [0, 1.5, 3.5, 5.2, 7, 14], [0, -0.08, 0, 0.1, 0, 0]),
    ]),
    dance_head_touch_groove_03: makeClip('dance_head_touch_groove_03', DANCE_BEATS.dance_head_touch_groove_03, [
      vectorTrack(bones.hips, 'position', [0, DANCE_BEATS.dance_head_touch_groove_03], [
        bonePosition(bones.hips, 0, 0, 0),
        bonePosition(bones.hips, 0, 0, 0),
      ]),
      scalarTrack(bones.hips, 'rotation[y]', [0, 2, 4, 6, 8, 11, 14, 17, 20, 22, 24], [0, -0.05, 0.08, 0.16, 0, -0.04, 0, 0.12, -0.08, 0.03, 0]),
      scalarTrack(bones.hips, 'rotation[z]', [0, 2, 4, 6, 8, 11, 14, 17, 20, 22, 24], [0, -0.025, 0.02, 0.03, 0, -0.02, 0.015, 0.02, -0.03, -0.01, 0]),
      scalarTrack(bones.spine, 'rotation[x]', [0, 2, 4, 6, 8, 11, 14, 16, 18, 20, 22, 24], [0.02, 0.06, 0.04, 0.08, 0.03, 0.06, 0.12, 0.14, 0.06, 0.08, 0.05, 0.02]),
      scalarTrack(bones.spine, 'rotation[y]', [0, 2, 4, 6, 8, 11, 14, 17, 20, 22, 24], [0, -0.04, 0.04, 0.13, 0, -0.03, 0, 0.1, -0.06, 0.02, 0]),
      scalarTrack(bones.spine, 'rotation[z]', [0, 2, 4, 6, 8, 11, 14, 17, 20, 22, 24], [0, -0.06, 0, 0.04, 0, 0.05, -0.05, 0.03, -0.08, -0.04, 0]),
      scalarTrack(bones.head, 'rotation[x]', [0, 2, 4, 6, 8, 11, 14, 16, 18, 20, 22, 24], [0, 0.16, 0.08, 0.16, 0.02, 0.12, 0.24, 0.18, 0.08, 0.18, 0.12, 0]),
      scalarTrack(bones.head, 'rotation[y]', [0, 2, 4, 6, 8, 11, 14, 17, 20, 22, 24], [0, -0.08, 0, 0.34, 0, -0.04, 0.08, 0.22, -0.16, 0.06, 0]),
      scalarTrack(bones.head, 'rotation[z]', [0, 2, 4, 6, 8, 11, 14, 17, 20, 22, 24], [0, -0.18, -0.06, 0.08, 0, 0.12, -0.08, 0.04, -0.2, -0.06, 0]),
      scalarTrack(bones.rightArm, 'rotation[x]', [0, 2, 4, 6, 8, 11, 14, 16, 18, 20, 22, 24], [-0.05, 0.12, 0.22, 0.16, 0.08, 0.28, 0.18, 0.16, 0.12, 0.2, 0.18, -0.05]),
      scalarTrack(bones.rightArm, 'rotation[y]', [0, 2, 4, 6, 8, 11, 14, 16, 18, 20, 22, 24], [0, -0.12, -0.06, -0.14, -0.04, -0.16, -0.12, -0.06, 0, -0.14, -0.08, 0]),
      scalarTrack(bones.rightArm, 'rotation[z]', [0, 2, 4, 6, 8, 11, 14, 16, 18, 20, 22, 24], [-0.06, 0.78, 0.46, 0.66, 0.12, 0.92, 0.64, 0.32, 0.42, 0.86, 0.52, -0.06]),
      scalarTrack(bones.leftArm, 'rotation[x]', [0, 2, 4, 6, 8, 11, 14, 16, 18, 20, 22, 24], [0, 0.04, 0.02, 0.06, 0, 0.08, 0.16, 0.12, 0.14, 0.04, 0.02, 0]),
      scalarTrack(bones.leftArm, 'rotation[y]', [0, 14, 18, 24], [0, 0.08, 0.14, 0]),
      scalarTrack(bones.leftArm, 'rotation[z]', [0, 2, 4, 6, 8, 11, 14, 16, 18, 20, 22, 24], [0.04, 0.02, 0.04, 0.0, 0.04, -0.08, -0.42, -0.28, -0.32, 0.02, 0.04, 0.04]),
      scalarTrack(bones.leftLeg, 'rotation[x]', [0, 4, 8, 12, 16, 20, 24], [0, 0.06, -0.04, 0.06, -0.05, 0.04, 0]),
      scalarTrack(bones.rightLeg, 'rotation[x]', [0, 4, 8, 12, 16, 20, 24], [0, -0.04, 0.06, -0.05, 0.06, -0.04, 0]),
    ]),
    dance_hip_hop_fbx: makeClip('dance_hip_hop_fbx', DANCE_BEATS.dance_hip_hop_fbx, [
      vectorTrack(bones.hips, 'position', [0, 4, 8, 12, 16], [
        bonePosition(bones.hips, 0, 0, 0),
        bonePosition(bones.hips, bounds.width * 0.018, bounds.height * 0.008, 0),
        bonePosition(bones.hips, -bounds.width * 0.018, 0, 0),
        bonePosition(bones.hips, bounds.width * 0.012, bounds.height * 0.01, 0),
        bonePosition(bones.hips, 0, 0, 0),
      ]),
      scalarTrack(bones.hips, 'rotation[y]', [0, 2, 4, 6, 8, 10, 12, 14, 16], [0, 0.18, -0.08, 0.12, 0, -0.16, 0.1, -0.08, 0]),
      scalarTrack(bones.hips, 'rotation[z]', [0, 2, 4, 6, 8, 10, 12, 14, 16], [0, 0.04, -0.03, 0.06, 0, -0.05, 0.03, -0.02, 0]),
      scalarTrack(bones.spine, 'rotation[x]', [0, 2, 4, 6, 8, 10, 12, 14, 16], [0.02, 0.08, 0.03, 0.1, 0.02, 0.07, 0.04, 0.09, 0.02]),
      scalarTrack(bones.spine, 'rotation[y]', [0, 4, 8, 12, 16], [0, -0.14, 0.08, 0.12, 0]),
      scalarTrack(bones.head, 'rotation[x]', [0, 2, 4, 6, 8, 10, 12, 14, 16], [0, 0.18, 0.04, 0.22, 0, 0.15, 0.02, 0.2, 0]),
      scalarTrack(bones.head, 'rotation[y]', [0, 4, 8, 12, 16], [0, -0.28, 0.12, 0.24, 0]),
      scalarTrack(bones.leftArm, 'rotation[x]', [0, 4, 8, 12, 16], [0, -0.22, 0.16, -0.18, 0]),
      scalarTrack(bones.rightArm, 'rotation[x]', [0, 4, 8, 12, 16], [0, 0.2, -0.18, 0.22, 0]),
      scalarTrack(bones.leftArm, 'rotation[z]', [0, 4, 8, 12, 16], [0.06, 0.3, -0.12, 0.22, 0.06]),
      scalarTrack(bones.rightArm, 'rotation[z]', [0, 4, 8, 12, 16], [-0.06, -0.22, 0.18, -0.34, -0.06]),
      scalarTrack(bones.leftLeg, 'rotation[x]', [0, 4, 8, 12, 16], [0, 0.12, -0.08, 0.1, 0]),
      scalarTrack(bones.rightLeg, 'rotation[x]', [0, 4, 8, 12, 16], [0, -0.08, 0.12, -0.1, 0]),
    ]),
  }
}

function makeClip(name: GeneratedDanceId, duration: number, tracks: THREE.KeyframeTrack[]): THREE.AnimationClip {
  const clip = new THREE.AnimationClip(name, duration, tracks)
  clip.tracks.forEach((track) => track.setInterpolation(THREE.InterpolateSmooth))
  return clip
}

function scalarTrack(bone: THREE.Bone, property: string, times: number[], values: number[]): THREE.NumberKeyframeTrack {
  return new THREE.NumberKeyframeTrack(`${bone.name}.${property}`, times, values)
}

function vectorTrack(bone: THREE.Bone, property: string, times: number[], values: number[][]): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(`${bone.name}.${property}`, times, values.flat())
}

function bonePosition(bone: THREE.Bone, x = 0, y = 0, z = 0): number[] {
  return [
    (bone.userData.baseX ?? bone.position.x) + x,
    (bone.userData.baseY ?? bone.position.y) + y,
    (bone.userData.baseZ ?? bone.position.z) + z,
  ]
}

function applyGeneratedModelMaterialPass(model: THREE.Object3D): void {
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh.geometry) smoothNormalsByPosition(mesh.geometry)
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => {
      if (material.name === 'Doorclub_Seam_Bridge') {
        material.visible = false
        material.depthWrite = false
        material.colorWrite = false
        material.needsUpdate = true
        return
      }
      const maybeTextured = material as THREE.MeshStandardMaterial
      ;(material as THREE.MeshStandardMaterial & { flatShading?: boolean }).flatShading = false
      maybeTextured.roughness = 1
      maybeTextured.metalness = 0
      material.visible = true
      material.transparent = false
      material.opacity = 1
      material.alphaTest = 0
      material.colorWrite = true
      material.depthTest = true
      material.depthWrite = true
      material.side = THREE.DoubleSide
      material.blending = THREE.NormalBlending
      ;(material as any).skinning = true
      ;(material as any).morphTargets = true
      ;[
        maybeTextured.map,
        maybeTextured.normalMap,
        maybeTextured.roughnessMap,
        maybeTextured.metalnessMap,
      ].forEach((texture) => {
        if (!texture) return
        texture.magFilter = THREE.LinearFilter
        texture.minFilter = THREE.LinearMipmapLinearFilter
        texture.generateMipmaps = true
        texture.anisotropy = Math.max(texture.anisotropy, 4)
        texture.needsUpdate = true
      })
      material.needsUpdate = true
    })
  })
}

function smoothNormalsByPosition(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!position) return

  const index = geometry.getIndex()
  const keys = new Array<string>(position.count)
  const buckets = new Map<string, { x: number; y: number; z: number }>()
  const keyFor = (i: number) => {
    const key = [
      Math.round(position.getX(i) * NORMAL_POSITION_SCALE),
      Math.round(position.getY(i) * NORMAL_POSITION_SCALE),
      Math.round(position.getZ(i) * NORMAL_POSITION_SCALE),
    ].join(',')
    keys[i] = key
    if (!buckets.has(key)) buckets.set(key, { x: 0, y: 0, z: 0 })
    return key
  }

  for (let i = 0; i < position.count; i += 1) keyFor(i)

  const addFace = (a: number, b: number, c: number) => {
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a)
    const bx = position.getX(b), by = position.getY(b), bz = position.getZ(b)
    const cx = position.getX(c), cy = position.getY(c), cz = position.getZ(c)
    const abx = bx - ax, aby = by - ay, abz = bz - az
    const acx = cx - ax, acy = cy - ay, acz = cz - az
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    const length = Math.hypot(nx, ny, nz)
    if (length <= 1e-8) return

    ;[keys[a], keys[b], keys[c]].forEach((key) => {
      const bucket = buckets.get(key)
      if (!bucket) return
      bucket.x += nx / length
      bucket.y += ny / length
      bucket.z += nz / length
    })
  }

  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      addFace(index.getX(i), index.getX(i + 1), index.getX(i + 2))
    }
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) addFace(i, i + 1, i + 2)
  }

  const normals = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i += 1) {
    const bucket = buckets.get(keys[i])
    const length = bucket ? Math.hypot(bucket.x, bucket.y, bucket.z) : 0
    normals[i * 3] = length > 1e-8 ? bucket!.x / length : 0
    normals[i * 3 + 1] = length > 1e-8 ? bucket!.y / length : 1
    normals[i * 3 + 2] = length > 1e-8 ? bucket!.z / length : 0
  }

  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.normalizeNormals()
  geometry.attributes.normal.needsUpdate = true
}

function fitGeneratedModelToWorld(
  model: THREE.Object3D,
  targetHeight: number,
  options: { alignVertical?: boolean } = {},
): void {
  if (options.alignVertical !== false) alignGeneratedModelVertical(model)

  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  const scale = targetHeight / Math.max(0.1, size.y)
  model.scale.setScalar(scale)
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
}

function alignGeneratedModelVertical(model: THREE.Object3D): void {
  const axis = estimateGeneratedModelHeightAxis(model)
  if (!axis) return
  if (axis.y < 0) axis.negate()

  const angle = axis.angleTo(new THREE.Vector3(0, 1, 0))
  if (angle < VERTICAL_ALIGNMENT_MIN_RADIANS || angle > VERTICAL_ALIGNMENT_MAX_RADIANS) return

  const correction = new THREE.Quaternion().setFromUnitVectors(axis, new THREE.Vector3(0, 1, 0))
  for (const child of model.children) {
    child.position.applyQuaternion(correction)
    child.quaternion.premultiply(correction)
    child.updateMatrix()
  }
  model.updateWorldMatrix(true, true)
}

function estimateGeneratedModelHeightAxis(model: THREE.Object3D): THREE.Vector3 | null {
  model.updateWorldMatrix(true, true)
  let vertexCount = 0
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    const position = mesh.isMesh
      ? (mesh.geometry as THREE.BufferGeometry | undefined)?.getAttribute('position') as THREE.BufferAttribute | undefined
      : undefined
    if (position) vertexCount += position.count
  })
  if (vertexCount < 3) return null

  const stride = Math.max(1, Math.ceil(vertexCount / VERTICAL_ALIGNMENT_MAX_POINTS))
  const points: number[] = []
  const point = new THREE.Vector3()
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    const position = mesh.isMesh
      ? (mesh.geometry as THREE.BufferGeometry | undefined)?.getAttribute('position') as THREE.BufferAttribute | undefined
      : undefined
    if (!position) return
    mesh.updateWorldMatrix(true, false)
    for (let i = 0; i < position.count; i += stride) {
      point.fromBufferAttribute(position, i)
      mesh.localToWorld(point)
      model.worldToLocal(point)
      points.push(point.x, point.y, point.z)
    }
  })
  if (points.length < 9) return null

  return estimatePrincipalAxis(points)
}

function estimatePrincipalAxis(points: number[]): THREE.Vector3 | null {
  const count = points.length / 3
  let meanX = 0
  let meanY = 0
  let meanZ = 0
  for (let i = 0; i < points.length; i += 3) {
    meanX += points[i]
    meanY += points[i + 1]
    meanZ += points[i + 2]
  }
  meanX /= count
  meanY /= count
  meanZ /= count

  let xx = 0
  let xy = 0
  let xz = 0
  let yy = 0
  let yz = 0
  let zz = 0
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] - meanX
    const y = points[i + 1] - meanY
    const z = points[i + 2] - meanZ
    xx += x * x
    xy += x * y
    xz += x * z
    yy += y * y
    yz += y * z
    zz += z * z
  }

  const axis = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < 14; i += 1) {
    const x = xx * axis.x + xy * axis.y + xz * axis.z
    const y = xy * axis.x + yy * axis.y + yz * axis.z
    const z = xz * axis.x + yz * axis.y + zz * axis.z
    axis.set(x, y, z)
    if (axis.lengthSq() < 1e-10) return null
    axis.normalize()
  }

  return axis
}

function getRigBounds(model: THREE.Object3D): RigBounds {
  model.updateWorldMatrix(true, true)
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    const position = mesh.isMesh
      ? (mesh.geometry as THREE.BufferGeometry | undefined)?.getAttribute('position') as THREE.BufferAttribute | undefined
      : undefined
    if (!position) return
    mesh.updateWorldMatrix(true, false)
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i)
      mesh.localToWorld(point)
      model.worldToLocal(point)
      box.expandByPoint(point)
    }
  })
  if (box.isEmpty()) box.setFromObject(model)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  return {
    box,
    size,
    center,
    height: Math.max(0.1, size.y),
    width: Math.max(0.1, size.x),
    depth: Math.max(0.1, size.z),
    frontSign: -1,
  }
}

function createBones(bounds: RigBounds): RigBones {
  const minY = bounds.box.min.y
  const hipsY = minY + bounds.height * 0.45
  const spineY = minY + bounds.height * 0.63
  const headY = minY + bounds.height * 0.76
  const jawY = minY + bounds.height * 0.72
  const legX = Math.max(0.08, bounds.width * 0.13)
  const armX = Math.max(0.14, bounds.width * 0.22)

  const root = bone('generated-root', 0, 0, 0)
  const hips = bone('generated-hips', bounds.center.x, hipsY, bounds.center.z)
  const spine = bone('generated-spine', 0, spineY - hipsY, 0)
  const head = bone('generated-head', 0, headY - spineY, 0)
  const jaw = bone('generated-jaw', 0, jawY - headY, bounds.depth * bounds.frontSign * 0.12)
  const leftLeg = bone('generated-left-leg', -legX, 0, 0)
  const rightLeg = bone('generated-right-leg', legX, 0, 0)
  const leftArm = bone('generated-left-arm', -armX, spineY - hipsY, 0)
  const rightArm = bone('generated-right-arm', armX, spineY - hipsY, 0)

  root.add(hips)
  hips.add(spine)
  spine.add(head)
  head.add(jaw)
  hips.add(leftLeg)
  hips.add(rightLeg)
  hips.add(leftArm)
  hips.add(rightArm)

  return { root, hips, spine, head, jaw, leftLeg, rightLeg, leftArm, rightArm }
}

function bone(name: string, x: number, y: number, z: number): THREE.Bone {
  const item = new THREE.Bone()
  item.name = name
  item.position.set(x, y, z)
  item.userData.baseX = x
  item.userData.baseY = y
  item.userData.baseZ = z
  return item
}

function autoSkinModel(
  model: THREE.Object3D,
  skeleton: THREE.Skeleton,
  bounds: RigBounds,
  morphTargets: Array<THREE.SkinnedMesh | THREE.Mesh>,
): THREE.SkinnedMesh[] {
  const meshes: THREE.Mesh[] = []
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(mesh)
  })

  const skinnedMeshes: THREE.SkinnedMesh[] = []
  meshes.forEach((mesh) => {
    const skinned = skinMesh(mesh, model, bounds)
    if (!skinned) return
    skinnedMeshes.push(skinned)
    morphTargets.push(skinned)
    const parent = mesh.parent
    while (mesh.children.length) skinned.add(mesh.children[0])
    parent?.add(skinned)
    skinned.updateMatrixWorld(true)
    skinned.bind(skeleton, skinned.matrixWorld.clone())
    skinned.normalizeSkinWeights()
    parent?.remove(mesh)
    mesh.geometry.dispose()
  })
  return skinnedMeshes
}

function skinMesh(
  mesh: THREE.Mesh,
  model: THREE.Object3D,
  bounds: RigBounds,
): THREE.SkinnedMesh | null {
  const sourceGeometry = mesh.geometry as THREE.BufferGeometry | undefined
  const position = sourceGeometry?.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!sourceGeometry || !position) return null

  const geometry = sourceGeometry.clone()
  const count = position.count
  const skinIndices = new Uint16Array(count * 4)
  const skinWeights = new Float32Array(count * 4)
  const morphPositions = new Float32Array(count * 3)
  const original = new THREE.Vector3()
  const modelSpace = new THREE.Vector3()
  const morphedModelSpace = new THREE.Vector3()
  const morphedLocal = new THREE.Vector3()

  mesh.updateWorldMatrix(true, false)
  model.updateWorldMatrix(true, true)

  for (let i = 0; i < count; i += 1) {
    original.fromBufferAttribute(position, i)
    modelSpace.copy(original)
    mesh.localToWorld(modelSpace)
    model.worldToLocal(modelSpace)

    const weights = classifyVertex(modelSpace, bounds)
    for (let slot = 0; slot < 4; slot += 1) {
      skinIndices[i * 4 + slot] = weights.indices[slot] ?? 0
      skinWeights[i * 4 + slot] = weights.weights[slot] ?? 0
    }

    morphedModelSpace.copy(modelSpace)
    const mouth = mouthMask(modelSpace, bounds)
    if (mouth > 0) {
      morphedModelSpace.y -= bounds.height * 0.02 * mouth
      morphedModelSpace.z += bounds.depth * bounds.frontSign * 0.035 * mouth
    }
    morphedLocal.copy(morphedModelSpace)
    model.localToWorld(morphedLocal)
    mesh.worldToLocal(morphedLocal)
    morphPositions[i * 3] = morphedLocal.x
    morphPositions[i * 3 + 1] = morphedLocal.y
    morphPositions[i * 3 + 2] = morphedLocal.z
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(morphPositions, 3)]
  geometry.morphTargetsRelative = false

  const material = mesh.material
  const materials = Array.isArray(material) ? material : [material]
  materials.forEach((item) => {
    ;(item as any).skinning = true
    ;(item as any).morphTargets = true
    item.needsUpdate = true
  })

  const skinned = new THREE.SkinnedMesh(geometry, material)
  skinned.name = mesh.name
  skinned.position.copy(mesh.position)
  skinned.rotation.copy(mesh.rotation)
  skinned.scale.copy(mesh.scale)
  skinned.matrix.copy(mesh.matrix)
  skinned.matrixAutoUpdate = mesh.matrixAutoUpdate
  skinned.castShadow = mesh.castShadow
  skinned.receiveShadow = mesh.receiveShadow
  skinned.frustumCulled = false
  skinned.userData = { ...mesh.userData, isGeneratedSkinnedMesh: true }
  return skinned
}

function classifyVertex(point: THREE.Vector3, bounds: RigBounds): { indices: number[]; weights: number[] } {
  const y = yNorm(point, bounds)
  const x = point.x - bounds.center.x
  const absX = Math.abs(x)
  const mouth = mouthMask(point, bounds)

  if (mouth > 0.15) return normalizeWeights([
    [BONE_INDEX.jaw, 0.72 * mouth],
    [BONE_INDEX.head, 0.28 + (1 - mouth) * 0.28],
  ])

  if (y >= 0.78) return singleWeight(BONE_INDEX.head)
  if (y >= 0.72) return normalizeWeights([
    [BONE_INDEX.head, smoothstep(0.72, 0.78, y)],
    [BONE_INDEX.spine, 1 - smoothstep(0.72, 0.78, y)],
  ])

  const side = x < 0 ? BONE_INDEX.leftArm : BONE_INDEX.rightArm
  const shoulderBand = smoothstep(0.26, 0.36, y) * (1 - smoothstep(0.68, 0.76, y))
  const armReach = smoothstep(bounds.width * 0.22, bounds.width * 0.34, absX)
  const armWeight = shoulderBand * armReach
  if (armWeight > 0.05) return normalizeWeights([
    [side, 0.34 + armWeight * 0.38],
    [BONE_INDEX.spine, 0.44 - armWeight * 0.12],
    [BONE_INDEX.hips, 0.16],
    [BONE_INDEX.root, 0.06],
  ])

  if (y >= 0.26 && y < 0.64) {
    const spine = smoothstep(0.4, 0.64, y)
    return normalizeWeights([
      [BONE_INDEX.spine, 0.22 + spine * 0.46],
      [BONE_INDEX.hips, 0.7 - spine * 0.34],
      [BONE_INDEX.root, 0.08],
    ])
  }

  const lowerBody = 1 - smoothstep(0.18, 0.29, y)
  const legReach = smoothstep(bounds.width * 0.045, bounds.width * 0.24, absX)
  const hipBlend = smoothstep(0.08, 0.29, y)
  const lowerLegDrive = 1 - smoothstep(0.12, 0.28, y)
  const crotchBridge = (1 - smoothstep(bounds.width * 0.025, bounds.width * 0.16, absX)) * lowerBody
  if (lowerBody > 0.02) {
    const leg = x < 0 ? BONE_INDEX.leftLeg : BONE_INDEX.rightLeg
    const oppositeLeg = x < 0 ? BONE_INDEX.rightLeg : BONE_INDEX.leftLeg
    return normalizeWeights([
      [leg, legReach * lowerBody * (0.12 + lowerLegDrive * 0.4)],
      [oppositeLeg, crotchBridge * 0.14],
      [BONE_INDEX.hips, 0.58 + hipBlend * 0.24],
      [BONE_INDEX.root, 0.08],
    ])
  }

  if (y >= 0.43) {
    const spine = smoothstep(0.43, 0.68, y)
    return normalizeWeights([
      [BONE_INDEX.spine, 0.42 + spine * 0.38],
      [BONE_INDEX.hips, 0.5 - spine * 0.3],
      [BONE_INDEX.root, 0.08],
    ])
  }

  return normalizeWeights([
    [BONE_INDEX.hips, 0.72],
    [BONE_INDEX.root, 0.28],
  ])
}

function singleWeight(index: number): { indices: number[]; weights: number[] } {
  return { indices: [index, 0, 0, 0], weights: [LIMB_WEIGHT, 0, 0, 0] }
}

function normalizeWeights(items: Array<[number, number]>): { indices: number[]; weights: number[] } {
  const filtered = items.filter(([, weight]) => weight > 0.001).slice(0, 4)
  const total = filtered.reduce((sum, [, weight]) => sum + weight, 0) || 1
  const indices = filtered.map(([index]) => index)
  const weights = filtered.map(([, weight]) => weight / total)
  while (indices.length < 4) indices.push(0)
  while (weights.length < 4) weights.push(0)
  return { indices, weights }
}

function mouthMask(point: THREE.Vector3, bounds: RigBounds): number {
  const y = yNorm(point, bounds)
  const x = Math.abs(point.x - bounds.center.x)
  const front = bounds.frontSign > 0
    ? point.z - bounds.center.z
    : bounds.center.z - point.z
  const yBand = smoothstep(0.70, 0.75, y) * (1 - smoothstep(0.83, 0.88, y))
  const xBand = 1 - smoothstep(bounds.width * 0.06, bounds.width * 0.16, x)
  const frontBand = smoothstep(bounds.depth * 0.12, bounds.depth * 0.32, front)
  return Math.max(0, Math.min(1, yBand * xBand * frontBand))
}

function yNorm(point: THREE.Vector3, bounds: RigBounds): number {
  return (point.y - bounds.box.min.y) / bounds.height
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.0001, edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function setJawOpen(targets: Array<THREE.SkinnedMesh | THREE.Mesh>, openness: number): void {
  targets.forEach((mesh) => {
    if (!mesh.morphTargetInfluences?.length) return
    mesh.morphTargetInfluences[0] = Math.max(0, Math.min(1, openness))
  })
}
