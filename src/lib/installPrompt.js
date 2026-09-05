// Custom "add to home screen" prompt, shared by every page's topbar (2026-09-05
// multi-page revamp pulled this out of the old single main.js so Home/Mapping &
// Signal/Performance/API Documentation can each wire up the same #install-btn without
// duplicating the beforeinstallprompt/appinstalled dance four times over). The
// browser's own default install UI is inconsistent (a tiny address-bar icon on some
// browsers, nothing visible at all on others) and fires on its own schedule —
// capturing the event instead lets the app show one obvious button and trigger the
// native prompt whenever the user actually clicks it.
export function initInstallPrompt(installBtn) {
  let deferredPrompt = null

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e
    installBtn.hidden = false
  })

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return
    installBtn.hidden = true
    deferredPrompt.prompt()
    await deferredPrompt.userChoice
    deferredPrompt = null
  })

  // Already installed (or the browser installed it without ever asking) — nothing left
  // to prompt, so the button should never appear even if beforeinstallprompt fires late.
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true
    deferredPrompt = null
  })
}
