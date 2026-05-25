import type * as THREE from 'three'

const GENERATED_AVATAR_PARENT_ROTATION_OFFSET = 0

function generatedVisualOffset(group: THREE.Object3D): number {
  return group.userData.generatedModel ? GENERATED_AVATAR_PARENT_ROTATION_OFFSET : 0
}

export function normalizeAvatarRotationY(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value))
}

export function getAvatarMovementRotationY(group: THREE.Object3D): number {
  const value = group.userData.movementRotY
  if (typeof value === 'number' && Number.isFinite(value)) return value

  const visualOffset = generatedVisualOffset(group)
  return group.rotation.y - visualOffset
}

export function applyAvatarFacingRotation(
  group: THREE.Object3D,
  movementRotY: number,
): void {
  const nextRotY = Number.isFinite(movementRotY) ? movementRotY : getAvatarMovementRotationY(group)
  group.userData.movementRotY = nextRotY

  const visualOffset = generatedVisualOffset(group)
  group.rotation.y = normalizeAvatarRotationY(nextRotY + visualOffset)
}
