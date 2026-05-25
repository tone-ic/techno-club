import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def usage():
    print("Usage: blender --background --python avatar-autorig.blender.py -- input.glb output.glb")


def argv_after_double_dash():
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1 :]


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def import_glb(filepath):
    bpy.ops.import_scene.gltf(filepath=str(filepath))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh objects found in imported GLB")
    return meshes


def preserve_mesh_visual_quality(meshes):
    for obj in meshes:
        mesh = obj.data
        for polygon in mesh.polygons:
            polygon.use_smooth = True

        if not any(mod.type == "WEIGHTED_NORMAL" for mod in obj.modifiers):
            modifier = obj.modifiers.new("Doorclub_Weighted_Normals", "WEIGHTED_NORMAL")
            modifier.keep_sharp = True
            modifier.weight = 50

        mesh.update()


def scene_bounds(meshes):
    points = []
    for obj in meshes:
        matrix = obj.matrix_world
        for corner in obj.bound_box:
            points.append(matrix @ Vector(corner))

    min_v = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    max_v = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center = (min_v + max_v) * 0.5
    size = max_v - min_v
    return min_v, max_v, center, size


def add_bone(edit_bones, name, head, tail, parent=None):
    bone = edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    bone.roll = 0
    if parent:
        bone.parent = parent
        bone.use_connect = False
    return bone


def create_humanoid_armature(bounds):
    min_v, _max_v, center, size = bounds
    height = max(size.z, 0.1)
    width = max(size.x, 0.1)
    depth = max(size.y, 0.1)
    x0 = center.x
    y0 = center.y
    z0 = min_v.z
    front_y = center.y - depth * 0.28

    armature_data = bpy.data.armatures.new("Doorclub_AutoRig")
    armature_obj = bpy.data.objects.new("Doorclub_AutoRig", armature_data)
    bpy.context.collection.objects.link(armature_obj)
    bpy.context.view_layer.objects.active = armature_obj
    armature_obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    bones = armature_data.edit_bones
    hips = add_bone(
        bones,
        "hips",
        Vector((x0, y0, z0 + height * 0.45)),
        Vector((x0, y0, z0 + height * 0.55)),
    )
    spine = add_bone(
        bones,
        "spine",
        hips.tail,
        Vector((x0, y0, z0 + height * 0.72)),
        hips,
    )
    chest = add_bone(
        bones,
        "chest",
        spine.tail,
        Vector((x0, y0, z0 + height * 0.80)),
        spine,
    )
    neck = add_bone(
        bones,
        "neck",
        chest.tail,
        Vector((x0, y0, z0 + height * 0.86)),
        chest,
    )
    head = add_bone(
        bones,
        "head",
        neck.tail,
        Vector((x0, y0, z0 + height * 0.98)),
        neck,
    )

    shoulder_z = z0 + height * 0.74
    elbow_z = z0 + height * 0.56
    wrist_z = z0 + height * 0.39
    shoulder_x = width * 0.18
    elbow_x = width * 0.36
    wrist_x = width * 0.49
    hand_x = width * 0.56

    for suffix, side in ((".L", -1), (".R", 1)):
        upper_arm = add_bone(
            bones,
            f"upper_arm{suffix}",
            Vector((x0 + side * shoulder_x, y0, shoulder_z)),
            Vector((x0 + side * elbow_x, y0, elbow_z)),
            chest,
        )
        forearm = add_bone(
            bones,
            f"forearm{suffix}",
            upper_arm.tail,
            Vector((x0 + side * wrist_x, y0, wrist_z)),
            upper_arm,
        )
        add_bone(
            bones,
            f"hand{suffix}",
            forearm.tail,
            Vector((x0 + side * hand_x, y0, wrist_z - height * 0.02)),
            forearm,
        )

        thigh = add_bone(
            bones,
            f"thigh{suffix}",
            Vector((x0 + side * width * 0.10, y0, z0 + height * 0.45)),
            Vector((x0 + side * width * 0.11, y0, z0 + height * 0.25)),
            hips,
        )
        shin = add_bone(
            bones,
            f"shin{suffix}",
            thigh.tail,
            Vector((x0 + side * width * 0.10, y0, z0 + height * 0.07)),
            thigh,
        )
        add_bone(
            bones,
            f"foot{suffix}",
            shin.tail,
            Vector((x0 + side * width * 0.10, front_y, z0 + height * 0.04)),
            shin,
        )

    bpy.ops.object.mode_set(mode="OBJECT")
    return armature_obj


