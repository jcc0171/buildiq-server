import { createClient } from '@supabase/supabase-js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.js';
import { createCanvas } from 'canvas';

// ── PDF.js setup ──
const pdfjsLib = pdfjs;

// Text threshold — pages with fewer chars are schedule/table pages
// that need visual rendering
const TEXT_THRESHOLD = 800;

// Max pages to render as images (schedules get priority)
const MAX_SCHEDULE_IMAGES = 12;

// Image render scale — full resolution, no browser compression
const IMG_SCALE = 2.0;

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

    // ── MODE 1: Legacy proxy mode (Pass 2, Pass 3 calls) ──
    // These passes send pre-built messages, just forward to Claude
    if (body.messages && !body.pdfBase64) {
      return await legacyProxy(body, res);
    }

    // ── MODE 2: New PDF processing mode (Pass 1) ──
    // Frontend sends raw PDF as base64, server does all the work
    if (body.pdfBase64) {
      return await processPDF(body, res);
    }

    res.status(400).json({ error: 'Invalid request — provide either messages or pdfBase64' });

  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}

// ════════════════════════════════════════
// LEGACY PROXY — Pass 2 and Pass 3
// Just forwards pre-built messages to Claude
// ════════════════════════════════════════
async function legacyProxy(body, res) {
  const { messages, userId, skipLimitCheck } = body;

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
      messages
    })
  });

  const data = await r.json();
  res.status(200).json(data);
}

// ════════════════════════════════════════
// PDF PROCESSING — Pass 1
// Server-side PDF extraction and rendering
// No browser limits, full resolution images
// ════════════════════════════════════════
async function processPDF(body, res) {
  const { pdfBase64, userId, plan, rfiMax, pagesMax } = body;

  // ── Check upload limits ──
  if (userId) {
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

    await supabase
      .from('profiles')
      .update({ uploads_used: profile.uploads_used + 1 })
      .eq('id', userId);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  // ── Convert base64 PDF to buffer ──
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const pdfData = new Uint8Array(pdfBuffer);

  // ── Load PDF with pdfjs ──
  const pdf = await pdfjsLib.getDocument({
    data: pdfData,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const pageCount = pdf.numPages;
  const maxPages = pagesMax || 50;
  const pagesToProcess = Math.min(pageCount, maxPages);

  // ── Extract text from all pages ──
  let fullText = '';
  const sheetList = [];
  const schedulePageNums = []; // pages that need visual rendering

  for (let i = 1; i <= pagesToProcess; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ').trim();

    // Detect sheet number
    const sheetMatch = pageText.match(/\b([A-Z]{1,2}-?\d{3}[A-Z]?)\b/g);
    const sheetNum = sheetMatch ? sheetMatch[0] : `Page ${i}`;

    // Detect discipline
    let discipline = 'Unknown';
    const pt = pageText.toLowerCase();
    if (pt.includes('floor plan') || pt.includes('elevation') || pt.includes('ceiling') || pt.includes('partition')) discipline = 'Architectural';
    else if (pt.includes('structural') || pt.includes('framing') || pt.includes('foundation') || pt.includes('beam')) discipline = 'Structural';
    else if (pt.includes('mechanical') || pt.includes('hvac') || pt.includes('ductwork') || pt.includes('plumbing') || pt.includes('piping')) discipline = 'Mechanical';
    else if (pt.includes('electrical') || pt.includes('panel') || pt.includes('circuit') || pt.includes('conduit')) discipline = 'Electrical';
    else if (pt.includes('civil') || pt.includes('grading') || pt.includes('drainage')) discipline = 'Civil';
    else if (pt.includes('fire') || pt.includes('sprinkler') || pt.includes('suppression')) discipline = 'Fire Protection';

    // Flag schedule/table pages for visual rendering
    const needsImage = pageText.length < TEXT_THRESHOLD;
    if (needsImage && schedulePageNums.length < MAX_SCHEDULE_IMAGES) {
      schedulePageNums.push({ pageNum: i, sheetNum, discipline });
    }

    const entry = `=== SHEET: ${sheetNum} | PAGE: ${i} | DISCIPLINE: ${discipline}${needsImage ? ' | SCHEDULE — SEE IMAGE' : ''} ===\n${pageText || '(see image)'}`;
    fullText += entry + '\n\n';
    sheetList.push({ sheet: sheetNum, discipline, pageNum: i });
  }

  // ── Render schedule pages as full-resolution images ──
  const scheduleImages = [];

  for (const sp of schedulePageNums) {
    try {
      const page = await pdf.getPage(sp.pageNum);
      const viewport = page.getViewport({ scale: IMG_SCALE });

      // Use node-canvas for server-side rendering
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      // Export as high-quality JPEG
      const imgData = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
      scheduleImages.push({
        pageNum: sp.pageNum,
        sheetNum: sp.sheetNum,
        discipline: sp.discipline,
        imgData
      });

    } catch(e) {
      console.warn(`Could not render page ${sp.pageNum}:`, e.message);
    }
  }

  // ── Trim text to stay within token limits ──
  const MAX_CHARS = 120000; // Higher limit since we're server-side
  if (fullText.length > MAX_CHARS) {
    fullText = fullText.slice(0, MAX_CHARS) + '\n\n[... additional pages truncated for length ...]';
  }

  // ── Return processed data to frontend ──
  // Frontend handles the actual Claude API calls with this data
  res.status(200).json({
    fullText,
    sheetList,
    scheduleImages,
    totalPages: pagesToProcess,
    scheduleCount: scheduleImages.length,
  });
}
