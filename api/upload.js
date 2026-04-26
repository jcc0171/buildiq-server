import { put } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: false, // Stream the body — bypasses 4.5MB limit
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).end(); return; }

  try {
    const fileName = req.headers['x-file-name'] || 'drawing.pdf';
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Stream directly from request body to Vercel Blob
    // bodyParser is false so req is a raw readable stream
    // put() accepts a ReadableStream — no buffering, no size limit
    const blob = await put(safeName, req, {
      access: 'private',
      contentType: 'application/pdf',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    res.status(200).json({ blobUrl: blob.url });

  } catch(e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: e.message });
  }
}
