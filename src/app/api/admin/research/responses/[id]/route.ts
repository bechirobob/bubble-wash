import { NextRequest, NextResponse } from 'next/server';
import { getCurrentStaffUser } from '@/lib/auth';
import { canViewResearchResults } from '@/lib/research/access';
import { readResearchResponse } from '@/lib/research/results-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Vary': 'Cookie' };
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!canViewResearchResults(await getCurrentStaffUser())) return NextResponse.json({ error: 'Owner access required.' }, { status: 403, headers });
  try {
    const response = readResearchResponse((await params).id);
    return response ? NextResponse.json(response, { headers }) : NextResponse.json({ error: 'Response not found.' }, { status: 404, headers });
  } catch { return NextResponse.json({ error: 'Response could not be loaded.' }, { status: 503, headers }); }
}
