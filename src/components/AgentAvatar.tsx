import { personLook } from '@/lib/office/look'
import { palCss } from '@/lib/office/palette'
import type { AgentRole, AgentStatus } from '@/types/hermes'

/**
 * Pixel portrait of one agent: the same head, hair and shirt the pixel office
 * draws (SpriteOffice `person`, facing front), cropped to head and shoulders.
 * Coordinates are the sprite's own, so the two cannot drift apart in shape.
 */
export default function AgentAvatar({
  name,
  role,
  status,
  size = 48,
}: {
  name: string
  role: AgentRole | null
  status?: AgentStatus
  size?: number
}) {
  const { shirt, skin, hair } = personLook(name, role)
  return (
    <span className="vp-ava" data-status={status} style={{ width: size, height: size }}>
      <svg viewBox="-12 -31 24 24" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
        {/* shoulders + arms */}
        <rect x={-6} y={-16} width={12} height={9} fill={shirt} />
        <rect x={-9} y={-15} width={3} height={8} fill={shirt} />
        <rect x={6} y={-15} width={3} height={8} fill={shirt} />
        {/* head */}
        <rect x={-6} y={-26} width={12} height={10} fill={skin} />
        <rect x={-7} y={-28} width={14} height={5} fill={hair} />
        <rect x={-7} y={-24} width={3} height={4} fill={hair} />
        <rect x={4} y={-24} width={3} height={4} fill={hair} />
        {/* face */}
        <rect x={-4} y={-21} width={2} height={2} fill={palCss('#26323a')} />
        <rect x={2} y={-21} width={2} height={2} fill={palCss('#26323a')} />
        <rect x={-1} y={-18} width={3} height={1} fill={palCss('#8f4c46')} />
      </svg>
    </span>
  )
}
