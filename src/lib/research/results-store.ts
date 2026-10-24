import 'server-only';
import { getDatabase } from '../data-store.ts';
import { buildResults, parseResponse, questionsFor, type ResearchRow, type ResultFilters } from './results.ts';

export class ResearchResultsUnavailable extends Error {}
function readResults(filters: ResultFilters, database?: ReturnType<typeof getDatabase>) {
  const db = database ?? getDatabase();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_responses'").get()) throw new ResearchResultsUnavailable('Survey response storage is not ready.');
  // Never silently sample. This reader deliberately fails clearly above its tested dataset ceiling.
  const rows = db.prepare('SELECT id,instrument,schema_version,created_at,payload FROM research_responses ORDER BY created_at DESC,id DESC LIMIT 10001').all() as ResearchRow[];
  if (rows.length > 10000) throw new ResearchResultsUnavailable('This dataset needs a larger results reader. No partial totals are shown.');
  return buildResults(rows, filters);
}
export function readResearchResults(filters: ResultFilters, database?: ReturnType<typeof getDatabase>) {
  const { responses: _privateResponses, ...aggregate } = readResults(filters, database);
  void _privateResponses; // Intentionally keep identities out of the aggregate response.
  return aggregate;
}
export function readResearchResponses(filters: ResultFilters, database?: ReturnType<typeof getDatabase>) {
  const { responses, pagination } = readResults(filters, database);
  return { responses, pagination };
}
export function readResearchResponse(id: string, database?: ReturnType<typeof getDatabase>) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return null;
  const db = database ?? getDatabase();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_responses'").get()) throw new ResearchResultsUnavailable('Survey response storage is not ready.');
  const row = db.prepare('SELECT id,instrument,schema_version,created_at,payload FROM research_responses WHERE id=?').get(id) as ResearchRow | undefined;
  if (!row) return null;
  const parsed = parseResponse(row);
  const questions = questionsFor(row.instrument);
  return { id: row.id, instrument: row.instrument, createdAt: row.created_at, schemaVersion: row.schema_version, identity: parsed.identity, flags: parsed.flags, answers: Object.entries(parsed.answers).map(([id, value]) => ({ id, label: parsed.schemaKnown ? questions.find(q => q.id === id)?.prompt ?? (id === 'profile' ? 'Audience categories' : id) : 'Historical field ' + id, value })) };
}
export type ResearchResponseDetail = NonNullable<ReturnType<typeof readResearchResponse>>;
