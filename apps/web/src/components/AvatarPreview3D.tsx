import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AvatarConfig } from '@shared/types'

interface AvatarPreview3DProps {
  config: AvatarConfig
  width?: number
  height?: number
  autoRotate?: boolean
  style?: CSSProperties
}

type ClothingZone = 'top' | 'bottom'
const GENERATED_MODEL_ROTATION_Y = Math.PI
const NORMAL_POSITION_SCALE = 10_000

export default function AvatarPreview3D({
  config,
  width = 280,
  height = 380,
  autoRotate = true,
  style,
}: AvatarPreview3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rotationY = useRef(Math.PI)
  const dragging = useRef(false)
  const lastX = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let disposed = false
    const disposables: Array<{ dispose: () => void }> = []
    const track = <T extends { dispose: () => void }>(item: T): T => {
      disposables.push(item)
      return item
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(width, height, false)
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 50)
    camera.position.set(0, 1.68, 4.25)
    camera.lookAt(0, 1.25, 0)

    scene.add(new THREE.AmbientLight(0xffffff, 1.15))
    const key = new THREE.DirectionalLight(0xffffff, 0.68)
    key.position.set(3, 7, 5)
    scene.add(key)
    const clubFill = new THREE.DirectionalLight(0x9a7cff, 0.34)
    clubFill.position.set(-4, 2, -2)
    scene.add(clubFill)

    const avatar = new THREE.Group()
    scene.add(avatar)
    const procedural = createAvatarModel(config, track)
    avatar.add(procedural)
    applyHeadTexture(avatar, config.faceTextureUrl, config.skinTone, track, () => disposed)
    applyClothingStyleTexture(avatar, 'top', config.topColor, track)
    applyClothingStyleTexture(avatar, 'bottom', config.bottomColor, track)
    if (config.modelUrl) {
      loadGeneratedAvatarModel(avatar, procedural, config.modelUrl, track, () => disposed)
    }

    const floor = new THREE.Mesh(
      track(new THREE.CircleGeometry(1.25, 18)),
      track(new THREE.MeshBasicMaterial({ color: 0x121220, transparent: true, opacity: 0.62 })),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = 0.015
    scene.add(floor)

    const pointerDown = (event: PointerEvent) => {
      dragging.current = true
      lastX.current = event.clientX
      canvas.setPointerCapture(event.pointerId)
    }
    const pointerMove = (event: PointerEvent) => {
      if (!dragging.current) return
      rotationY.current += (event.clientX - lastX.current) * 0.013
      lastX.current = event.clientX
    }
    const pointerUp = (event: PointerEvent) => {
      dragging.current = false
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }

    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('pointercancel', pointerUp)

    let frameId = 0
    let idle = 0
    const animate = () => {
      frameId = requestAnimationFrame(animate)
      idle += 0.016
      const wobble = autoRotate && !dragging.current ? Math.sin(idle * 0.8) * 0.12 : 0
      avatar.rotation.y = rotationY.current + wobble
      avatar.position.y = Math.sin(idle * 1.6) * 0.012
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      disposed = true
      cancelAnimationFrame(frameId)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', pointerUp)
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry?.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material?.dispose()
      })
      disposables.forEach((item) => item.dispose())
      renderer.dispose()
    }
  }, [
    autoRotate,
    config.bodyId,
    config.bodyTextureUrl,
    config.bottomColor,
    config.bottomStyle,
    config.faceTextureUrl,
    config.hairColor,
    config.hairStyle,
    config.headId,
    config.modelUrl,
    config.shoesColor,
    config.shoesStyle,
    config.skinTone,
    config.topColor,
    config.topStyle,
    height,
    width,
  ])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width,
        height,
        display: 'block',
        borderRadius: 8,
        border: '1px solid #2a2a3a',
        background: 'linear-gradient(180deg, #0d0d1a 0%, #171025 100%)',
        cursor: 'grab',
        touchAction: 'none',
        ...style,
      }}
    />
  )
}

