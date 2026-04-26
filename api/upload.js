export const config = {
  api: {
    bodyParser: {
      sizeLimit: '52mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  try {
    const { fileName, fileData } = req.body;
    if (!fileData || !fileName) { res.status(400).json({ error: 'Missing file data' }); return; }

    // Convert base64 to buffer
    const buffer = Buffer.from(fileData, 'base64');

    // Upload to Anthropic Files API using multipart form
    const FormData = (await import('node:stream')).Readable;
    
    // Build multipart manually since we can't use FormData in all Node versions
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    
    const metaPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
      `assistants\r\n`
    );
    
    const filePart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    );
    
    const endPart = Buffer.from(`\r\n--${boundary}--\r\n`);
    
    const body = Buffer.concat([metaPart, filePart, buffer, endPart]);

    const uploadRes = await fetch('https://api.anthropic.com/v1/files', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length.toString(),
      },
      body: body,
    });

    const uploadData = await uploadRes.json();
    
    if (!uploadRes.ok) {
      console.error('Files API error:', uploadData);
      res.status(uploadRes.status).json({ error: uploadData?.error?.message || 'Upload failed' });
      return;
    }

    res.status(200).json({ 
      fileId: uploadData.id,
      fileName: uploadData.filename,
      size: uploadData.size
    });

  } catch(e) {
    console.error('Upload handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
