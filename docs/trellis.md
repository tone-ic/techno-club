# TRELLIS Avatar Pipeline

TRELLIS is the preferred replacement for Ready Player Me when we need a real image-to-3D model. The public Hugging Face Space is useful for manual tests, but the app must not depend on a public demo for production traffic.

## Target Flow

1. Browser captures one full-body photo:
   - full-body frame: source for TRELLIS mesh generation
   - derived face crop from the same frame: source for stylized fallback face texture and color analysis
2. Browser strips EXIF and compresses images.
3. `apps/api` creates an authenticated avatar job.
4. API optionally sends the compressed full-body image through KIE GPT Image 2 I2I to normalize a full-body, no-background input.
5. API sends one prepared image to TRELLIS image-to-3D generation.
6. TRELLIS runs image-to-3D and exports GLB.
8. API uploads GLB to Supabase Storage.
9. API saves:
   - `avatars.glb_url`
   - `avatars.config_json.modelUrl`
   - procedural fallback fields in `config_json`
10. Client renders `modelUrl` when present and falls back to procedural avatar if loading fails.

## Worker Contract

Use a private worker endpoint, not the public demo URL.
Configure it only in server-side API env:

```bash
TRELLIS_WORKER_PROVIDER=
TRELLIS_WORKER_URL=http://127.0.0.1:7860
TRELLIS_WORKER_TOKEN=
HF_TRELLIS_SPACE_ID=trellis-community/TRELLIS
SUPABASE_AVATAR_MODELS_BUCKET=avatar-models
KIE_API_KEYS=key_1,key_2,key_3
KIE_API_BASE_URL=https://api.kie.ai
KIE_POLL_TIMEOUT_MS=900000
BLENDER_AUTORIG_ENABLED=1
BLENDER_PATH=blender
BLENDER_AUTORIG_TIMEOUT_MS=180000
BLENDER_AUTORIG_REPLACE_MODEL_URL=1
```

For production, replace the local URL with a private GPU worker URL.

```http
POST /generate
Content-Type: application/json

{
  "image": "data:image/png;base64,...",
  "images": ["data:image/png;base64,..."],
  "multiImages": ["data:image/png;base64,..."],
  "isMultiimage": false,
  "style": "ps2_club_avatar",
  "qualityPreset": "max",
  "generationResolution": "1024",
  "maxTextureSize": 2048,
  "maxTriangles": 300000,
  "targetFaces": 300000,
  "ssGuidanceStrength": 8,
  "ssGuidanceRescale": 0.7,
  "ssSamplingSteps": 50,
  "ssRescaleT": 5,
  "shapeGuidance": 8,
  "shapeRescale": 0.5,
  "shapeSamplingSteps": 50,
  "shapeRescaleT": 3,
  "texGuidance": 10,
  "texRescale": 0,
  "texSamplingSteps": 50,
  "texRescaleT": 3,
  "textureSize": 2048
}
```

Expected response:

```json
{
  "modelUrl": "https://...",
  "format": "glb",
  "triangleCount": 10000
}
```

If the worker returns raw GLB bytes instead, `apps/api` should upload them to Supabase and return the resulting signed/public URL.

## Local Development

Local dev has two useful modes:

1. No GPU available:
   - leave `TRELLIS_WORKER_URL=` empty to use the public Hugging Face TRELLIS Space from the API
   - set `TRELLIS_WORKER_PROVIDER=disabled` only when you intentionally want to skip GLB generation and save the procedural PS2 fallback
   - this is enough to test auth, camera flow, Supabase writes, preview rendering, and multiplayer

2. NVIDIA GPU available:
   - run a local TRELLIS wrapper on `http://127.0.0.1:7860`
   - set `TRELLIS_WORKER_URL=http://127.0.0.1:7860`
   - keep `TRELLIS_WORKER_TOKEN=` empty unless the wrapper checks a Bearer token

3. No local GPU, manual/dev generation through Hugging Face Space:
   - set `TRELLIS_WORKER_PROVIDER=huggingface`
   - set `HF_TRELLIS_SPACE_ID=trellis-community/TRELLIS`
   - leave `TRELLIS_WORKER_URL=` empty
   - set `HF_TOKEN` only if the Space requires authenticated access
   - the API optionally uses KIE GPT Image 2 I2I to create one normalized full-body input, then sends that image through TRELLIS `/preprocess_image` and `/generate_and_extract_glb`.
   - the Hugging Face generation call uses SS Guidance `10`, SS Sampling `50`, SLAT Guidance `9`, SLAT Sampling `50`, mesh simplify `0.9`, 2048 texture size, and a 300 second timeout.

The local wrapper must expose only the `/generate` contract above. It can return JSON with `modelUrl` or raw GLB bytes. The player-facing Hugging Face flow calls the Space from the browser so ZeroGPU sees the player's network IP. The API only mirrors the resulting GLB into Supabase Storage.

