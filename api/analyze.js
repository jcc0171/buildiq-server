import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb', // inventory JSON passed back in action=analyze can be a few KB
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

    // ─────────────────────────────────────────────────────────────────
    // ACTION: count_upload — Supabase quota tracking (unchanged)
    // ─────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────
    // ACTION: inventory — Turn 1 (one Claude call, ~20-40s)
    // Claude reads the full drawing set and transcribes exactly what
    // it sees: sheets, tags, schedules, notes, utility sources.
    // No conclusions. Returns inventoryText to the browser.
    // ─────────────────────────────────────────────────────────────────
    if (body.action === 'inventory') {
      const { fileId, fileName, totalPages } = body;
      if (!fileId) { res.status(400).json({ error: 'No fileId' }); return; }

      const inventoryPrompt = `You are reviewing a construction drawing set: "${fileName}" (${totalPages} pages).

Your ONLY task right now is to produce a factual inventory of what is literally printed in these drawings. Do NOT identify problems yet. Do NOT draw conclusions yet.

Produce a JSON object with these keys:

{
  "sheet_list": [
    { "sheet_no": "exact sheet number as printed", "title": "exact sheet title as printed", "discipline": "M|E|A|S|C|P|FP" }
  ],
  "equipment_tags": [
    { "tag": "exact tag as printed (e.g. AHU-1, P-2, EF-3)", "sheet_no": "sheet where tag appears on a plan or detail", "schedule_sheet": "sheet where its schedule row appears, or null if no schedule row found" }
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
    { "sheet_no": "sheet number", "item": "panel, disconnect, circuit, or utility connection label", "value": "exact label or rating as printed" }
  ]
}

Rules:
- Copy values EXACTLY as they appear — do not paraphrase or interpret.
- If a tag appears on multiple sheets, list it once and include all sheet numbers in sheet_no (comma-separated).
- If a section has nothing to report, return an empty array [].
- Return ONLY the JSON object. No preamble. No markdown fences. No commentary.`;

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

      const claudeData = await claudeRes.json();
      if (!claudeRes.ok) {
        console.error('Inventory Claude error:', JSON.stringify(claudeData));
        res.status(claudeRes.status).json({ error: claudeData?.error?.message || 'Claude API error (inventory)' });
        return;
      }

      const inventoryText = (claudeData.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Return inventory text to browser — it passes it back in action=analyze
      res.status(200).json({ inventoryText });
      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // ACTION: analyze — Turn 2 (one Claude call, ~20-40s)
    // Browser passes the inventory from Turn 1 back here.
    // Claude compares inventory entries against each other.
    // Cannot reference any tag/value/sheet not in the inventory —
    // making hallucination structurally much harder.
    // ─────────────────────────────────────────────────────────────────
    if (body.action === 'analyze') {
      const { fileId, fileName, totalPages, rfiMax, inventoryText } = body;
      if (!fileId)        { res.status(400).json({ error: 'No fileId' }); return; }
      if (!inventoryText) { res.status(400).json({ error: 'No inventoryText' }); return; }

      // Reconstruct Turn 1 prompt verbatim so the conversation is coherent
      const turn1Prompt = `You are reviewing a construction drawing set: "${fileName}" (${totalPages} pages).

Your ONLY task right now is to produce a factual inventory of what is literally printed in these drawings. Do NOT identify problems yet. Do NOT draw conclusions yet.

Produce a JSON object with these keys:

{
  "sheet_list": [
    { "sheet_no": "exact sheet number as printed", "title": "exact sheet title as printed", "discipline": "M|E|A|S|C|P|FP" }
  ],
  "equipment_tags": [
    { "tag": "exact tag as printed (e.g. AHU-1, P-2, EF-3)", "sheet_no": "sheet where tag appears on a plan or detail", "schedule_sheet": "sheet where its schedule row appears, or null if no schedule row found" }
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
    { "sheet_no": "sheet number", "item": "panel, disconnect, circuit, or utility connection label", "value": "exact label or rating as printed" }
  ]
}

Rules:
- Copy values EXACTLY as they appear — do not paraphrase or interpret.
- If a tag appears on multiple sheets, list it once and include all sheet numbers in sheet_no (comma-separated).
- If a section has nothing to report, return an empty array [].
- Return ONLY the JSON object. No preamble. No markdown fences. No commentary.`;

      const rfiPrompt = `You are a Senior Construction Project Manager with 20 years of field experience on commercial, institutional, and industrial projects. You have reviewed thousands of drawing sets and written hundreds of real RFIs.

You are reviewing: "${fileName}" (${totalPages} pages).

In the previous step, you produced this factual inventory of what is literally in the drawings:

<inventory>
${inventoryText}
</inventory>

Now find RFIs. You may ONLY reference items that appear in the inventory above. If a tag, sheet number, note, or value is not in the inventory, you cannot use it.

WHAT MAKES AN RFI REAL:
1. You can point to two specific inventory entries that conflict — different values for the same item on different sheets, or a required value that is missing entirely.
2. A contractor would stop work or delay a procurement decision because of it.
3. It cannot be resolved by a reasonable field assumption or standard practice.
4. It is NOT something normally handled through shop drawing submittals.

CROSS-CHECK APPROACH — look for these conflict types only:
- Same equipment tag: electrical characteristics differ between the mechanical schedule and the electrical schedule (FLA, voltage, breaker size, HP, MCA)
- Equipment tag appears on a plan but has no schedule row anywhere in the inventory (or vice versa)
- A utility source (panel, circuit, disconnect) labeled on one sheet doesn't match the scheduled load on another
- A note on one sheet directly contradicts a note or dimension on another sheet
- A detail or section calls for something that conflicts with what the plan or schedule shows
- A required schedule column (e.g. electrical connection, circuit number) has blank entries for specific named rows only

DO NOT flag:
- Information that IS present in the inventory, even if you expected it in a different location
- Items where both sides of a claimed conflict are not documented in the inventory
- Generic coordination issues with no specific conflicting values
- Anything normally resolved by field measurement or standard practice
- Whole schedules being absent from the inventory — if it wasn't listed, you cannot assume it should exist

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
    "description": "State the two specific inventory entries that conflict. Quote the exact values from each. Explain why this needs engineer clarification.",
    "spec_ref": "Exact keynote or note number if visible, or null",
    "cost_impact": "Low (<$5K)|Medium ($5K-$50K)|High (>$50K)",
    "schedule_impact": "None|Low (1-3 days)|Medium (1-2 weeks)|High (2+ weeks)"
  }
]

If zero real conflicts exist, return an empty array: []`;

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
          messages: [
            // Full conversation: document + Turn 1 prompt + inventory response + Turn 2 prompt
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'file', file_id: fileId } },
                { type: 'text', text: turn1Prompt }
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

      const claudeData = await claudeRes.json();
      if (!claudeRes.ok) {
        console.error('Analyze Claude error:', JSON.stringify(claudeData));
        res.status(claudeRes.status).json({ error: claudeData?.error?.message || 'Claude API error (analyze)' });
        return;
      }

      // Return in same shape the frontend already parses
      res.status(200).json(claudeData);
      return;
    }

    // Unknown action
    res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
