import { useNavigate } from 'react-router-dom'
import AvatarPreview3D from '@/components/AvatarPreview3D'
import { usePlayerStore } from '@/store/playerStore'

export default function AvatarPage() {
  const navigate = useNavigate()
  const avatarConfig = usePlayerStore((state) => state.avatarConfig)

  if (!avatarConfig) {
    return (
      <div style={styles.screen}>
        <div style={styles.brand}>DOOR//CLUB</div>
        <div style={styles.title}>Аватар не создан</div>
        <button style={styles.primaryButton} onClick={() => navigate('/camera')}>СОЗДАТЬ</button>
      </div>
    )
  }

  return (
    <div style={styles.screen}>
      <div style={styles.brand}>DOOR//CLUB</div>
      <div style={styles.title}>Аватар</div>
      <AvatarPreview3D config={avatarConfig} width={280} height={380} />
      <div style={styles.swatches}>
        <span style={{ ...styles.swatch, background: avatarConfig.skinTone }} />
        <span style={{ ...styles.swatch, background: avatarConfig.hairColor }} />
        <span style={{ ...styles.swatch, background: avatarConfig.topColor }} />
        <span style={{ ...styles.swatch, background: avatarConfig.bottomColor }} />
        <span style={{ ...styles.swatch, background: avatarConfig.shoesColor }} />
      </div>
      <div style={styles.actions}>
        <button style={styles.primaryButton} onClick={() => navigate('/outside')}>НА УЛИЦУ</button>
        <button style={styles.ghostButton} onClick={() => navigate('/camera')}>ПЕРЕСОЗДАТЬ</button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  screen: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: 'var(--color-bg)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-mono)',
    padding: 16,
  },
  brand: {
    fontSize: 11,
    color: 'var(--color-accent)',
    letterSpacing: 3,
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 14,
  },
  actions: {
    display: 'flex',
    gap: 10,
    marginTop: 18,
  },
  primaryButton: {
    minHeight: 42,
    padding: '12px 24px',
    background: 'var(--color-accent)',
    color: 'var(--color-bg)',
    borderRadius: 4,
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 1,
    cursor: 'pointer',
  },
  ghostButton: {
    minHeight: 42,
    padding: '12px 20px',
    background: 'transparent',
    color: 'var(--color-text-dim)',
    border: '1px solid #333',
    borderRadius: 4,
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    cursor: 'pointer',
  },
  swatches: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 3,
    border: '1px solid rgba(255,255,255,0.18)',
  },
}
