// netlify/functions/presign-wasabi.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

module.exports = function(app) {
  app.post('/cal-presign-wasabi', async (req, res) => {
try {
    const body = (req.body || {});
    const ext = (body.ext || 'png').toLowerCase();
    const contentType = body.contentType || `image/${ext}`;
    const userRaw = body.user || 'user';

    // Cloudflare R2 config
    const accountId = process.env.R2_ACCOUNT_ID;
    const bucket = process.env.R2_BUCKET_NAME_STUDENTS_TEACHERS;

    // Default R2 region + S3 endpoint
    const region = process.env.R2_REGION || 'auto';
    const endpoint = `${accountId}.r2.cloudflarestorage.com`;

    // Public / CDN base – from your Netlify env var
    const rawCdn = process.env.R2_PUBLIC_BUCKET_URL_STUDENTS_TEACHERS || endpoint;
    const cdnBase = rawCdn.startsWith('http')
      ? rawCdn.replace(/\/$/, '')
      : `https://${rawCdn.replace(/\/$/, '')}`;

    if (
      !accountId ||
      !bucket ||
      !process.env.R2_ACCESS_KEY_ID ||
      !process.env.R2_SECRET_ACCESS_KEY
    ) {
      return res.status(500).json({ error: 'Missing R2 env vars' });
    }

    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const ts = `${pad(now.getDate())}${pad(now.getMonth() + 1)}${now.getFullYear()}_${pad(
      now.getHours()
    )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const safeUser = String(userRaw).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'user';
    const key = `${safeUser}_${ts}.${ext}`;

    const s3 = new S3Client({
      region,
      endpoint: `https://${endpoint}`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      },
      forcePathStyle: true,
      // Disable automatic CRC32 checksums – R2 does not support them
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });

    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType
      // R2 does not support ACL headers, so we do NOT set ACL here
    });

    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 60 }); // 60s
    const publicUrl = `${cdnBase}/${key}`;

    return res.status(200).json({ uploadUrl, publicUrl, key });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  });
};
