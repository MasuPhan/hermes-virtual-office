/**
 * 3D office palette — the ONE place the 3D view's colours are decided.
 *
 * Two layers:
 *  - Semantic tokens (SKY, FOG, ENV, LIGHTS, GLOW, MAT) for everything that sets the mood:
 *    sky, fog, reflections, lights, emissive screens/strips and the shared PBR materials.
 *  - `pal()` / `palCss()` for the long tail of prop colours in build.ts. Each call site
 *    keeps its original ("legacy") colour as the key; the active theme maps that key to the
 *    colour actually drawn. Same legacy colour = same role (e.g. 0x8a8f95 is every steel
 *    rail/post), so one table entry re-skins every prop of that role.
 *
 * Colours are sRGB hex. Three converts them to linear on assignment (ColorManagement on),
 * and canvas strings are drawn into SRGBColorSpace textures, so both stay consistent.
 */

/** Theme map for prop colours. Identity = the legacy look. */
const PROP_MAP = new Map<number, number>()

/** Map a legacy prop colour to the active theme. */
export function pal(hex: number): number {
  return PROP_MAP.get(hex) ?? hex
}

/** Same as `pal`, for canvas fill/stroke strings ('#rrggbb'). */
export function palCss(css: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(css)
  if (!m) return css
  const out = pal(parseInt(m[1], 16))
  return `#${out.toString(16).padStart(6, '0')}`
}

/** Background gradient stops, top → bottom (equirect). */
export const SKY = {
  day: ['#9dc4e8', '#c6dcef', '#e2edf6', '#eef4f8'] as [string, string, string, string],
  night: ['#20344d', '#31465f', '#4a6076', '#63798c'] as [string, string, string, string],
}

export const FOG = { day: 0xd3e2ef, night: 0x54697d, near: 80, far: 220 }

/** Reflection environment (PMREM source): gradient stops + soft light panels. */
export const ENV = {
  stops: [
    [0, '#dfefff'],
    [0.42, '#bcd6ea'],
    [0.5, '#f4e6cf'],
    [0.62, '#6a6152'],
    [1, '#241f1a'],
  ] as [number, string][],
  panelCore: '#ffffff',
  panelMid: 'rgba(255,246,224,0.85)',
  panelEdge: 'rgba(255,246,224,0)',
}

export const RENDER = { exposure: 1.1 }

/** Light colours/intensities. `day`/`night` pairs are applied by build.ts `applyPalette`. */
export const LIGHTS = {
  ambient: { color: 0xffffff, day: 0.24, night: 0.24 },
  sun: { day: { color: 0xfff4e2, intensity: 2.6 }, night: { color: 0xc9d8ee, intensity: 1.2 } },
  hemi: { sky: 0xdfeaf7, ground: 0x8a7a5f, day: 0.45, night: 0.35 },
  /** ceiling light panels' point lights */
  ceiling: { color: 0xfff6e6, intensity: 0.5 },
  /** desk lamps (point light) */
  deskLamp: { color: 0xffdcae, initDay: 0.12, initNight: 0.5, day: 0.25, night: 0.85 },
  street: { color: 0xfff0cf, day: 0.1, night: 1.0 },
  bbq: { color: 0xff7a2e, intensity: 0.5 },
}

/** Emissive "glow" sources. */
export const GLOW = {
  /** desk / exec monitors */
  monitor: { emissive: 0x1d3b4a, ei: 0.55 },
  /** ceiling light strips (the `streaks`) */
  strip: { color: 0xffffff, emissive: 0xfff4e0, ei: 1, day: 0.85, night: 1.5 },
  /** desk lamp shade */
  lampShade: { color: 0xf0e2c4, emissive: 0xffd89a, day: 0.2, night: 0.9 },
}

/** Shared PBR material colours (materials.ts). */
export const MAT = {
  marble: { base: '#efe9dc', veinA: '#c9c2b2', veinB: '#d8d2c2', grout: '#b9b2a2', roughness: 0.08, metalness: 0.35, env: 1.6 },
  wood: { base: '#9a7449', grainA: '#7d5c36', grainB: '#b08a5c' },
  glass: { color: 0xd6e8f0, opacity: 0.5 },
  stone: { base: '#6f7a82', specA: '#59636b', specB: '#8b959d' },
  plaster: 0xf2f4f4,
  panelDark: { base: '#3a2b1e', seam: '#2a1e14', grainA: '#4a3728', grainB: '#2e2116' },
  carpet: { base: '#8b8f93', fiberA: '#6f7377', fiberB: '#a3a7ab' },
  accent: { color: 0xc9a24a, metalness: 0.9, roughness: 0.28 },
}
