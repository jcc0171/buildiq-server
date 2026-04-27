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

    const prompt = `You are a Senior Construction Project Manager with 20 years of field experience on commercial, institutional, and industrial projects. You have reviewed thousands of drawing sets and written hundreds of RFIs. You know the difference between a real problem that stops work and a theoretical concern that resolves itself.

You are reviewing the complete drawing set: "${fileName}" (${totalPages} pages).

YOUR JOB:
Review these drawings the way you would before a pre-construction meeting. Find real RFIs — the kind you would actually send to the engineer of record because work cannot proceed or equipment cannot be ordered without resolution.

You are looking for UP TO ${rfiMax} RFIs. If the drawings are well-coordinated, return fewer. If only 3 real issues exist, return 3. Never manufacture issues to fill a quota.

A REAL RFI meets all three of these:
1. You can point to the exact sheet, note number, equipment tag, schedule row, or dimension where the problem exists
2. A contractor would actually stop work or delay a procurement decision because of it
3. It cannot be resolved by a reasonable field assumption or standard industry practice

DO NOT flag:
- Issues you are inferring or assuming — only what you can see
- Items that are normally resolved through shop drawing submittals
- Generic coordination notes that are standard on every project
- Anything you cannot cite with a specific sheet number and location

PRIORITY:
HIGH — blocks construction, life safety issue, underground/slab work required, equipment cannot be ordered
MEDIUM — needs engineer response before that phase starts, doesn't block current work
LOW — informational clarification, no schedule impact

RESPOND ONLY WITH A VALID JSON ARRAY — no preamble, no markdown:

[
  {
    "title": "Specific issue — what sheet and where",
    "priority": "high|medium|low",
    "discipline": "Mechanical|Electrical|Architectural|Structural|Civil|Plumbing|Fire Protection|General",
    "page_ref": "Sheet number(s) as printed on the drawing",
    "location": "Specific room, grid line, or area",
    "description": "What you see. Quote note text or tag values where visible. State the specific conflict and why it needs resolution before work proceeds.",
    "spec_ref": "Keynote or spec section if visible",
    "cost_impact": "Low (<$5K)|Medium ($5K-$50K)|High (>$50K)",
    "schedule_impact": "None|Low (1-3 days)|Medium (1-2 weeks)|High (2+ weeks)"
  }
]`;

    // ── Helper: call Claude with the stored file ──
    async function callClaude(messages, maxTokens = 8000) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'files-api-2025-04-14',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          messages
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Claude API error ' + r.status);
      return data.content?.[0]?.text || '';
    }

    function parseRFIs(text) {
      try {
        let clean = text.replace(/```json/gi,'').replace(/```/g,'').trim();
        const match = clean.match(/\[[\s\S]*\]/);
        if (!match) return [];
        return JSON.parse(match[0].replace(/,\s*([}\]])/g,'$1')) || [];
      } catch(e) { return []; }
    }

    // ── PASS 1: Generate candidate RFIs ──
    console.log('Pass 1: Generating candidate RFIs...');
    const pass1Text = await callClaude([{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'file', file_id: fileId } },
        { type: 'text', text: prompt }
      ]
    }]);

    const candidateRFIs = parseRFIs(pass1Text);
    console.log(`Pass 1 complete: ${candidateRFIs.length} candidates`);

    if (candidateRFIs.length === 0) {
      res.status(200).json({ content: [{ type: 'text', text: '[]' }] });
      return;
    }

    // ── PASS 2: Verify each candidate against the drawings ──
    // Claude re-reads the same file and checks each RFI for evidence.
    // RFIs that cannot be verified are removed.
    const verifyPrompt = `You are a Senior Construction Project Manager with 20 years of experience. You have already reviewed a drawing set and generated the following candidate RFIs. Now you must verify each one by going back through the drawings carefully.

For each candidate RFI, check:
1. Does the specific sheet number cited actually exist in this drawing set?
2. Is the conflict, missing item, or discrepancy actually visible in the drawings — not assumed or inferred?
3. Would a contractor actually stop work or delay procurement because of this?
4. Is the information truly missing — or is it on another sheet you may have overlooked?

CANDIDATE RFIs TO VERIFY:
${JSON.stringify(candidateRFIs, null, 2)}

Return ONLY the RFIs that pass all four checks. Remove any that fail. If a schedule clearly shows the information that an RFI claims is missing, remove that RFI. If a plan clearly shows coordination that an RFI claims is absent, remove it.

Return the verified RFIs in the same JSON format. Keep all original fields. If all RFIs are valid, return all of them. If none are valid, return [].

RESPOND ONLY WITH A VALID JSON ARRAY — no preamble, no markdown.`;

    console.log('Pass 2: Verifying candidates...');
    const pass2Text = await callClaude([{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'file', file_id: fileId } },
        { type: 'text', text: verifyPrompt }
      ]
    }], 6000);

    const verifiedRFIs = parseRFIs(pass2Text);
    console.log(`Pass 2 complete: ${verifiedRFIs.length} verified RFIs`);

    // Return in same format as before so frontend works unchanged
    res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify(verifiedRFIs) }]
    });

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
