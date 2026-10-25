
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    app: 'QuickSave Backend',
    message: 'Backend is running',
  });
});

app.post('/api/validate-url', (req, res) => {
  const { url } = req.body;

  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({
      success: false,
      message: 'Video URL is required',
    });
  }

  try {
    const parsed = new URL(url.trim());

    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Unsupported protocol');
    }

    const host = parsed.hostname.toLowerCase();
    const directVideo = /\.(mp4|mov|m4v|webm)$/i.test(
      parsed.pathname
    );

    const platform =
      host === 'youtube.com' || host.endsWith('.youtube.com') ||
      host === 'youtu.be'
        ? 'YouTube'
        : host === 'instagram.com' || host.endsWith('.instagram.com')
        ? 'Instagram'
        : host === 'facebook.com' || host.endsWith('.facebook.com') ||
          host === 'fb.watch'
        ? 'Facebook'
        : directVideo
        ? 'Direct Video'
        : null;

    if (!platform) {
      return res.status(400).json({
        success: false,
        message: 'Unsupported URL',
      });
    }

    return res.json({
      success: true,
      platform,
      directVideo,
      message: directVideo
        ? 'Direct video URL recognized'
        : 'Platform URL recognized; an authorized download integration is still required',
    });
  } catch {
    return res.status(400).json({
      success: false,
      message: 'Invalid URL',
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QuickSave API running on port ${PORT}`);
});