function loadGeneratedAvatarModel(
  parent: THREE.Group,
  fallback: THREE.Object3D,
  modelUrl: string,
  track: <T extends { dispose: () => void }>(item: T) => T,
  isDisposed: () => boolean,
): void {
  const loader = new GLTFLoader()
  loader.load(
    modelUrl,
    (gltf) => {
      if (isDisposed()) return

      fallback.visible = false
      const model = gltf.scene
      model.rotation.y = GENERATED_MODEL_ROTATION_Y
      applyGeneratedModelMaterialPass(model)
      fitGeneratedModelToPreview(model)
      parent.add(model)

      gltf.animations.forEach((clip) => track({ dispose: () => void clip.tracks.splice(0) }))
    },
    undefined,
    () => {
      fallback.visible = true
    },
  )
}

function fitGeneratedModelToPreview(model: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  const scale = 2.25 / Math.max(0.1, size.y)
  model.scale.setScalar(scale)
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
}

function applyGeneratedModelMaterialPass(model: THREE.Object3D): void {
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh.geometry) smoothNormalsByPosition(mesh.geometry)
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => {
      const maybeTextured = material as THREE.MeshStandardMaterial
      ;(material as THREE.MeshStandardMaterial & { flatShading?: boolean }).flatShading = false
      maybeTextured.roughness = 1
      maybeTextured.metalness = 0
      const maps = [
        maybeTextured.map,
        maybeTextured.normalMap,
        maybeTextured.roughnessMap,
        maybeTextured.metalnessMap,
      ]
      maps.forEach((texture) => {
        if (!texture) return
        texture.magFilter = THREE.LinearFilter
        texture.minFilter = THREE.LinearMipmapLinearFilter
        texture.generateMipmaps = true
        texture.anisotropy = Math.max(texture.anisotropy, 4)
        texture.needsUpdate = true
      })
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

function createAvatarModel(
  config: AvatarConfig,
  track: <T extends { dispose: () => void }>(item: T) => T,
): THREE.Group {
  const group = new THREE.Group()
  const preset = bodyPreset(config.bodyId)
  const skin = mat(config.skinTone, track)
  const top = mat(config.topColor, track)
  const bottom = mat(config.bottomColor, track)
  const hair = mat(config.hairColor, track)
  const shoes = mat(config.shoesColor, track)
  const darkTrim = mat(darken(config.topColor, 0.45), track)

  group.scale.set(preset.scaleX, preset.scaleY, preset.scaleZ)

  const torso = box(0.55 * preset.torsoWidth, 0.75, 0.3, 0, 1.3, 0, top, group, track)
  torso.userData.zone = 'top'

  if (config.topStyle === 'jacket') {
    const leftPanel = box(0.12, 0.68, 0.025, -0.13, 1.3, 0.165, darkTrim, group, track)
    const rightPanel = box(0.12, 0.68, 0.025, 0.13, 1.3, 0.165, darkTrim, group, track)
    leftPanel.userData.zone = 'top'
    rightPanel.userData.zone = 'top'
  }

  if (config.topStyle === 'hoodie') {
    const hood = new THREE.Mesh(
      track(new THREE.SphereGeometry(0.24, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.78)),
      top,
    )
    hood.position.set(0, 1.72, -0.06)
    hood.scale.set(0.96, 0.78, 0.8)
    hood.userData.zone = 'top'
    group.add(hood)
  }

  const armL = box(0.18, 0.65, 0.18, -0.37 * preset.shoulders, 1.25, 0, top, group, track)
  const armR = box(0.18, 0.65, 0.18, 0.37 * preset.shoulders, 1.25, 0, top, group, track)
  armL.rotation.z = 0.08
  armR.rotation.z = -0.08
  armL.userData.zone = 'top'
  armR.userData.zone = 'top'

  box(0.16, 0.18, 0.16, -0.37 * preset.shoulders, 0.87, 0, skin, group, track)
  box(0.16, 0.18, 0.16, 0.37 * preset.shoulders, 0.87, 0, skin, group, track)

  if (config.bottomStyle === 'skirt') {
    const skirt = new THREE.Mesh(track(new THREE.CylinderGeometry(0.34, 0.46, 0.56, 4)), bottom)
    skirt.position.set(0, 0.78, 0)
    skirt.rotation.y = Math.PI / 4
    skirt.userData.zone = 'bottom'
    group.add(skirt)
    box(0.14, 0.48, 0.16, -0.13, 0.34, 0, skin, group, track)
    box(0.14, 0.48, 0.16, 0.13, 0.34, 0, skin, group, track)
  } else if (config.bottomStyle === 'shorts') {
    const shortL = box(0.24, 0.36, 0.23, -0.15, 0.78, 0, bottom, group, track)
    const shortR = box(0.24, 0.36, 0.23, 0.15, 0.78, 0, bottom, group, track)
    shortL.userData.zone = 'bottom'
    shortR.userData.zone = 'bottom'
    box(0.15, 0.42, 0.15, -0.15, 0.38, 0, skin, group, track)
    box(0.15, 0.42, 0.15, 0.15, 0.38, 0, skin, group, track)
  } else {
    const legL = box(0.23, 0.75, 0.23, -0.15, 0.6, 0, bottom, group, track)
    const legR = box(0.23, 0.75, 0.23, 0.15, 0.6, 0, bottom, group, track)
    legL.userData.zone = 'bottom'
    legR.userData.zone = 'bottom'
  }

  const shoeDepth = config.shoesStyle === 'boots' ? 0.34 : 0.3
  const shoeHeight = config.shoesStyle === 'boots' ? 0.2 : 0.16
  box(0.24, shoeHeight, shoeDepth, -0.15, 0.16, 0.04, shoes, group, track)
  box(0.24, shoeHeight, shoeDepth, 0.15, 0.16, 0.04, shoes, group, track)

  const headGeo = track(new THREE.SphereGeometry(0.22, 12, 9))
  const headScale = headPreset(config.headId)
  headGeo.scale(headScale.x, headScale.y, headScale.z)
  const head = new THREE.Mesh(headGeo, skin)
  head.position.set(0, 1.9, 0)
  head.userData.part = 'head'
  group.add(head)

  addHair(config.hairStyle, hair, group, track)

  return group
}

function addHair(
  hairStyle: string,
  material: THREE.Material,
  group: THREE.Group,
  track: <T extends { dispose: () => void }>(item: T) => T,
): void {
  if (hairStyle === 'bald') return

  const cap = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.225, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.56)),
    material,
  )
  cap.position.set(0, 1.98, -0.035)
  cap.scale.set(0.94, hairStyle === 'medium_01' ? 1.08 : 1, 0.92)
  group.add(cap)

  if (hairStyle === 'medium_01' || hairStyle === 'long_01') {
    box(0.38, 0.18, 0.12, 0, 1.84, -0.14, material, group, track)
  }

  if (hairStyle === 'long_01') {
    box(0.42, 0.52, 0.12, 0, 1.58, -0.15, material, group, track)
  }
}

