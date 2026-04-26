import { handleUpload } from '@vercel/blob/client';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const jsonResponse = await handleUpload({
    request: req,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    onBeforeGenerateToken: async (pathname) => {
      // Allow PDF uploads only
      return {
        allowedContentTypes: ['application/pdf'],
        maximumSizeInBytes: 100 * 1024 * 1024, // 100MB
      };
    },
    onUploadCompleted: async ({ blob }) => {
      console.log('Blob uploaded:', blob.url);
    },
  });

  return res.status(200).json(jsonResponse);
}
