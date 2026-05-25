// apps/web/src/pages/BouncerPage.tsx
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { gameClient, getGameServerUrl } from '@/utils/wsClient'
import type { QueueEntry } from '@/utils/wsClient'
import { loadGeneratedAvatarRig, type GeneratedAvatarRig } from '@/utils/generatedAvatarRig'
import { usePlayerStore } from '@/store/playerStore'
import * as THREE from 'three'

const REASONS = [
  { code: 'vibe_check',   label: 'Не прошёл вайб-чек' },
  { code: 'dress_code',   label: 'Не тот дресс-код' },
  { code: 'overcrowded',  label: 'Клуб переполнен' },
  { code: 'behavior',     label: 'Поведение в очереди' },
  { code: 'closed_event', label: 'Закрытое мероприятие' },
]

export default function BouncerPage() {
  const navigate = useNavigate()
  const role = usePlayerStore((state) => state.role)
  const [queue,       setQueue]       = useState<QueueEntry[]>([])
  const [selected,    setSelected]    = useState<QueueEntry | null>(null)
  const [showReasons, setShowReasons] = useState(false)
  const [log,         setLog]         = useState<string[]>([])

  useEffect(() => {
    if (role !== 'bouncer' && role !== 'owner' && role !== 'admin') {
      navigate('/outside', { replace: true })
      return
    }

    const applyQueue = (nextQueue: QueueEntry[]) => {
      setQueue(nextQueue)
      setSelected(prev => {
        if (!prev) return prev
        return nextQueue.find(entry => entry.id === prev.id) ?? null
      })
    }

    gameClient.setCallbacks({
      onWelcome:      (_,__,___,____,_role,q)=>{ if(q) applyQueue(q as QueueEntry[]) },
      onPlayerJoined: ()=>{},
      onPlayerMoved:  ()=>{},
      onPlayerLeft:   ()=>{},
      onQueueUpdate:  (q)=>applyQueue(q),
    })

    if (!gameClient.id) {
      gameClient.connect(getGameServerUrl(), { displayName:'Bouncer', role:'bouncer' })
        .catch(()=>{})
    } else {
      gameClient.setRole('bouncer')
    }
  }, [navigate, role])

  const approve = (entry: QueueEntry) => {
    gameClient.approve(entry.id)
    addLog(`✓ Впустил ${entry.displayName}`)
    setSelected(null)
  }

  const deny = (entry: QueueEntry, reason: string) => {
    gameClient.deny(entry.id, reason)
    addLog(`✗ Отказал ${entry.displayName} (${reason})`)
    setSelected(null); setShowReasons(false)
  }

  const addLog = (msg: string) =>
    setLog(prev => [`${new Date().toLocaleTimeString('ru')}  ${msg}`, ...prev].slice(0, 50))

  const s = {
    page:   { minHeight:'100vh', background:'#0d0d1a', color:'#e8e8f0', fontFamily:'monospace', display:'flex', flexDirection:'column' as const },
    header: { padding:'14px 20px', borderBottom:'1px solid #1a1a2e', display:'flex', alignItems:'center', justifyContent:'space-between' },
    title:  { fontSize:13, color:'#d8b06f', letterSpacing:3 },
    body:   { display:'flex', flex:1, overflow:'hidden' },
    left:   { width:260, borderRight:'1px solid #1a1a2e', overflowY:'auto' as const, padding:12 },
    center: { flex:1, display:'flex', flexDirection:'column' as const, alignItems:'center', justifyContent:'center', padding:20 },
    right:  { width:220, borderLeft:'1px solid #1a1a2e', overflowY:'auto' as const, padding:12 },
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div style={s.title}>DOOR//CLUB — ФЕЙСКОНТРОЛЬ</div>
        <div style={{display:'flex',gap:8}}>
          <span style={{fontSize:11,color:'#555',alignSelf:'center'}}>{queue.length} в очереди</span>
          <button onClick={()=>navigate('/outside')} style={{background:'transparent',border:'1px solid #333',borderRadius:4,color:'#888',fontFamily:'monospace',fontSize:11,padding:'5px 12px',cursor:'pointer'}}>
            ← НА УЛИЦУ
          </button>
        </div>
      </div>

      <div style={s.body}>
        {/* Queue list */}
        <div style={s.left}>
          <div style={{fontSize:10,color:'#555',letterSpacing:2,marginBottom:10}}>ОЧЕРЕДЬ</div>
          {queue.length === 0 && <div style={{fontSize:12,color:'#333',textAlign:'center',marginTop:40}}>пусто</div>}
          {queue.map(entry => (
            <div key={entry.id} onClick={()=>{setSelected(entry);setShowReasons(false)}}
              style={{
                padding:'10px 12px', borderRadius:6, marginBottom:6, cursor:'pointer',
                border: selected?.id===entry.id ? '1px solid #e040fb' : '1px solid #1a1a2e',
                background: selected?.id===entry.id ? 'rgba(224,64,251,0.08)' : 'rgba(255,255,255,0.02)',
                display:'flex', alignItems:'center', gap:10,
              }}>
              <div style={{width:28,height:28,borderRadius:'50%',background:entry.topColor,border:'1px solid #333',flexShrink:0}}/>
              <div>
                <div style={{fontSize:12,color:'#e8e8f0'}}>{entry.displayName}</div>
                <div style={{fontSize:10,color:'#555'}}>#{entry.pos} в очереди</div>
              </div>
            </div>
          ))}
        </div>

        {/* Center — avatar preview + actions */}
        <div style={s.center}>
          {!selected ? (
            <div style={{textAlign:'center',color:'#333',fontSize:13}}>
              ← выбери игрока<br/>из очереди
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:16}}>
              <div style={{fontSize:11,color:'#e040fb',letterSpacing:2}}>{selected.displayName.toUpperCase()}</div>
              <div style={{fontSize:11,color:'#555'}}>#{selected.pos} в очереди</div>

              <AvatarMini entry={selected}/>

              {!showReasons ? (
                <div style={{display:'flex',gap:10,marginTop:8}}>
                  <button onClick={()=>approve(selected)} style={{
                    padding:'12px 28px',background:'#00cc66',border:'none',borderRadius:4,
                    color:'#001a0d',fontFamily:'monospace',fontSize:13,fontWeight:700,cursor:'pointer',letterSpacing:1,
                  }}>✓ ВПУСТИТЬ</button>
                  <button onClick={()=>setShowReasons(true)} style={{
                    padding:'12px 28px',background:'#cc2200',border:'none',borderRadius:4,
                    color:'#fff',fontFamily:'monospace',fontSize:13,fontWeight:700,cursor:'pointer',letterSpacing:1,
                  }}>✗ ОТКАЗАТЬ</button>
                </div>
              ) : (
                <div style={{display:'flex',flexDirection:'column',gap:6,width:220}}>
                  <div style={{fontSize:11,color:'#ff6666',marginBottom:4,textAlign:'center'}}>Выбери причину отказа:</div>
                  {REASONS.map(r=>(
                    <button key={r.code} onClick={()=>deny(selected,r.code)} style={{
                      padding:'9px 12px',background:'rgba(200,30,0,0.15)',border:'1px solid #551100',
                      borderRadius:4,color:'#ff8866',fontFamily:'monospace',fontSize:11,cursor:'pointer',textAlign:'left',
                    }}>{r.label}</button>
                  ))}
                  <button onClick={()=>setShowReasons(false)} style={{
                    padding:'8px',background:'transparent',border:'1px solid #333',borderRadius:4,
                    color:'#555',fontFamily:'monospace',fontSize:11,cursor:'pointer',marginTop:4,
                  }}>Отмена</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Log */}
        <div style={s.right}>
          <div style={{fontSize:10,color:'#555',letterSpacing:2,marginBottom:10}}>ЛОГ</div>
          {log.map((l,i)=>(
            <div key={i} style={{fontSize:11,color:l.includes('✓')?'#00cc66':'#ff6666',marginBottom:5,lineHeight:1.4,wordBreak:'break-all'}}>
              {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Mini 3D avatar ────────────────────────────────────────────────────────────
export function AvatarMini({ entry }: { entry: QueueEntry }) {
  const ref    = useRef<HTMLCanvasElement>(null)
  const rotY   = useRef(Math.PI)   // смотрит вперёд
  const drag   = useRef(false)
  const lastX  = useRef(0)
  const zoom   = useRef(false)     // режим зума на лицо
  const [isZoom, setIsZoom] = useState(false)

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true })
    renderer.setSize(220, 300); renderer.setClearColor(0, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene  = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 220/300, 0.1, 50)

    // Нормальная позиция
    const CAM_FULL = { pos: new THREE.Vector3(0, 1.8, 3.5), look: new THREE.Vector3(0, 1.4, 0) }
    // Зум на лицо
    const CAM_FACE = { pos: new THREE.Vector3(0, 1.86, 1.1), look: new THREE.Vector3(0, 1.86, 0) }

    camera.position.copy(CAM_FULL.pos)
    camera.lookAt(CAM_FULL.look)

    scene.add(new THREE.AmbientLight(0xffffff, 2.0))
    const dir = new THREE.DirectionalLight(0xaabbff, 1.8); dir.position.set(3,6,4); scene.add(dir)
    const fill = new THREE.PointLight(0xe040fb, 3, 8); fill.position.set(-2,3,2); scene.add(fill)

    const toHex = (s: string, fb: number) => {
      const rgb = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
      if (rgb) return (parseInt(rgb[1])<<16)|(parseInt(rgb[2])<<8)|parseInt(rgb[3])
      const n = parseInt(s.replace('#',''), 16); return isNaN(n) ? fb : n
    }
    const M = (c: number) => new THREE.MeshLambertMaterial({ color: c })
    const bx = (w:number,h:number,d:number,x:number,y:number,z:number,m:THREE.Material,p:THREE.Object3D) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), m)
      mesh.position.set(x,y,z); p.add(mesh); return mesh
    }

    const g = new THREE.Group(); scene.add(g)
    let generatedRig: GeneratedAvatarRig | null = null
    let disposed = false
    const skin = M(toHex(entry.skinTone,  0xc8956c))
    const topM = M(toHex(entry.topColor,  0x222244))
    const botM = M(toHex(entry.bottomColor,0x111133))
    const hair = M(toHex(entry.hairColor,  0x1a1008))
    const shoe = M(0x111111)

    // Торс
    const torso  = bx(0.55,0.75,0.3, 0,1.3,0, topM, g)
    // Голова
    const hg = new THREE.SphereGeometry(0.21,8,6); hg.scale(0.95,1.1,0.9)
    const hm = new THREE.Mesh(hg, skin); hm.position.set(0,1.86,0); g.add(hm)
    // Волосы
    const hrg = new THREE.SphereGeometry(0.215,7,4,0,Math.PI*2,0,Math.PI*0.52)
    const hrm = new THREE.Mesh(hrg, hair); hrm.position.set(0,1.99,-0.04); g.add(hrm)
    // Руки
    const armL = bx(0.18,0.65,0.18,-0.37,1.25,0, topM, g)
    const armR = bx(0.18,0.65,0.18, 0.37,1.25,0, topM, g)
    bx(0.16,0.18,0.16,-0.37,0.87,0, skin, g)
    bx(0.16,0.18,0.16, 0.37,0.87,0, skin, g)
    // Ноги
    const legL = bx(0.23,0.75,0.23,-0.15,0.6,0, botM, g)
    const legR = bx(0.23,0.75,0.23, 0.15,0.6,0, botM, g)
    bx(0.24,0.16,0.3,-0.15,0.16,0.04, shoe, g)
    bx(0.24,0.16,0.3, 0.15,0.16,0.04, shoe, g)

    // ── Лицо ───────────────────────────────────────────
    if (entry.faceTextureUrl) {
      const img = new Image()
      img.onload = () => {
        const cv = document.createElement('canvas'); cv.width=256; cv.height=256
        const ctx = cv.getContext('2d')!
        ctx.clearRect(0,0,256,256); ctx.save(); ctx.beginPath()
        ctx.ellipse(128,128,112,126,0,0,Math.PI*2); ctx.clip()
        ctx.drawImage(img,0,0,256,256); ctx.restore()
        const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.NoColorSpace
        const fp = new THREE.Mesh(
          new THREE.PlaneGeometry(0.38,0.43),
          new THREE.MeshBasicMaterial({map:tex,transparent:true,alphaTest:0.1,depthWrite:false})
        )
        fp.position.set(0,1.86,0.22); g.add(fp)
      }
      img.src = entry.faceTextureUrl
    }

    // ── Текстуры одежды из фото ─────────────────────────
    if (entry.bodyTextureUrl) {
      const applyZone = (dataUrl: string, zone: 'top'|'bottom') => {
        const img = new Image()
        img.onload = () => {
          const cv = document.createElement('canvas'); cv.width=128; cv.height=128
          const ctx = cv.getContext('2d')!
          const sx = img.width  * (zone==='top' ? 0.36 : 0.38)
          const sy = img.height * (zone==='top' ? 0.17 : 0.44)
          const sw = img.width  * (zone==='top' ? 0.28 : 0.24)
          const sh = img.height * (zone==='top' ? 0.32 : 0.40)
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 128, 128)
          const tex = new THREE.CanvasTexture(cv)
          tex.colorSpace = THREE.NoColorSpace
          const mat = new THREE.MeshBasicMaterial({ map: tex })
          if (zone === 'top') {
            torso.material = mat
            armL.material  = mat
            armR.material  = mat
          } else {
            legL.material  = mat
            legR.material  = mat
          }
        }
        img.src = dataUrl
      }
      applyZone(entry.bodyTextureUrl, 'top')
      applyZone(entry.bodyTextureUrl, 'bottom')
    }

    if (entry.modelUrl) {
      void loadGeneratedAvatarRig(entry.modelUrl, { rotationY: Math.PI, targetHeight: 2.15 })
        .then((rig) => {
          if (disposed) {
            rig.reset()
            return
          }
          generatedRig = rig
          g.children.forEach((child) => {
            child.visible = false
          })
          g.add(rig.root)
        })
        .catch((loadError) => {
          console.warn('[Bouncer avatar] GLB load failed:', loadError)
        })
    }

    // ── Drag вращение ───────────────────────────────────
    const onMouseDown = (e: MouseEvent) => { drag.current=true; lastX.current=e.clientX }
    const onMouseMove = (e: MouseEvent) => {
      if (!drag.current) return
      rotY.current += (e.clientX-lastX.current)*0.014
      lastX.current = e.clientX
    }
    const onMouseUp   = () => { drag.current=false }

    const onTouchStart = (e: TouchEvent) => { drag.current=true; lastX.current=e.touches[0].clientX }
    const onTouchMove  = (e: TouchEvent) => {
      if (!drag.current) return
      rotY.current += (e.touches[0].clientX-lastX.current)*0.014
      lastX.current = e.touches[0].clientX
    }
    const onTouchEnd   = () => { drag.current=false }

    canvas.addEventListener('mousedown',  onMouseDown)
    window.addEventListener('mousemove',  onMouseMove)
    window.addEventListener('mouseup',    onMouseUp)
    canvas.addEventListener('touchstart', onTouchStart, { passive:true })
    canvas.addEventListener('touchmove',  onTouchMove,  { passive:true })
    canvas.addEventListener('touchend',   onTouchEnd)

    // ── Анимация ────────────────────────────────────────
    let animId: number
    let autoT = 0
    const animate = () => {
      animId = requestAnimationFrame(animate)

      // Камера плавно переходит при зуме
      const target = zoom.current ? CAM_FACE : CAM_FULL
      camera.position.lerp(target.pos, 0.08)
      camera.lookAt(camera.position.clone().lerp(target.look, 0.15))

      // Авто-покачивание если не тянут
      if (!drag.current) {
        autoT += 0.006
        g.rotation.y = rotY.current + Math.sin(autoT)*0.12
      } else {
        g.rotation.y = rotY.current
      }

      generatedRig?.dance(autoT * 20, false, autoT * 10, 'dance_idle_groove_01')
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      disposed = true
      generatedRig?.reset()
      cancelAnimationFrame(animId)
      canvas.removeEventListener('mousedown',  onMouseDown)
      window.removeEventListener('mousemove',  onMouseMove)
      window.removeEventListener('mouseup',    onMouseUp)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove',  onTouchMove)
      canvas.removeEventListener('touchend',   onTouchEnd)
      renderer.dispose()
    }
  }, [entry.id, entry.modelUrl]) // eslint-disable-line

  const toggleZoom = () => {
    zoom.current = !zoom.current
    setIsZoom(z => !z)
  }

  return (
    <div style={{ position:'relative', userSelect:'none' }}>
      <canvas ref={ref} style={{
        width:220, height:300, borderRadius:8,
        border:'1px solid #1a1a2e', cursor:'grab',
        background:'linear-gradient(180deg,#0d0d1a 0%,#180d26 100%)',
        display:'block',
      }}/>
      {/* Кнопка зума на лицо */}
      <button onClick={toggleZoom} style={{
        position:'absolute', top:8, right:8,
        background: isZoom ? 'rgba(224,64,251,0.3)' : 'rgba(13,13,26,0.8)',
        border:'1px solid #2a2a3a', borderRadius:4,
        color: isZoom ? '#e040fb' : '#666',
        fontFamily:'monospace', fontSize:10, padding:'4px 8px',
        cursor:'pointer', letterSpacing:1,
      }}>
        {isZoom ? '↙ ВСЕ ТЕЛО' : '🔍 ЛИЦО'}
      </button>
      {entry.bodyTextureUrl && (
        <div style={{
          position:'absolute', top:8, left:8,
          width:46, height:76, borderRadius:4,
          border:'1px solid #2a2a3a',
          background:'rgba(13,13,26,0.85)',
          overflow:'hidden',
        }}>
          <img src={entry.bodyTextureUrl} alt="" style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/>
          <div style={{
            position:'absolute', left:0, right:0, bottom:0,
            background:'rgba(13,13,26,0.82)',
            color:'#e040fb', fontFamily:'monospace', fontSize:8,
            textAlign:'center', letterSpacing:1, padding:'2px 0',
          }}>
            ТЕЛО
          </div>
        </div>
      )}
      <div style={{
        position:'absolute', bottom:8, left:0, right:0,
        textAlign:'center', fontSize:9, color:'#2a2a3a',
        fontFamily:'monospace', pointerEvents:'none',
      }}>
        ← тяни для вращения →
      </div>
    </div>
  )
}
