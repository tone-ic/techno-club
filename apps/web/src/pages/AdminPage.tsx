// apps/web/src/pages/AdminPage.tsx — TODO: Неделя 7
export default function AdminPage() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', background: 'var(--color-bg)',
      color: 'var(--color-text)', gap: 16,
    }}>
      <div style={{ fontSize: 11, color: 'var(--color-accent)', letterSpacing: 3 }}>DOOR//CLUB</div>
      <div style={{ fontSize: 18 }}>Admin Panel</div>
      <div style={{ fontSize: 13, color: 'var(--color-text-dim)' }}>Модерация — Неделя 7</div>
    </div>
  )
}