def bind_meshes(meshes, armature_obj, bounds):
    for obj in meshes:
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        except Exception:
            pass

        apply_deterministic_skin(obj, armature_obj, bounds)

    validate_skinning(meshes)


def clamp01(value):
    return max(0.0, min(1.0, value))


def smoothstep(edge0, edge1, value):
    if edge1 <= edge0:
        return 1.0 if value >= edge1 else 0.0
    t = clamp01((value - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def normalize_weights(items):
    filtered = [(name, weight) for name, weight in items if weight > 0.001]
    filtered.sort(key=lambda item: item[1], reverse=True)
    filtered = filtered[:4]
    total = sum(weight for _name, weight in filtered)
    if total <= 0:
        return [("hips", 1.0)]
    return [(name, weight / total) for name, weight in filtered]


def classify_skin_weights(point, bounds):
    min_v, _max_v, center, size = bounds
    height = max(size.z, 0.1)
    width = max(size.x, 0.1)
    x = point.x - center.x
    abs_x = abs(x)
    y = (point.z - min_v.z) / height
    side_suffix = ".L" if x < 0 else ".R"

    if y >= 0.86:
        return [("head", 1.0)]
    if y >= 0.76:
        head = smoothstep(0.76, 0.86, y)
        return normalize_weights([("head", head), ("neck", 1.0 - head)])

    arm_band = smoothstep(0.34, 0.48, y) * (1.0 - smoothstep(0.76, 0.84, y))
    arm_reach = smoothstep(width * 0.18, width * 0.34, abs_x)
    if arm_band * arm_reach > 0.08:
        arm_t = clamp01((abs_x - width * 0.18) / max(width * 0.34, 0.001))
        return normalize_weights([
            (f"upper_arm{side_suffix}", (1.0 - arm_t) * 0.75 + 0.12),
            (f"forearm{side_suffix}", arm_t * 0.72),
            (f"hand{side_suffix}", smoothstep(0.72, 1.0, arm_t) * 0.5),
            ("chest", 0.18),
        ])

    if y >= 0.72:
        return normalize_weights([("head", smoothstep(0.72, 0.84, y)), ("chest", 0.45), ("neck", 0.28)])
    if y >= 0.55:
        spine = smoothstep(0.55, 0.72, y)
        return normalize_weights([("chest", 0.35 + spine * 0.45), ("spine", 0.55 - spine * 0.25), ("hips", 0.1)])
    if y >= 0.43:
        return normalize_weights([("spine", smoothstep(0.43, 0.58, y)), ("hips", 0.75)])

    leg_reach = smoothstep(width * 0.035, width * 0.18, abs_x)
    if y < 0.43 and leg_reach > 0.06:
        lower_leg = 1.0 - smoothstep(0.12, 0.28, y)
        foot = 1.0 - smoothstep(0.02, 0.10, y)
        return normalize_weights([
            (f"thigh{side_suffix}", (1.0 - lower_leg) * 0.72),
            (f"shin{side_suffix}", lower_leg * 0.76),
            (f"foot{side_suffix}", foot * 0.42),
            ("hips", 0.18 + (1.0 - leg_reach) * 0.3),
        ])

    return normalize_weights([("hips", 0.82), ("spine", 0.18)])


def apply_deterministic_skin(obj, armature_obj, bounds):
    existing_modifier = next((mod for mod in obj.modifiers if mod.type == "ARMATURE"), None)
    modifier = existing_modifier or obj.modifiers.new("Doorclub_AutoRig_Skin", "ARMATURE")
    modifier.object = armature_obj

    for group in list(obj.vertex_groups):
        obj.vertex_groups.remove(group)

    groups = {}
    for bone in armature_obj.data.bones:
        groups[bone.name] = obj.vertex_groups.new(name=bone.name)

    for vertex in obj.data.vertices:
        point = obj.matrix_world @ vertex.co
        for name, weight in classify_skin_weights(point, bounds):
            group = groups.get(name)
            if group:
                group.add([vertex.index], weight, "ADD")

    obj.parent = armature_obj
    obj.data.update()


def validate_skinning(meshes):
    skinned = 0
    for obj in meshes:
        has_armature = any(mod.type == "ARMATURE" and mod.object for mod in obj.modifiers)
        has_groups = len(obj.vertex_groups) > 0
        if has_armature and has_groups:
            skinned += 1

    if skinned == 0:
        raise RuntimeError("Blender autorig produced no skinned meshes")


def set_pose_rotation(armature_obj, bone_name, rotation, frame):
    bone = armature_obj.pose.bones.get(bone_name)
    if not bone:
        return
    bone.rotation_mode = "XYZ"
    bone.rotation_euler = rotation
    bone.keyframe_insert(data_path="rotation_euler", frame=frame)


def set_pose_location(armature_obj, bone_name, location, frame):
    bone = armature_obj.pose.bones.get(bone_name)
    if not bone:
        return
    bone.location = location
    bone.keyframe_insert(data_path="location", frame=frame)


def create_action(armature_obj, name, frames, callback):
    bpy.context.view_layer.objects.active = armature_obj
    armature_obj.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.transforms_clear()

    action = bpy.data.actions.new(name)
    armature_obj.animation_data_create()
    armature_obj.animation_data.action = action

    for frame in frames:
        callback(frame)

    bpy.ops.pose.transforms_clear()
    bpy.ops.object.mode_set(mode="OBJECT")
    track = armature_obj.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, int(min(frames)), action)
    strip.frame_end = max(frames)
    armature_obj.animation_data.action = None
    armature_obj.select_set(False)


def create_basic_actions(armature_obj):
    def idle(frame):
        phase = (frame - 1) / 48 * math.tau
        set_pose_location(armature_obj, "hips", Vector((0, 0, math.sin(phase) * 0.015)), frame)
        set_pose_rotation(armature_obj, "spine", (math.sin(phase) * 0.025, 0, 0), frame)
        set_pose_rotation(armature_obj, "head", (math.sin(phase + 0.4) * 0.035, 0, math.sin(phase) * 0.02), frame)

    def walk(frame):
        phase = (frame - 1) / 24 * math.tau
        set_pose_rotation(armature_obj, "thigh.L", (math.sin(phase) * 0.42, 0, 0), frame)
        set_pose_rotation(armature_obj, "thigh.R", (math.sin(phase + math.pi) * 0.42, 0, 0), frame)
        set_pose_rotation(armature_obj, "shin.L", (max(0, -math.sin(phase)) * 0.36, 0, 0), frame)
        set_pose_rotation(armature_obj, "shin.R", (max(0, math.sin(phase)) * 0.36, 0, 0), frame)
        set_pose_rotation(armature_obj, "upper_arm.L", (math.sin(phase + math.pi) * 0.35, 0, 0), frame)
        set_pose_rotation(armature_obj, "upper_arm.R", (math.sin(phase) * 0.35, 0, 0), frame)
        set_pose_location(armature_obj, "hips", Vector((0, 0, abs(math.sin(phase)) * 0.02)), frame)

    def dance_groove(frame):
        phase = (frame - 1) / 64 * math.tau
        set_pose_location(armature_obj, "hips", Vector((math.sin(phase) * 0.018, 0, abs(math.sin(phase * 2)) * 0.012)), frame)
        set_pose_rotation(armature_obj, "spine", (0.035 + math.sin(phase * 2) * 0.02, math.sin(phase) * 0.06, math.sin(phase) * 0.045), frame)
        set_pose_rotation(armature_obj, "head", (math.sin(phase * 2) * 0.055, math.sin(phase) * 0.08, math.sin(phase + 1.2) * 0.045), frame)
        set_pose_rotation(armature_obj, "upper_arm.L", (math.sin(phase + 1.3) * 0.12, 0, 0.14 + math.sin(phase) * 0.08), frame)
        set_pose_rotation(armature_obj, "upper_arm.R", (math.sin(phase + 2.4) * 0.12, 0, -0.14 + math.sin(phase) * 0.08), frame)

    def dance_side(frame):
        phase = (frame - 1) / 84 * math.tau
        side = math.sin(phase)
        set_pose_location(armature_obj, "hips", Vector((side * 0.025, 0, abs(math.sin(phase * 2)) * 0.01)), frame)
        set_pose_rotation(armature_obj, "hips", (0, side * 0.08, side * 0.035), frame)
        set_pose_rotation(armature_obj, "spine", (0.03, side * 0.09, -side * 0.045), frame)
        set_pose_rotation(armature_obj, "head", (0.04, side * 0.14, -side * 0.04), frame)
        set_pose_rotation(armature_obj, "thigh.L", (max(0, side) * 0.09, 0, 0), frame)
        set_pose_rotation(armature_obj, "thigh.R", (max(0, -side) * 0.09, 0, 0), frame)

    def dance_head_touch(frame):
        phase = (frame - 1) / 96 * math.tau
        lift = max(0, math.sin(phase * 1.5))
        set_pose_location(armature_obj, "hips", Vector((math.sin(phase) * 0.018, 0, abs(math.sin(phase * 2)) * 0.012)), frame)
        set_pose_rotation(armature_obj, "spine", (0.035, math.sin(phase) * 0.06, math.sin(phase) * 0.045), frame)
        set_pose_rotation(armature_obj, "head", (0.055 + lift * 0.045, math.sin(phase) * 0.09, -lift * 0.045), frame)
        set_pose_rotation(armature_obj, "upper_arm.R", (lift * 0.16, -lift * 0.08, -0.08 + lift * 0.45), frame)
        set_pose_rotation(armature_obj, "forearm.R", (lift * 0.25, 0, lift * 0.14), frame)
        set_pose_rotation(armature_obj, "upper_arm.L", (math.sin(phase + 0.8) * 0.10, 0, 0.08 - lift * 0.12), frame)

    create_action(armature_obj, "idle", [1, 13, 25, 37, 49], idle)
    create_action(armature_obj, "walk", [1, 7, 13, 19, 25], walk)
    create_action(armature_obj, "dance_idle_groove_01", [1, 17, 33, 49, 65], dance_groove)
    create_action(armature_obj, "dance_side_step_turn_02", [1, 22, 43, 64, 85], dance_side)
    create_action(armature_obj, "dance_head_touch_groove_03", [1, 25, 49, 73, 97], dance_head_touch)


def export_glb(filepath):
    export_kwargs = {
        "filepath": str(filepath),
        "export_format": "GLB",
        "export_yup": True,
        "export_animations": True,
        "export_nla_strips": True,
        "export_skins": True,
        "export_normals": True,
        "export_tangents": True,
    }
    quality_kwargs = {
        **export_kwargs,
        "export_image_format": "AUTO",
        "export_image_quality": 100,
        "export_materials": "EXPORT",
        "export_draco_mesh_compression_enable": False,
    }
    try:
        bpy.ops.export_scene.gltf(**quality_kwargs)
    except TypeError:
        bpy.ops.export_scene.gltf(**export_kwargs)


def main():
    args = argv_after_double_dash()
    if len(args) != 2:
        usage()
        raise SystemExit(2)

    input_path = Path(args[0]).resolve()
    output_path = Path(args[1]).resolve()
    if not input_path.exists():
        raise RuntimeError(f"Input GLB does not exist: {input_path}")

    clear_scene()
    meshes = import_glb(input_path)
    preserve_mesh_visual_quality(meshes)
    bounds = scene_bounds(meshes)
    armature = create_humanoid_armature(bounds)
    bind_meshes(meshes, armature, bounds)
    preserve_mesh_visual_quality(meshes)
    create_basic_actions(armature)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    export_glb(output_path)
    print(f"Doorclub Blender autorig wrote {output_path}")


if __name__ == "__main__":
    main()
