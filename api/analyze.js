import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb', // Only JSON now — no PDF bytes touch Vercel
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'GET') { res.status(200).json({ ok: true }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  try {
    const body = req.body || {};

    // ── Count upload in Supabase ──
    if (body.action === 'count_upload') {
      if (!body.userId) { res.status(400).json({ error: 'No userId' }); return; }
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: profile, error } = await supabase
        .from('profiles').select('uploads_used, uploads_max').eq('id', body.userId).single();
      if (error) { res.status(500).json({ error: 'Profile fetch failed' }); return; }
      if (profile.uploads_used >= profile.uploads_max) {
        res.status(403).json({ error: 'Upload limit reached' }); return;
      }
      await supabase.from('profiles').update({ uploads_used: profile.uploads_used + 1 }).eq('id', body.userId);
      res.status(200).json({ ok: true });
      return;
    }

    // ── Analyze using file_id from Cloudflare Worker ──
    if (!body.fileId) { res.status(400).json({ error: 'No fileId provided' }); return; }
    const { fileId, fileName, totalPages, rfiMax } = body;

    const prompt = `You are a Senior Construction Project Manager with 20 years of field experience on commercial, institutional, and industrial projects. You have reviewed thousands of drawing sets and written hundreds of real RFIs.

You are reviewing: "${fileName}" (${totalPages} pages).

PROCESS — follow these steps in order:
Step 1: Read through every page of the drawing set.
Step 2: Note any potential issues.
Step 3: For each potential issue, go BACK and find the specific evidence — the exact sheet number, note number, equipment tag, schedule row, or dimension. If you cannot find it, discard it.
Step 4: Only include issues that passed Step 3.

This self-verification step is critical. Many apparent conflicts resolve when you look more carefully. A 20-year PM does not send an RFI without double-checking the drawings first.

AN RFI IS REAL ONLY IF:
- You can cite the exact sheet, note, tag, or schedule value where the problem exists
- The information is genuinely missing or conflicting — not on another sheet you may have overlooked
- A contractor would actually stop work or delay a procurement decision because of it
- It cannot be resolved by a reasonable field assumption or standard practice

DO NOT flag:
- Issues where the information exists elsewhere in the set
- Items normally resolved through shop drawing submittals  
- Generic coordination that is standard on every project
- Anything you cannot cite with a specific location

You are looking for UP TO ${rfiMax} RFIs. If the drawings are well-coordinated, return fewer. If only 2 real issues exist, return 2. Never manufacture issues to fill a quota.

PRIORITY:
HIGH — blocks construction, life safety, underground/slab work, equipment cannot be ordered
MEDIUM — needs resolution before that trade starts, doesn't block current work
LOW — informational, no schedule impact

RESPOND ONLY WITH A VALID JSON ARRAY — no preamble, no markdown:
[
  {
    "title": "Specific issue — what sheet and where",
    "priority": "high|medium|low",
    "discipline": "Mechanical|Electrical|Architectural|Structural|Civil|Plumbing|Fire Protection|General",
    "page_ref": "Exact sheet number(s) as printed on the drawing",
    "location": "Specific room, grid line, or area",
    "description": "What you see. Quote the exact note text, tag value, or schedule entry. State the specific conflict and why it needs resolution.",
    "spec_ref": "Exact keynote or note number if visible",
    "cost_impact": "Low (<$5K)|Medium ($5K-$50K)|High (>$50K)",
    "schedule_impact": "None|Low (1-3 days)|Medium (1-2 weeks)|High (2+ weeks)"
  }
]`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      console.error('Claude error:', JSON.stringify(claudeData));
      res.status(claudeRes.status).json({ error: claudeData?.error?.message || 'Claude API error' });
      return;
    }

    res.status(200).json(claudeData);

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
