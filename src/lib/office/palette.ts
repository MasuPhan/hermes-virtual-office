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
 * Re-skin rule for prop colours that have no explicit entry below:
 *  - neutrals (whites, greys, steel, black)  -> indigo/violet ramp, darker overall
 *  - warm browns / woods / tans               -> deep plum
 *  - greens (plants, grass)                    -> deep teal-green
 *  - saturated blues (water)                   -> cyan; soft blues (fabric) -> lavender
 *  - saturated warm accents, reds, purples     -> kept (fire, darts, pins, LEDs, cars)
 */
function reskin(hex: number): number {
  const [h, s, l] = toHsl(hex)
  if (s < 0.2 || l < 0.06) return fromHsl(266, 0.34 + 0.1 * (1 - l), 0.06 + 0.34 * l)
  if (h >= 15 && h < 55 && !(s > 0.6 && l > 0.42)) return fromHsl(285, Math.min(0.42, s * 0.75), 0.06 + 0.4 * l)
  if (h >= 55 && h < 170 && !(s > 0.6 && l > 0.55)) return fromHsl(165, Math.min(0.55, s), 0.07 + 0.4 * l)
  if (h >= 170 && h < 250) return s > 0.45 ? fromHsl(186, 0.85, 0.12 + 0.42 * l) : fromHsl(250, 0.42, 0.1 + 0.48 * l)
  return hex
}

/** Explicit picks where the rule would read wrong. Key = legacy colour. */
const OVERRIDES: [number, number][] = [
  [0xc9a24a, 0x2efcff], // gold trim / plaque border -> brand cyan
  [0xe8cf8a, 0xeaeef7], // plaque text
  [0xa89a72, 0x8e70f5], // plaque sub text
  [0x2a1f16, 0x0b0326], // plaque / name plate panel
  [0xe4b48c, 0xe4b48c], // pedestrian skin stays skin
  [0xe8edf1, 0xc4b5fd], // bbq smoke -> lavender haze
  [0xf7f8f6, 0xe6dcff], // whiteboard surface stays readable
  [0xf4f4ee, 0xe6dcff], // wall board surface
  [0x2a4a5a, 0x6d45e0], // TV standby glow -> violet
  [0x3a5a6a, 0x2efcff], // racing-rig screen glow
  [0x2a5a8a, 0x2efcff], // bowling score screen glow
  [0x0d1c28, 0x380995], // wall TV standby glow
  [0x224a3a, 0x2efcff], // dart scoreboard glow
  [0x4ad07a, 0x2efcff], // server status LEDs
  // outside: street, pavement, earth and kerb sit darker than the building
  [0x5a5f63, 0x140a33], [0x8b9095, 0x1f1250], // asphalt base / grit
  [0x9aa0a4, 0x241660], [0x7f868b, 0x1a0f45], // pavement base / joint
  [0x6b7a56, 0x1b1640], [0x4d5a3e, 0x120e30], [0x8a9a6c, 0x241d52], // earth
  [0x6f7a5e, 0x2a2260], // earth material tint
  [0xb9bec2, 0x3a2a86], // kerb
  [0xd8d2b8, 0x6cf8ff], // road dashes -> cyan
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

/** Background gradient stops, top → bottom (equirect). Day = lavender daylight, night = nebula. */
export const SKY = {
  day: ['#8b6cf0', '#b3a0f7', '#d9ccfc', '#efe9ff'] as [string, string, string, string],
  night: ['#050117', '#0d0330', '#1f0763', '#380995'] as [string, string, string, string],
  /** star points, night only */
  stars: { color: 0xeaeef7, count: 1400, size: 1.6, radius: 300 },
}

export const FOG = { day: 0xcfc2fb, night: 0x14043f, near: 70, far: 210 }

/** Reflection environment (PMREM source): gradient stops + soft light panels. */
export const ENV = {
  stops: [
    [0, '#d9ccfc'],
    [0.42, '#8e70f5'],
    [0.5, '#e6dcff'],
    [0.62, '#2a1466'],
    [1, '#08021c'],
  ] as [number, string][],
  panelCore: '#ffffff',
  panelMid: 'rgba(108,248,255,0.85)',
  panelEdge: 'rgba(108,248,255,0)',
}

export const RENDER = { exposure: 1.05 }

/** Light colours/intensities. `day`/`night` pairs are applied by build.ts `applyPalette`. */
export const LIGHTS = {
  ambient: { color: 0xe6dcff, day: 0.4, night: 0.3 },
  sun: { day: { color: 0xf3ecff, intensity: 2.6 }, night: { color: 0x8e70f5, intensity: 1.0 } },
  hemi: { sky: 0xc9b8fa, ground: 0x2a1466, day: 0.65, night: 0.45 },
  /** ceiling light panels' point lights */
  ceiling: { color: 0x6cf8ff, intensity: 0.6 },
  /** desk lamps (point light) */
  deskLamp: { color: 0x2efcff, initDay: 0.15, initNight: 0.7, day: 0.25, night: 1.1 },
  street: { color: 0x8e70f5, day: 0.1, night: 1.6 },
  bbq: { color: 0xff7a2e, intensity: 0.5 },
}

/** Emissive "glow" sources. Brand cyan = the "working" colour. */
export const GLOW = {
  /** desk / exec monitors; scene.ts drives the intensity from the occupant's status */
  monitor: { emissive: 0x2efcff, ei: 0.35, review: 1.0, working: 1.6 },
  /** ceiling light strips (the `streaks`) */
  strip: { color: 0xb8fbff, emissive: 0x2efcff, ei: 1, day: 0.7, night: 1.8 },
  /** desk lamp shade */
  lampShade: { color: 0x1a0450, emissive: 0x2efcff, day: 0.4, night: 1.4 },
}

/** Shared PBR material colours (materials.ts). */
export const MAT = {
  /** floor: dark glossy indigo tile with a faint cyan grid */
  marble: { base: '#1a0f45', veinA: '#2a1a66', veinB: '#24165a', grout: '#1f8fb8', roughness: 0.12, metalness: 0.4, env: 1.4 },
  wood: { base: '#2a1660', grainA: '#1f0f4a', grainB: '#3a2380' },
  glass: { color: 0xb9a6ff, opacity: 0.35 },
  stone: { base: '#2a2450', specA: '#1f1a40', specB: '#3a3366' },
  plaster: 0x3a2880,
  /** feature walls: brand violet with cyan seams */
  panelDark: { base: '#1a0450', seam: '#2efcff', grainA: '#240568', grainB: '#110337' },
  carpet: { base: '#140a3a', fiberA: '#1f1050', fiberB: '#2a1766' },
  accent: { color: 0x2efcff, metalness: 0.6, roughness: 0.25 },
}
