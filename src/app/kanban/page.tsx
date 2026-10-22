import KanbanPage from '@/components/KanbanPage'
import { t as translate } from '@/lib/i18n'

export const metadata = { title: translate('Kanban.pageTitle') }

/** Kanban toàn màn hình: chỉ bảng, không tải cảnh 3D (A3). */
export default function Page() {
  return <KanbanPage />
}
