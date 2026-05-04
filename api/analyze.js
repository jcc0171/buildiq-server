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

    // ─────────────────────────────────────────────────────────────────
    // TURN 1 — Inventory extraction
    // Force Claude to document exactly what exists in the drawings
    // before it is allowed to draw any conclusions. This makes it
    // structurally impossible to reference tags or schedules it
    // never actually saw.
    // ─────────────────────────────────────────────────────────────────
    const inventoryPrompt = `You are reviewing a construction drawing set: "${fileName}" (${totalPages} pages).

Your ONLY task right now is to produce a factual inventory of what is literally printed in these drawings. Do NOT identify problems yet. Do NOT draw conclusions yet.

Produce a JSON object with these keys:

{
  "sheet_list": [
    { "sheet_no": "exact sheet number as printed", "title": "exact sheet title as printed", "discipline": "M|E|A|S|C|P|FP" }
  ],
  "equipment_tags": [
    { "tag": "exact tag as printed (e.g. AHU-1, P-2, EF-3)", "sheet_no": "sheet where found", "schedule_sheet": "sheet where its schedule row appears, or null" }
  ],
  "schedules_found": [
    { "sheet_no": "sheet number", "schedule_name": "exact schedule title", "columns": ["exact column headers as printed"], "row_count": 0 }
  ],
  "keynotes_and_notes": [
    { "sheet_no": "sheet number", "note_no": "note number or keynote number", "text": "exact text of the note" }
  ],
  "dimensions_and_clearances": [
    { "sheet_no": "sheet number", "item": "what is dimensioned", "value": "exact value as printed" }
  ],
  "utility_sources": [
    { "sheet_no": "sheet number", "item": "panel, disconnect, circuit, or utility connection", "value": "exact label or rating as printed" }
  ]
}

Rules:
- Copy values EXACTLY as they appear — do not paraphrase or interpret.
- If a tag appears on multiple sheets, list it once and include all sheets in sheet_no (comma-separated).
- If a section has nothing to report, return an empty array [].
- Return ONLY the JSON object. No preamble. No markdown fences.`;

    const turn1Res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: inventoryPrompt }
          ]
        }]
      })
    });

    const turn1Data = await turn1Res.json();
    if (!turn1Res.ok) {
      console.error('Turn 1 Claude error:', JSON.stringify(turn1Data));
      res.status(turn1Res.status).json({ error: turn1Data?.error?.message || 'Claude API error (inventory)' });
      return;
    }

    const inventoryText = (turn1Data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // ─────────────────────────────────────────────────────────────────
    // TURN 2 — RFI analysis, grounded to the inventory
    // Claude must cite from the inventory it just produced.
    // It cannot reference any tag, sheet, or value that doesn't
    // appear in the inventory above.
    // ─────────────────────────────────────────────────────────────────
    const rfiPrompt = `You are a Senior Construction Project Manager with 20 years of field experience on commercial, institutional, and industrial projects. You have reviewed thousands of drawing sets and written hundreds of real RFIs.

You are reviewing: "${fileName}" (${totalPages} pages).

In the previous step, you produced this factual inventory of what is literally in the drawings:

<inventory>
${inventoryText}
</inventory>

Now find RFIs. You may ONLY reference items that appear in the inventory above. If a tag, sheet number, note, or value is not in the inventory, you cannot use it.

WHAT MAKES AN RFI REAL:
1. You can point to two specific inventory entries that conflict with each other — different values for the same item, or a required value that is absent.
2. A contractor would stop work or delay a procurement decision because of it.
3. It cannot be resolved by a reasonable field assumption or standard practice.
4. It is NOT something normally handled through shop drawing submittals.

CROSS-CHECK APPROACH — look for these conflict types only:
- Same equipment tag appears in a plan/schedule but its electrical characteristics differ between sheets (FLA, voltage, breaker size, HP)
- An equipment tag in a mechanical/plumbing schedule has no corresponding electrical entry, or vice versa
- A tag shown on a plan does not appear in any schedule you found
- A utility source (panel, circuit) shown serving equipment doesn't match the scheduled load
- A note on one sheet directly contradicts a note or dimension on another sheet
- A detail calls for something that conflicts with what the plan shows
- A required schedule column has blank entries for specific rows only (not the whole schedule)

DO NOT flag:
- Information that IS present in the inventory, even if you expected it somewhere else
- Items where both sides of the conflict are not documented in the inventory
- Generic coordination issues with no specific conflicting values
- Anything resolved by field measurement or standard practice
- Whole schedules being "blank" — you listed them in the inventory with row counts

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
    "description": "State the two specific inventory facts that conflict. Quote the exact values from each. Explain why this needs engineer clarification.",
    "spec_ref": "Exact keynote or note number if visible, or null",
    "cost_impact": "Low (<$5K)|Medium ($5K-$50K)|High (>$50K)",
    "schedule_impact": "None|Low (1-3 days)|Medium (1-2 weeks)|High (2+ weeks)"
  }
]

If zero real conflicts exist, return an empty array: []`;

    const turn2Res = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: [
          // Full conversation history so Claude has both the document and its own inventory
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'file', file_id: fileId } },
              { type: 'text', text: inventoryPrompt }
            ]
          },
          {
            role: 'assistant',
            content: inventoryText
          },
          {
            role: 'user',
            content: [{ type: 'text', text: rfiPrompt }]
          }
        ]
      })
    });

    const turn2Data = await turn2Res.json();
    if (!turn2Res.ok) {
      console.error('Turn 2 Claude error:', JSON.stringify(turn2Data));
      res.status(turn2Res.status).json({ error: turn2Data?.error?.message || 'Claude API error (RFI analysis)' });
      return;
    }

    // Return the RFI response in the same shape the frontend already expects
    res.status(200).json(turn2Data);

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
