import type { Queryable } from '../db';
import { formatRef } from '../refs';
import type { DuplicateCandidate } from '../types';

export const DEDUP = { titleSimilarity: 0.4, wordSimilarity: 0.6, recentDoneDays: 7, maxCandidates: 5 } as const;

export async function findDuplicates(q: Queryable, projectId: string, title: string): Promise<DuplicateCandidate[]> {
  const { rows } = await q.query(
    `SELECT t.number, p.key, t.title, t.status,
       GREATEST(similarity(lower(t.title), lower($2)),
                word_similarity(lower($2), lower(t.title || ' ' || t.description)),
                word_similarity(lower(t.title), lower($2))) AS score
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.project_id = $1 AND t.deleted_at IS NULL
       AND (t.status IN ('proposed','todo','in_progress','blocked','review')
            OR (t.status = 'done' AND t.closed_at > now() - make_interval(days => $5)))
       AND (similarity(lower(t.title), lower($2)) >= $3
            OR word_similarity(lower($2), lower(t.title || ' ' || t.description)) >= $4
            OR word_similarity(lower(t.title), lower($2)) >= $4)
     ORDER BY score DESC, t.number DESC
     LIMIT $6`,
    [projectId, title, DEDUP.titleSimilarity, DEDUP.wordSimilarity, DEDUP.recentDoneDays, DEDUP.maxCandidates],
  );
  return rows.map((r) => ({ ref: formatRef(r.key, r.number), title: r.title, status: r.status, score: Number(Number(r.score).toFixed(3)) }));
}
