'use strict'

/**
 * Preload for the DeepSeek Harness desktop shell.
 *
 * Renders the small floating "Update" button (bottom-right) and bridges its
 * click to the main process. Updates are strictly manual: nothing runs unless
 * the button (or the Help menu) is clicked.
 *
 * The button's click handler lives in the preload's isolated world, so it must
 * call ipcRenderer directly — the contextBridge-exposed `window.dshDesktop`
 * API exists only in the page's main world (kept for page-side callers).
 */

const { contextBridge, ipcRenderer } = require('electron')

/** Fire-and-forget delivery marker, then the real request. */
async function performUpdate() {
  ipcRenderer.send('dsh-desktop:update-clicked')
  return ipcRenderer.invoke('dsh-desktop:update')
}

contextBridge.exposeInMainWorld('dshDesktop', {
  update: () => performUpdate(),
})

function injectButton() {
  if (document.getElementById('dsh-desktop-update-button') !== null) return
  const btn = document.createElement('button')
  btn.id = 'dsh-desktop-update-button'
  btn.textContent = 'Update'
  btn.title = 'Check for updates from the DeepSeek Harness repo'
  Object.assign(btn.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483000',
    padding: '6px 14px',
    borderRadius: '999px',
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'rgba(32,32,40,0.85)',
    color: '#e8e8f0',
    fontSize: '13px',
    fontFamily: 'system-ui, sans-serif',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
  })
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Checking…'
    try {
      const result = await performUpdate()
      const status = result === null || result === undefined ? 'up-to-date' : result.status
      if (status === 'up-to-date') btn.textContent = 'Up to date'
      else if (status === 'restarting') btn.textContent = 'Restarting…'
      else if (status === 'check-failed' || status === 'error') btn.textContent = 'Update failed'
      else btn.textContent = 'Update'
    } catch {
      btn.textContent = 'Update failed'
    }
    window.setTimeout(() => {
      btn.disabled = false
      btn.textContent = 'Update'
    }, 3000)
  })
  ;(document.body || document.documentElement).appendChild(btn)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectButton)
} else {
  injectButton()
}
