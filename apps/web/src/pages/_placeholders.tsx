// apps/web/src/pages/AvatarPage.tsx — TODO: Неделя 2
export default function AvatarPage() {
  return <PageShell title="Аватар" week={2} desc="Редактор внешнего вида персонажа" />
}

// ─────────────────────────────────────────────────────────────────────────────

// apps/web/src/pages/OutsidePage.tsx — TODO: Неделя 2-3
// Главная игровая сцена — улица перед клубом
// Здесь будет PlayCanvas сцена + Colyseus + LiveKit

// eslint-disable-next-line import/no-anonymous-default-export
export { default as OutsidePage } from './OutsidePage'

function PageShell({ title, week, desc }: { title: string; week: number; desc: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', background: 'var(--color-bg)',
      color: 'var(--color-text)', gap: 12, padding: 24,
    }}>
      <div style={{ fontSize: 11, color: 'var(--color-accent)', letterSpacing: 3 }}>DOOR//CLUB</div>
      <div style={{ fontSize: 22 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--color-text-dim)', textAlign: 'center' }}>{desc}</div>
      <div style={{ marginTop: 32, fontSize: 11, color: '#333' }}>
        в разработке — Неделя {week}
      </div>
    </div>
  )
}
