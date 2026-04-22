import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '52mb',
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

  // ── GET: quota check only — returns user plan info ──
  if (req.method === 'GET') {
    // Used by auth.js for anonKey — this endpoint handles analyze calls
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    // ── action: count_upload — record usage after successful analysis ──
    if (body.action === 'count_upload') {
      if (!body.userId) { res.status(400).json({ error: 'No userId' }); return; }
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: profile, error } = await supabase
        .from('profiles').select('uploads_used, uploads_max, plan').eq('id', body.userId).single();
      if (error) { res.status(500).json({ error: 'Profile fetch failed' }); return; }
      if (profile.uploads_used >= profile.uploads_max) {
        res.status(403).json({ error: 'Upload limit reached' }); return;
      }
      await supabase.from('profiles').update({ uploads_used: profile.uploads_used + 1 }).eq('id', body.userId);
      res.status(200).json({ ok: true });
      return;
    }

    // ── action: analyze — forward PDF chunk to Claude ──
    if (!body.messages) { res.status(400).json({ error: 'No messages' }); return; }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 16000,
        messages: body.messages
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Claude API error:', data);
      res.status(r.status).json({ error: data?.error?.message || 'Claude API error' });
      return;
    }

    res.status(200).json(data);

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
