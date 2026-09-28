import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles/global.css'

let reloadedAfterWorkerChange = false

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A freshly activated worker can otherwise leave this tab running an old
    // hashed JavaScript bundle until the user manually reloads it.
    if (reloadedAfterWorkerChange) return
    reloadedAfterWorkerChange = true
    window.location.reload()
  })
}

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // The worker is built with autoUpdate, but force activation as a fallback
    // for browsers that report an update instead of applying it immediately.
    void updateSW(true)
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    void registration.update()
    window.setInterval(() => void registration.update(), 60 * 60 * 1000)
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
