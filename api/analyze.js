export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { prompt, messages, hasImages } = req.body || {};

    if (!prompt && !messages) {
      res.status(400).json({ error: 'No prompt or messages provided' });
      return;
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      res.status(500).json({ error: 'No API key' });
      return;
    }

    // Build the message content
    // If we have structured messages with images, use those
    // Otherwise fall back to simple text prompt
    let messageContent;

    if (messages && messages.length > 0 && hasImages) {
      // Visual analysis mode — use the full message array with images
      messageContent = messages;
    } else {
      // Text only mode — simple prompt
      messageContent = [{ role: 'user', content: prompt }];
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5-20251101', // Use most capable model for best RFI quality
        max_tokens: 4000,
        messages: messageContent
      })
    });

    const data = await r.json();
    res.status(200).json(data);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
