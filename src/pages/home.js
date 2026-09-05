// Shared entry point for the site's static, no-data-fetching pages — Home
// (index.html) and API Documentation (api/index.html) — introduced in the 2026-09-05
// multi-page revamp. Neither page needs price polling, signal/zone detection, or any
// of the libraries that pull those in; both just need the install-prompt wiring every
// page shares.
import '../style.css'
import { initInstallPrompt } from '../lib/installPrompt.js'

initInstallPrompt(document.getElementById('install-btn'))
