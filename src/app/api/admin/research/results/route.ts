import { NextRequest, NextResponse } from 'next/server';
import { getCurrentStaffUser } from '@/lib/auth';
import { canViewResearchResults } from '@/lib/research/access';
import { parseFilters } from '@/lib/research/results';
import { readResearchResults, ResearchResultsUnavailable } from '@/lib/research/results-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Vary': 'Cookie' };
export async function GET(request: NextRequest) {
  if (!canViewResearchResults(await getCurrentStaffUser())) return NextResponse.json({ error: 'Owner access required.' }, { status: 403, headers });
  let filters;
  try { filters = parseFilters(request.nextUrl.searchParams); } catch { return NextResponse.json({ error: 'Choose valid results filters.' }, { status: 400, headers }); }
  try { return NextResponse.json(readResearchResults(filters), { headers }); }
  catch (error) { return NextResponse.json({ error: error instanceof ResearchResultsUnavailable ? error.message : 'Results could not be loaded. Try again.' }, { status: 503, headers }); }
}
