import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { messages, userId, skipLimitCheck } = req.body || {};

    if (!messages) { res.status(400).json({ error: 'No messages provided' }); return; }

    // Only check upload limits on the FIRST call (userId provided, skipLimitCheck not set)
    if (userId && !skipLimitCheck) {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      const { data: profile, error: fetchError } = await supabase
        .from('profiles')
        .select('uploads_used, uploads_max, plan')
        .eq('id', userId)
        .single();

      if (fetchError) { res.status(500).json({ error: 'Could not fetch user profile' }); return; }

      if (profile.uploads_used >= profile.uploads_max) {
        res.status(403).json({ error: 'Upload limit reached. Please upgrade your plan.' });
        return;
      }

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ uploads_used: profile.uploads_used + 1 })
        .eq('id', userId);

      if (updateError) { res.status(500).json({ error: 'Could not update upload count' }); return; }
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { res.status(500).json({ error: 'No API key' }); return; }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        messages: messages
      })
    });

    const data = await r.json();
    res.status(200).json(data);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
