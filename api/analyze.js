import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb', // Only used for quota checks now — no PDF goes through here
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key configured' }); return; }

  // GET: return key so browser can call Anthropic directly.
  // PDF is too large to route through Vercel serverless functions.
  // Key is fetched here (secure server env var) and used client-side for one call.
  if (req.method === 'GET') {
    res.status(200).json({ apiKey: key });
    return;
  }

  // POST: record upload usage in Supabase (called AFTER analysis succeeds)
  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const { userId, action } = body;

      if (action === 'count_upload' && userId) {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const { data: profile, error: fetchError } = await supabase
          .from('profiles')
          .select('uploads_used, uploads_max, plan')
          .eq('id', userId)
          .single();

        if (fetchError) { res.status(500).json({ error: 'Could not fetch user profile' }); return; }
        if (profile.uploads_used >= profile.uploads_max) {
          res.status(403).json({ error: 'Upload limit reached. Please upgrade your plan.' }); return;
        }

        await supabase
          .from('profiles')
          .update({ uploads_used: profile.uploads_used + 1 })
          .eq('id', userId);

        res.status(200).json({ ok: true, uploads_used: profile.uploads_used + 1 });
        return;
      }

      res.status(400).json({ error: 'Unknown action' });
    } catch(e) {
      console.error('Handler error:', e);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