function applyHeadTexture(
  group: THREE.Group,
  dataUrl: string | null,
  skinTone: string,
  track: <T extends { dispose: () => void }>(item: T) => T,
  isDisposed: () => boolean,
): void {
  if (!dataUrl) return
  const image = new Image()
  image.onload = () => {
    if (isDisposed()) return
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = skinTone
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const texture = track(new THREE.CanvasTexture(canvas))
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    const material = track(new THREE.MeshLambertMaterial({ map: texture }))
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh && mesh.userData.part === 'head') mesh.material = material
    })
  }
  image.src = dataUrl
}

function applyClothingStyleTexture(
  group: THREE.Group,
  zone: ClothingZone,
  color: string,
  track: <T extends { dispose: () => void }>(item: T) => T,
): void {
  const texture = track(new THREE.CanvasTexture(createPs2FabricTexture(color, zone)))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  const material = track(new THREE.MeshLambertMaterial({ map: texture }))
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && mesh.userData.zone === zone) mesh.material = material
  })
}

function createPs2FabricTexture(color: string, zone: ClothingZone): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const base = parseColor(color)
  const light = shiftColor(base, 1.18)
  const dark = shiftColor(base, 0.62)
  ctx.fillStyle = `#${base.toString(16).padStart(6, '0')}`
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.fillStyle = `#${light.toString(16).padStart(6, '0')}`
  ctx.fillRect(0, 0, canvas.width, zone === 'top' ? 16 : 12)

  ctx.fillStyle = `#${dark.toString(16).padStart(6, '0')}`
  for (let y = 8; y < canvas.height; y += 16) {
    ctx.fillRect(0, y, canvas.width, 2)
  }
  for (let x = 6; x < canvas.width; x += 13) {
    ctx.fillRect(x, 0, 1, canvas.height)
  }

  ctx.fillStyle = 'rgba(0,0,0,0.14)'
  for (let y = 0; y < canvas.height; y += 4) {
    for (let x = (y / 4) % 2 === 0 ? 0 : 2; x < canvas.width; x += 4) {
      ctx.fillRect(x, y, 1, 1)
    }
  }

  return canvas
}

