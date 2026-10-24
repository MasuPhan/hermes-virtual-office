import TeamPage from '@/components/TeamPage'
import { t as translate } from '@/lib/i18n'

export const metadata = { title: translate('Team.pageTitle') }

/** Đội AI: mọi profile Hermes và việc của họ trên tất cả board. Chỉ đọc. */
export default function Page() {
  return <TeamPage />
}
