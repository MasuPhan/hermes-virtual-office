import { createInstance } from 'i18next'
import vi from '@/locales/vi.json'

/** Fixed Vietnamese locale on both server and client; no browser detection/hydration drift. */
export const locale = 'vi' as const
export const formatLocale = 'vi-VN' as const
export const i18n = createInstance()
void i18n.init({
  lng: locale,
  fallbackLng: false,
  supportedLngs: [locale],
  resources: { vi: { translation: vi } },
  initImmediate: false,
  keySeparator: false,
  interpolation: { escapeValue: false }, // React escapes text at the rendering boundary.
})
export type MessageKey = keyof typeof vi
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  if (!i18n.exists(key)) throw new Error(`Missing i18n key: ${key}`)
  return i18n.t(key, values) as string
}
