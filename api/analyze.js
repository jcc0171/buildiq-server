import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb', // Only JSON metadata now — no PDF bytes
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  if (req.method === 'GET') {
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

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

    // ── Analyze using file_id ──
    if (!body.fileId) { res.status(400).json({ error: 'No fileId' }); return; }

    const { fileId, fileName, totalPages, rfiMax } = body;

    const prompt = `You are a Senior Construction Project Manager and licensed architect with 30 years of experience on commercial, institutional, and industrial projects.

You are reading a complete construction drawing set: "${fileName}" (${totalPages} pages). You can see every single page — floor plans, elevations, sections, details, all schedules (equipment, door, panel, finish, plumbing fixture), and all other sheets.

Because you can see the ENTIRE drawing set at once, you can cross-reference any sheet against any other sheet. Use this ability.

YOUR TASK:
Identify real, job-site-ready RFIs — items a contractor, superintendent, or PM would actually send to the engineer of record before or during construction.

CROSS-REFERENCE CHECKS TO PERFORM:
1. Equipment tags on plans vs. equipment schedules — do CFM, kW, tons, GPM values match?
2. Panel circuit numbers on plans vs. panel schedules — do loads and breaker sizes match?
3. Duct or pipe shown on mechanical/plumbing vs. structural framing at same grid location
4. Details called out by keynote on plans — do those detail sheets exist in this set?
5. Door numbers on floor plans vs. door schedule — do sizes, hardware, ratings match?
6. Notes saying "by others", "coordinate with EOR", "TBD", or "verify" — is the required info anywhere in the set?
7. Demolition scope — are any removed systems still shown as active on other sheets?
8. Underground utilities — are existing conditions verified or marked unknown?
9. Fire/smoke dampers at rated walls where new ductwork penetrates
10. Egress widths, ADA clearances, door swings — do dimensions meet code?

ONLY flag an RFI if:
- The evidence is clearly visible somewhere in this drawing set
- A real contractor would stop work or delay procurement because of it
- You can cite the specific sheet number, tag, note, or schedule row

A false RFI wastes money and destroys trust. Only flag what you are certain about.

PRIORITY:
HIGH — blocks construction, life safety issue, slab/underground work, can't order equipment
MEDIUM — needs resolution before that trade starts, doesn't block current work  
LOW — informational, no schedule impact

Return UP TO ${rfiMax} RFIs. Return fewer if fewer real issues exist. Return [] if the set is well-coordinated.

RESPOND ONLY WITH A VALID JSON ARRAY — no preamble, no markdown:
[
  {
    "title": "Specific issue — what sheet and where",
    "priority": "high|medium|low",
    "discipline": "Mechanical|Electrical|Architectural|Structural|Civil|Plumbing|Fire Protection|General",
    "page_ref": "Sheet number(s) as printed on the drawing",
    "location": "Specific room, grid line, floor, or area",
    "description": "Exactly what you see. Quote note text or schedule values where visible. State the specific conflict or gap and why it needs resolution before work proceeds.",
    "spec_ref": "Keynote number, note number, or spec section if visible",
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'file',
                file_id: fileId,
              },
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }]
      })
    });

    const data = await claudeRes.json();
    if (!claudeRes.ok) {
      console.error('Claude error:', data);
      res.status(claudeRes.status).json({ error: data?.error?.message || 'Claude API error' });
      return;
    }

    res.status(200).json(data);

  } catch(e) {
    console.error('Analyze handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
