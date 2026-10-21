import { NextRequest, NextResponse } from 'next/server'
import { assertApiRequest } from '@/lib/api-policy'

export const dynamic = 'force-dynamic'

const restartDisabledMessage =
  'Quản lý khởi động lại gateway ĐÃ TẮT trong bản dùng thử cục bộ. ' +
  'Không chạy systemctl/unit riêng của máy chủ và không cho phép máy khách ghi đè bảng công việc. ' +
  'Chỉ khởi động lại từ shell trên cùng máy khi bạn đã tự quyết định.'

export async function POST(req: NextRequest) {
  // The operation is disabled for every mode. Keep the common Host/Origin fence
  // (office-write level) so this route still cannot be driven cross-site, but do
  // not demand a privileged opt-in for something that is never executed.
  const denied = assertApiRequest(req, 'office-write')
  if (denied) return denied

  return NextResponse.json(
    {
      success: false,
      scheduled: false,
      disabled: true,
      error: {
        code: 'restart_disabled',
        message: restartDisabledMessage,
        status: 501,
      },
      manual: ['hermes gateway restart'],
    },
    { status: 501 },
  )
}
