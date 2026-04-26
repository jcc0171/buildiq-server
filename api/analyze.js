import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false, // We handle the stream manually for blob uploads
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  // ── GET: return upload token for Vercel Blob ──
  if (req.method === 'GET') {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) { res.status(500).json({ error: 'No blob token configured' }); return; }
    res.status(200).json({ blobToken: token });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Parse body manually since bodyParser is false
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const bodyText = Buffer.concat(buffers).toString();
  let body = {};
  try { body = JSON.parse(bodyText); } catch(e) {}

  try {
    // ── Count upload ──
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

    // ── Analyze: blobUrl → Anthropic Files API → Claude → RFIs ──
    if (!body.blobUrl) { res.status(400).json({ error: 'No blobUrl' }); return; }
    const { blobUrl, fileName, totalPages, rfiMax } = body;

    // 1. Fetch PDF from Vercel Blob
    const blobRes = await fetch(blobUrl);
    if (!blobRes.ok) throw new Error(`Could not fetch from blob: ${blobRes.status}`);
    const pdfBuffer = await blobRes.arrayBuffer();

    // 2. Upload to Anthropic Files API
    const boundary = 'PlanIQ' + Date.now().toString(36);
    const pdfBytes  = new Uint8Array(pdfBuffer);

    const metaPart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nassistants\r\n`
    );
    const filePart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`
    );
    const endPart  = Buffer.from(`\r\n--${boundary}--\r\n`);
    const formBody = Buffer.concat([metaPart, filePart, Buffer.from(pdfBytes), endPart]);

    const uploadRes = await fetch('https://api.anthropic.com/v1/files', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: formBody,
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData?.error?.message || 'Anthropic upload failed');
    const fileId = uploadData.id;

    // 3. Call Claude with file_id — full drawing set in one shot
    const prompt = `You are a Senior Construction Project Manager and licensed architect with 30 years of experience on commercial, institutional, and industrial projects.

You are reading a complete construction drawing set: "${fileName}" (${totalPages} pages). You can see every single page — floor plans, elevations, sections, details, ALL schedules (equipment, door, panel, finish, plumbing fixture schedules), and all other sheets.

Because you can see the ENTIRE drawing set at once, cross-reference every sheet against every other sheet.

CROSS-REFERENCE CHECKS:
1. Equipment tags on plans vs equipment schedules — CFM, kW, tons, GPM must match exactly
2. Panel circuit numbers on plans vs panel schedules — loads and breaker sizes must match
3. Duct or pipe routing vs structural framing at same grid locations
4. Detail keynotes on plans — do those detail sheets exist in this set?
5. Door numbers on floor plans vs door schedule — sizes, hardware groups, fire ratings
6. Notes saying "by others", "coordinate with EOR", "TBD", "verify in field" — is the info anywhere in the set?
7. Demolition scope vs active systems on renovation drawings
8. Underground utilities — are existing conditions verified or unknown?
9. Fire/smoke dampers at rated assemblies where new ductwork penetrates
10. Egress widths, ADA clearances, door swings vs code requirements

ONLY flag an RFI if:
- Evidence is clearly visible in this drawing set
- A real contractor would stop work or delay procurement because of it
- You can cite the exact sheet number, tag, note number, or schedule row

A false RFI destroys trust. Only flag what you are certain about.

PRIORITY:
HIGH — blocks construction, life safety, slab/underground, can't order equipment
MEDIUM — needs resolution before that trade starts
LOW — no schedule impact

Return UP TO ${rfiMax} RFIs. Return fewer if fewer real issues exist. Never pad.

RESPOND ONLY WITH A VALID JSON ARRAY:
[
  {
    "title": "Specific issue — sheet and location",
    "priority": "high|medium|low",
    "discipline": "Mechanical|Electrical|Architectural|Structural|Civil|Plumbing|Fire Protection|General",
    "page_ref": "Sheet number(s) as printed on the drawing",
    "location": "Specific room, grid line, or area",
    "description": "What you see. Quote note text or tag values. State the specific conflict and why it needs resolution.",
    "spec_ref": "Keynote or spec section if visible",
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
            { type: 'document', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(claudeData?.error?.message || 'Claude API error');

    // 4. Clean up blob (optional but good hygiene)
    try {
      const { del } = await import('@vercel/blob');
      await del(blobUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } catch(e) { /* non-fatal */ }

    res.status(200).json(claudeData);

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
