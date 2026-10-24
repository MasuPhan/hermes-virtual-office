import type { AgentRole } from '@/types/hermes'
import { ROLE_COLORS } from './layout'

/**
 * How one agent looks in 2D: shirt by role, skin and hair picked from the name.
 *
 * Shared by the pixel office (SpriteOffice) and the /team portraits, so an agent
 * wears the same colours in both places and changing the formula in one cannot
 * leave the other drawing a stranger.
 */
export function personLook(name: string, role: AgentRole | null | undefined): { shirt: string; skin: string; hair: string } {
  const seed = [...name].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) | 0, 7) >>> 0
  return {
    shirt: `#${((role && ROLE_COLORS[role]) ?? 0x5b91a6).toString(16).padStart(6, '0')}`,
    skin: ['#f0c49c', '#d79a71', '#b4765a', '#e8b489', '#7f513e'][seed % 5],
    hair: ['#2f2a2b', '#584033', '#1d2a2f', '#a25d3c', '#c3a05e'][seed % 5],
  }
}
