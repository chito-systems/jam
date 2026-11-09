// Bottom panel height: dragged by its top edge, remembered per browser.

export const PANEL_DEFAULT = 184
const PANEL_MIN = 120
const KEY = 'jam.panel.h'

export const clampPanel = (h: number, viewport: number): number =>
  Math.round(Math.min(Math.max(h, PANEL_MIN), Math.max(PANEL_MIN, viewport * 0.7)))

export function loadPanelHeight(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return n ? clampPanel(n, window.innerHeight) : PANEL_DEFAULT
  } catch {
    return PANEL_DEFAULT
  }
}

export function savePanelHeight(h: number) {
  try {
    localStorage.setItem(KEY, String(h))
  } catch (e) {
    console.warn('saving the panel height failed; it resets on reload', e)
  }
}
