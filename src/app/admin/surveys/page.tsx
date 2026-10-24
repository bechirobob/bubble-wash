import { redirect } from 'next/navigation';
import { getCurrentStaffUser } from '@/lib/auth';
import { canViewResearchResults } from '@/lib/research/access';
import { ResearchResults } from '@/components/research/ResearchResults';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Survey results | Bubble Wash', robots: { index: false, follow: false } };

export default async function SurveyResultsPage() {
  const user = await getCurrentStaffUser();
  if (!user) redirect('/login?next=/admin');
  if (!canViewResearchResults(user)) redirect('/admin');
  return <ResearchResults userName={user.name} />;
}
