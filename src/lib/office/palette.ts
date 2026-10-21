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

/* ------------------------------------------------------------------ OXMODE --
 * Brand reference (oxmode.ai): bg #050117 / #08021c / #110337 / #1a0450 / #240568,
 * brand violet #380995, violet #6d45e0 / #8e70f5, cyan #2efcff (light #6cf8ff).
 * Rule: neutral, readable base; brand colours only on accents (screens, LEDs, signage).
 */

type Hsl = [number, number, number]
function toHsl(hex: number): Hsl {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
function fromHsl(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255)
  return (c(f(0)) << 16) | (c(f(8)) << 8) | c(f(4))
}

/**
 * Re-skin rule for prop colours that have no explicit entry below. Readability first:
 * the legacy palette keeps its value contrast (walls / floors / furniture / outdoor), so
 * colours stay as they were; only near-greys get a slight cool (blue-grey) tint toward the
 * brand. Brand violet/cyan never washes large surfaces — it lives in OVERRIDES (accents).
 */
function reskin(hex: number): number {
  const [h, s, l] = toHsl(hex)
  if (s < 0.1 && l > 0.04 && l < 0.97) return fromHsl(s < 0.02 ? 215 : h * 0.4 + 215 * 0.6, s + 0.05, l)
  return hex
}

/** Accent picks: screens, LEDs, signage. Key = legacy colour. */
const OVERRIDES: [number, number][] = [
  [0xc9a24a, 0x2efcff], // gold trim / plaque border -> brand cyan (signage)
  [0xa89a72, 0x8e70f5], // plaque sub text -> violet
  [0x2a1f16, 0x110337], // plaque / name plate panel -> deep brand
  [0x2a4a5a, 0x6d45e0], // TV standby glow -> violet
  [0x3a5a6a, 0x2efcff], // racing-rig screen glow
  [0x2a5a8a, 0x2efcff], // bowling score screen glow
  [0x0d1c28, 0x380995], // wall TV standby glow
  [0x224a3a, 0x2efcff], // dart scoreboard glow
  [0x4ad07a, 0x2efcff], // server status LEDs
]

const PROP_MAP = new Map<number, number>(OVERRIDES)

/** Map a legacy prop colour to the active theme. */
export function pal(hex: number): number {
  let out = PROP_MAP.get(hex)
  if (out === undefined) {
    out = reskin(hex)
    PROP_MAP.set(hex, out)
  }
  return out
}

/** Same as `pal`, for canvas fill/stroke strings ('#rrggbb'). */
export function palCss(css: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(css)
  if (!m) return css
  const out = pal(parseInt(m[1], 16))
  return `#${out.toString(16).padStart(6, '0')}`
}

/** Background gradient stops, top → bottom (equirect). Day = natural, slightly cool; night = blue-black. */
export const SKY = {
  day: ['#93bde6', '#bfd7ee', '#dfeaf5', '#eef3f8'] as [string, string, string, string],
  night: ['#03050b', '#070b15', '#0d1422', '#172131'] as [string, string, string, string],
  /** star points, night only */
  stars: { color: 0xeaeef7, count: 1400, size: 1.6, radius: 300 },
}

export const FOG = { day: 0xd3e1ee, night: 0x101826, near: 80, far: 220 }

/** Reflection environment (PMREM source): gradient stops + soft light panels. */
export const ENV = {
  stops: [
    [0, '#dfeeff'],
    [0.42, '#bcd3e8'],
    [0.5, '#eee9df'],
    [0.62, '#5f6266'],
    [1, '#1e2024'],
  ] as [number, string][],
  panelCore: '#ffffff',
  panelMid: 'rgba(246,248,250,0.85)',
  panelEdge: 'rgba(246,248,250,0)',
}

export const RENDER = { exposure: 1.1 }

/** Light colours/intensities. `day`/`night` pairs are applied by build.ts `applyPalette`. */
export const LIGHTS = {
  ambient: { color: 0xffffff, day: 0.26, night: 0.2 },
  sun: { day: { color: 0xfff6ea, intensity: 2.6 }, night: { color: 0x9fb2d6, intensity: 0.6 } },
  hemi: { sky: 0xdfe9f5, ground: 0x7d7566, day: 0.45, night: 0.3 },
  /** ceiling light panels' point lights: warm-neutral so rooms read at night */
  ceiling: { color: 0xfff1e0, intensity: 1.0 },
  /** desk lamps (point light) */
  deskLamp: { color: 0xffdcae, initDay: 0.12, initNight: 0.6, day: 0.25, night: 0.95 },
  street: { color: 0xffeccc, day: 0.1, night: 1.1 },
  bbq: { color: 0xff7a2e, intensity: 0.5 },
}

/** Emissive "glow" sources. Brand cyan = the "working" colour, on screens only. */
export const GLOW = {
  /** desk / exec monitors; scene.ts drives the intensity from the occupant's status */
  monitor: { emissive: 0x2efcff, ei: 0.3, review: 0.9, working: 1.5 },
  /** ceiling light strips (the `streaks`): white panel with a faint cyan cast, brighter at night */
  strip: { color: 0xffffff, emissive: 0xe6fdff, ei: 1, day: 0.85, night: 1.9 },
  /** desk lamp shade */
  lampShade: { color: 0xf0e2c4, emissive: 0xffd89a, day: 0.2, night: 0.9 },
}

/** Shared PBR material colours (materials.ts). Legacy values, neutrals cooled slightly. */
export const MAT = {
  marble: { base: '#e9e8e3', veinA: '#c3c4c0', veinB: '#d3d3cf', grout: '#b2b3b0', roughness: 0.08, metalness: 0.35, env: 1.6 },
  wood: { base: '#9a7449', grainA: '#7d5c36', grainB: '#b08a5c' },
  glass: { color: 0xd6e6f0, opacity: 0.5 },
  stone: { base: '#6c7782', specA: '#56606b', specB: '#89939d' },
  plaster: 0xf0f2f5,
  panelDark: { base: '#3a2b1e', seam: '#2a1e14', grainA: '#4a3728', grainB: '#2e2116' },
  carpet: { base: '#878d95', fiberA: '#6c7179', fiberB: '#a0a5ad' },
  accent: { color: 0x2efcff, metalness: 0.6, roughness: 0.25 },
}
