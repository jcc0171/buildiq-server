import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

/**
 * PlanIQ Pro — Vercel /api/analyze
 *
 * Claude calls have moved to the Cloudflare Worker (no timeout risk).
 * This endpoint only handles Supabase quota tracking.
 *
 * action: count_upload  — check + increment uploads_used for a user
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'GET')     { res.status(200).json({ ok: true }); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    if (body.action === 'count_upload') {
      if (!body.userId) { res.status(400).json({ error: 'No userId' }); return; }

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('uploads_used, uploads_max')
        .eq('id', body.userId)
        .single();

      if (error) { res.status(500).json({ error: 'Profile fetch failed' }); return; }

      if (profile.uploads_used >= profile.uploads_max) {
        res.status(403).json({ error: 'Upload limit reached' }); return;
      }

      await supabase
        .from('profiles')
        .update({ uploads_used: profile.uploads_used + 1 })
        .eq('id', body.userId);

      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });

  } catch (e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