function bodyPreset(bodyId: string) {
  switch (bodyId) {
    case 'body_02':
      return { scaleX: 0.92, scaleY: 1.02, scaleZ: 0.94, torsoWidth: 0.9, shoulders: 0.94 }
    case 'body_03':
      return { scaleX: 1.08, scaleY: 1, scaleZ: 1.04, torsoWidth: 1.08, shoulders: 1.08 }
    case 'body_04':
      return { scaleX: 0.96, scaleY: 1.08, scaleZ: 0.96, torsoWidth: 0.98, shoulders: 1 }
    case 'body_05':
      return { scaleX: 1.02, scaleY: 0.94, scaleZ: 1, torsoWidth: 1, shoulders: 1.02 }
    default:
      return { scaleX: 1, scaleY: 1, scaleZ: 1, torsoWidth: 1, shoulders: 1 }
  }
}

function headPreset(headId: string) {
  switch (headId) {
    case 'head_02':
      return { x: 1.02, y: 1.02, z: 0.9 }
    case 'head_03':
      return { x: 0.88, y: 1.2, z: 0.88 }
    default:
      return { x: 0.92, y: 1.12, z: 0.88 }
  }
}

function mat(
  color: string,
  track: <T extends { dispose: () => void }>(item: T) => T,
): THREE.MeshLambertMaterial {
  return track(new THREE.MeshLambertMaterial({ color: parseColor(color) }))
}

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material,
  parent: THREE.Object3D,
  track: <T extends { dispose: () => void }>(item: T) => T,
): THREE.Mesh {
  const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(width, height, depth)), material)
  mesh.position.set(x, y, z)
  parent.add(mesh)
  return mesh
}

function parseColor(value: string | null | undefined): number {
  if (!value) return 0x111111
  const rgb = value.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
  if (rgb) return (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3])
  const parsed = parseInt(value.replace('#', ''), 16)
  return Number.isNaN(parsed) ? 0x111111 : parsed
}

function darken(color: string, amount: number): string {
  const value = parseColor(color)
  const r = Math.round(((value >> 16) & 255) * amount)
  const g = Math.round(((value >> 8) & 255) * amount)
  const b = Math.round((value & 255) * amount)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function shiftColor(color: number, amount: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 255) * amount)))
  const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 255) * amount)))
  const b = Math.max(0, Math.min(255, Math.round((color & 255) * amount)))
  return (r << 16) | (g << 8) | b
}
