import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

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

  // ── Check upload limits ──
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

  // ── Convert base64 to buffer ──
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');

  // ── Extract text using pdf-parse ──
  // pdf-parse is serverless-safe, no recursion issues
  let rawText = '';
  let pageCount = 0;

  try {
    const data = await pdfParse(pdfBuffer, {
      max: pagesMax || 50, // limit pages
    });
    rawText = data.text;
    pageCount = data.numpages;
  } catch(e) {
    res.status(500).json({ error: 'PDF parse failed: ' + e.message });
    return;
  }

  // ── Split text into pages and build structured data ──
  // pdf-parse returns all text concatenated — we split by page markers
  const lines = rawText.split('\n');
  let fullText = '';
  const sheetList = [];
  const TEXT_THRESHOLD = 800;

  // Build page-by-page structure from the raw text
  // pdf-parse gives us page count but concatenated text
  // We chunk the text evenly across pages for structure
  const charsPerPage = Math.ceil(rawText.length / Math.max(pageCount, 1));
  
  for (let i = 0; i < Math.min(pageCount, pagesMax || 50); i++) {
    const start = i * charsPerPage;
    const end = start + charsPerPage;
    const pageText = rawText.slice(start, end).trim();

    const sheetMatch = pageText.match(/\b([A-Z]{1,2}-?\d{3}[A-Z]?)\b/g);
    const sheetNum = sheetMatch ? sheetMatch[0] : `Page ${i + 1}`;

    let discipline = 'Unknown';
    const pt = pageText.toLowerCase();
    if (pt.includes('floor plan') || pt.includes('elevation') || pt.includes('ceiling') || pt.includes('architectural')) discipline = 'Architectural';
    else if (pt.includes('structural') || pt.includes('framing') || pt.includes('beam')) discipline = 'Structural';
    else if (pt.includes('mechanical') || pt.includes('hvac') || pt.includes('ductwork') || pt.includes('plumbing') || pt.includes('vav')) discipline = 'Mechanical';
    else if (pt.includes('electrical') || pt.includes('panel') || pt.includes('circuit') || pt.includes('conduit')) discipline = 'Electrical';
    else if (pt.includes('civil') || pt.includes('grading') || pt.includes('drainage')) discipline = 'Civil';
    else if (pt.includes('fire') || pt.includes('sprinkler')) discipline = 'Fire Protection';

    const needsImage = pageText.length < TEXT_THRESHOLD;
    const entry = `=== SHEET: ${sheetNum} | PAGE: ${i + 1} | DISCIPLINE: ${discipline}${needsImage ? ' | SCHEDULE — SEE IMAGE' : ''} ===\n${pageText || '(see image)'}`;
    fullText += entry + '\n\n';
    sheetList.push({ sheet: sheetNum, discipline, pageNum: i + 1, needsImage });
  }

  const MAX_CHARS = 120000;
  if (fullText.length > MAX_CHARS) fullText = fullText.slice(0, MAX_CHARS) + '\n\n[... truncated ...]';

  res.status(200).json({
    fullText,
    sheetList,
    totalPages: Math.min(pageCount, pagesMax || 50),
  });
}

async function legacyProxy(body, res) {
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
      messages: body.messages
    })
  });

  const data = await r.json();
  res.status(200).json(data);
}
