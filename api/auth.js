import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // GET /api/auth — return the public anon key for the browser
  if (req.method === 'GET') {
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!anonKey) {
      res.status(500).json({ error: 'Supabase not configured' });
      return;
    }
    res.status(200).json({ anonKey });
    return;
  }

  // POST /api/auth — activate a plan after Stripe payment
  if (req.method === 'POST') {
    const { userId, plan } = req.body || {};

    if (!userId || !plan) {
      res.status(400).json({ error: 'Missing userId or plan' });
      return;
    }

    const supabaseUrl     = process.env.SUPABASE_URL;
    const supabaseService = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseService) {
      res.status(500).json({ error: 'Supabase not configured' });
      return;
    }

    try {
      // Use service key to bypass RLS and update the user's plan
      const supabase = createClient(supabaseUrl, supabaseService);

      const uploadsMax = plan === 'pro' ? 9999 : 2;

      const { error } = await supabase
        .from('profiles')
        .update({
          plan: plan,
          uploads_max: uploadsMax,
          uploads_used: 0
        })
        .eq('id', userId);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(200).json({ success: true, plan, uploadsMax });

    } catch(e) {
      res.status(500).json({ error: e.message });
    }

    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
