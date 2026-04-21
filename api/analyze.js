import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '52mb',
    },
  },
};

const TEXT_THRESHOLD = 800;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    if (body.pdfBase64) return await processPDF(body, res);
    if (body.messages) return await legacyProxy(body, res);

    res.status(400).json({ error: 'Invalid request' });

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}

async function processPDF(body, res) {
  const { pdfBase64, userId, pagesMax } = body;

  if (userId) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: profile, error: fetchError } = await supabase
      .from('profiles').select('uploads_used, uploads_max, plan').eq('id', userId).single();

    if (fetchError) { res.status(500).json({ error: 'Could not fetch user profile' }); return; }
    if (profile.uploads_used >= profile.uploads_max) {
      res.status(403).json({ error: 'Upload limit reached. Please upgrade your plan.' }); return;
    }
    await supabase.from('profiles').update({ uploads_used: profile.uploads_used + 1 }).eq('id', userId);
  }

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.js');
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const pdfData = new Uint8Array(pdfBuffer);

  const pdf = await pdfjsLib.getDocument({ data: pdfData, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;

  const pagesToProcess = Math.min(pdf.numPages, pagesMax || 50);
  let fullText = '';
  const sheetList = [];

  for (let i = 1; i <= pagesToProcess; i++) {
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ').trim();

      const sheetMatch = pageText.match(/\b([A-Z]{1,2}-?\d{3}[A-Z]?)\b/g);
      const sheetNum = sheetMatch ? sheetMatch[0] : `Page ${i}`;

      let discipline = 'Unknown';
      const pt = pageText.toLowerCase();
      if (pt.includes('floor plan') || pt.includes('elevation') || pt.includes('ceiling') || pt.includes('architectural')) discipline = 'Architectural';
      else if (pt.includes('structural') || pt.includes('framing') || pt.includes('foundation') || pt.includes('beam')) discipline = 'Structural';
      else if (pt.includes('mechanical') || pt.includes('hvac') || pt.includes('ductwork') || pt.includes('plumbing') || pt.includes('vav')) discipline = 'Mechanical';
      else if (pt.includes('electrical') || pt.includes('panel') || pt.includes('circuit') || pt.includes('conduit')) discipline = 'Electrical';
      else if (pt.includes('civil') || pt.includes('grading') || pt.includes('drainage')) discipline = 'Civil';
      else if (pt.includes('fire') || pt.includes('sprinkler')) discipline = 'Fire Protection';

      const needsImage = pageText.length < TEXT_THRESHOLD;
      const entry = `=== SHEET: ${sheetNum} | PAGE: ${i} | DISCIPLINE: ${discipline}${needsImage ? ' | SCHEDULE — SEE IMAGE' : ''} ===\n${pageText || '(see image)'}`;
      fullText += entry + '\n\n';
      sheetList.push({ sheet: sheetNum, discipline, pageNum: i, needsImage });

    } catch(e) {
      console.warn(`Error on page ${i}:`, e.message);
    }
  }

  const MAX_CHARS = 120000;
  if (fullText.length > MAX_CHARS) fullText = fullText.slice(0, MAX_CHARS) + '\n\n[... truncated ...]';

  res.status(200).json({ fullText, sheetList, totalPages: pagesToProcess });
}

async function legacyProxy(body, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 16000, messages: body.messages })
  });

  const data = await r.json();
  res.status(200).json(data);
}
