
import { t as translate } from '@/lib/i18n'
import type { Metadata, Viewport } from 'next'
import { Be_Vietnam_Pro, Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'

/* OXMODE type: Be Vietnam Pro (headings), Inter (UI), JetBrains Mono (labels/code).
   Self-hosted by next/font at build time; the Vietnamese subset covers the UI copy. */
const head = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-oxm-head',
  display: 'swap',
})
const body = Inter({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-oxm-body',
  display: 'swap',
})
const mono = JetBrains_Mono({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600'],
  variable: '--font-oxm-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Hermes Virtual Office',
  description:
    translate("layout.text1"),
}

/**
 * Next sudah mengirim width=device-width & initial-scale=1 sendiri; yang ditambahkan:
 * - viewportFit cover: tanpa ini env(safe-area-inset-*) selalu 0, jadi HP berponi /
 *   gesture bar tidak bisa dihormati oleh CSS.
 * - interactiveWidget resizes-content: di Chrome Android keyboard layar mengecilkan
 *   viewport (dan 100dvh), sehingga input chat terdorong naik, bukan tertutup.
 * Zoom pengguna sengaja TIDAK dikunci; masalah auto-zoom iOS diselesaikan dengan
 * font input 16px di globals.css.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: '#050117',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${head.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
