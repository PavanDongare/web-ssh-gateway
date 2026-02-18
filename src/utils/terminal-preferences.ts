/**
 * Terminal preferences manager — ported from vibetunnel.
 * Singleton that persists user preferences to localStorage.
 */

import type { TerminalThemeId } from './terminal-themes'

export interface TerminalPreferences {
  maxCols: number       // 0 = unlimited
  fontSize: number
  fitHorizontally: boolean
  theme: TerminalThemeId
}

// Common terminal column widths for the settings UI
export const COMMON_TERMINAL_WIDTHS = [
  { value: 0,   label: '∞',   description: 'Unlimited (full width)' },
  { value: 80,  label: '80',  description: 'Classic terminal' },
  { value: 100, label: '100', description: 'Modern standard' },
  { value: 120, label: '120', description: 'Wide terminal' },
  { value: 132, label: '132', description: 'Mainframe width' },
  { value: 160, label: '160', description: 'Ultra-wide' },
] as const

const isMobile = () =>
  typeof window !== 'undefined' && window.innerWidth < 768

const DEFAULT_PREFERENCES: TerminalPreferences = {
  maxCols: 0,
  fontSize: isMobile() ? 12 : 14,
  fitHorizontally: false,
  theme: 'dracula',
}

const STORAGE_KEY = 'webssh_terminal_preferences'

export class TerminalPreferencesManager {
  private static instance: TerminalPreferencesManager
  private prefs: TerminalPreferences

  private constructor() {
    this.prefs = this.load()
  }

  static getInstance(): TerminalPreferencesManager {
    if (!TerminalPreferencesManager.instance) {
      TerminalPreferencesManager.instance = new TerminalPreferencesManager()
    }
    return TerminalPreferencesManager.instance
  }

  private load(): TerminalPreferences {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
      if (raw) return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) }
    } catch {
      // ignore
    }
    return { ...DEFAULT_PREFERENCES }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs))
    } catch {
      // ignore
    }
  }

  getMaxCols()        { return this.prefs.maxCols }
  getFontSize()       { return this.prefs.fontSize }
  getFitHorizontally(){ return this.prefs.fitHorizontally }
  getTheme()          { return this.prefs.theme }
  getPreferences()    { return { ...this.prefs } }

  setMaxCols(v: number)           { this.prefs.maxCols = Math.max(0, v);             this.save() }
  setFontSize(v: number)          { this.prefs.fontSize = Math.max(8, Math.min(32, v)); this.save() }
  setFitHorizontally(v: boolean)  { this.prefs.fitHorizontally = v;                  this.save() }
  setTheme(v: TerminalThemeId)    { this.prefs.theme = v;                            this.save() }

  resetToDefaults() {
    this.prefs = { ...DEFAULT_PREFERENCES }
    this.save()
  }
}