## App Integration

- `POST /avatar/generate` receives the compressed full-body image and local procedural fallback config, then runs the one-shot TRELLIS flow.
- `POST /avatar/prepare-images` and `POST /avatar/generate-from-images` remain compatibility endpoints for older clients.
- KIE keys are configured only on the API as `KIE_API_KEYS`; the API rotates through them and tries the next key when KIE reports an exhausted or invalid key.
- The player-facing flow calls only `apps/api`; KIE keys and worker tokens are never exposed in `apps/web`.
- If TRELLIS is missing or fails, the API saves the fallback config with `modelUrl: null`.
- If a 3D worker returns raw GLB bytes, the API uploads them to the `avatar-models` Supabase Storage bucket and stores the public URL in `avatars.glb_url` and `config_json.modelUrl`.
- If a 3D worker returns a JSON `modelUrl`, the API downloads that GLB, uploads it to Supabase Storage, and stores the Supabase URL.
- By default, the API downloads the stored GLB, runs `apps/api/scripts/avatar-autorig.blender.py` through Blender headless, uploads the rigged GLB, and replaces `config_json.modelUrl` with the rigged URL. Set `BLENDER_AUTORIG_ENABLED=0` to disable this pass. If this pass fails, the original GLB remains the saved model.

## Free Local Blender Autorig

The local Blender autorig pass is the free alternative to paid autorig APIs. It is intentionally best-effort:

1. Import the generated GLB in Blender.
2. Estimate a humanoid armature from the model bounds.
3. Bind meshes with Blender automatic weights.
4. Add simple embedded clips named `idle`, `walk`, `dance_idle_groove_01`, `dance_side_step_turn_02`, and `dance_head_touch_groove_03`.
5. Export a rigged GLB back to Supabase Storage.

Requirements:

- Blender must be installed on the API host.
- `BLENDER_PATH` must point to the Blender executable if `blender` is not in `PATH`.
- Generated avatars should be front-facing humanoids, ideally A/T-pose. This is still much weaker than artist-quality rigging, so the client-side procedural rig remains the fallback.

## Mixamo-Compatible Rigging

Mixamo can be used as a manual rigging and animation step, but it should not be treated as an automated backend dependency. Adobe exposes Mixamo as a web workflow, not a supported public rigging API for app servers.

Supported path:

1. Export or convert the generated humanoid model into a Mixamo-accepted upload format.
2. Rig and apply animations in Mixamo with the user's own Adobe account.
3. Download the animated character, convert it to GLB if needed, and upload that GLB into the `avatar-models` bucket.
4. Store the uploaded GLB URL in `avatars.config_json.modelUrl`.

Client behavior:

- If `modelUrl` points to an unrigged TRELLIS GLB, `apps/web/src/utils/generatedAvatarRig.ts` builds the lightweight local rig and procedural walk/dance motions.
- If `modelUrl` points to a pre-rigged GLB with embedded animation clips, the client keeps the model skeleton and plays embedded clips with `THREE.AnimationMixer`.
- Remote players now receive `modelUrl` through the websocket payload, so rigged/generated GLBs can render for other clients too.

Clip naming hints:

- `walk`, `walking`, or `locomotion` are picked for movement.
- `idle`, `standing`, or `breathing` are picked for idle/groove fallback.
- `groove`, `dance`, `side step`, `head touch`, or `gesture` are picked for the club dance buttons.

## Product Constraints

- Keep local procedural generation as the offline/failure path.
- Never send original, uncompressed photos to the worker.
- Delete worker inputs and temporary outputs within 5 minutes.
- Downsample textures and prefer a stylized PS2 material pass before publishing the model.
- Do not expose Hugging Face tokens or worker URLs in `apps/web`.

## SOCKS5 proxy for generation / GLB extraction

Browsers cannot use SOCKS5 from JS, so proxying only works for server-side generation:

1. `apps/web/.env`: `VITE_AVATAR_GENERATION_MODE=server` (default `browser` = direct browser → Hugging Face).
2. `apps/api/.env`: `SOCKS5_PROXY=socks5://user:pass@host:1080`.
3. `pnpm --filter api proxy:check` prints the exit IP with/without the proxy and probes Hugging Face.

`apps/api/src/utils/socksProxy.ts` installs a global undici dispatcher, so `@gradio/client` (`generate_3d`,
`extract_glb_api`, `/preprocess_image`), the Space discovery and the GLB download all use the proxy.
Only hosts from `SOCKS5_PROXY_HOSTS` (default `huggingface.co,hf.space,gradio.live`) are proxied.
DNS is resolved by the proxy. `undici` is pinned to v6 to match the Node 20/22 built-in `fetch`
(on Node 24 use `undici@^7`).
