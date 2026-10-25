import { formatLocale } from '@/lib/i18n'

const rtf = new Intl.RelativeTimeFormat(formatLocale, { numeric: 'auto' })
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
]

/** "3 giờ trước" / "hôm qua" for an ISO time, in the office locale. */
export function ago(iso: string, now = Date.now()): string {
  let v = (new Date(iso).getTime() - now) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit)
    v /= size
  }
  return rtf.format(Math.round(v), 'year')
}
