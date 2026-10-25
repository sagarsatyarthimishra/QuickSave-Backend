
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 5000;

function identifyVideoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return {
      success: false,
      message: 'Video URL is required.',
    };
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(value.trim());
  } catch {
    return {
      success: false,
      message: 'Invalid URL. Please enter a valid video URL.',
    };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return {
      success: false,
      message: 'Only HTTP and HTTPS URLs are supported.',
    };
  }

  const host = parsedUrl.hostname.toLowerCase();

  // Correct regex for direct video file URLs.
  const directVideo = /\.(mp4|mov|m4v|webm)$/i.test(
    parsedUrl.pathname
  );

  const isDomain = (domain) =>
    host === domain || host.endsWith(`.${domain}`);

  let platform = null;

  if (
    isDomain('youtube.com') ||
    host === 'youtu.be' ||
    isDomain('youtube-nocookie.com')
  ) {
    platform = 'YouTube';
  } else if (
    isDomain('instagram.com') ||
    host === 'instagr.am'
  ) {
    platform = 'Instagram';
  } else if (
    isDomain('facebook.com') ||
    host === 'fb.watch' ||
    host === 'fb.com'
  ) {
    platform = 'Facebook';
  } else if (directVideo) {
    platform = 'Direct Video';
  }

  if (!platform) {
    return {
      success: false,
      message: 'Unsupported video URL.',
    };
  }

  return {
    success: true,
    platform,
    directVideo,
    metadataAvailable: false,
    downloadReady: false,
    message: `${platform} URL recognized. Media availability has not been verified.`,
  };
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    app: 'QuickSave Backend',
    message: 'Backend is running.',
  });
});

// URL validation
app.post('/api/validate-url', (req, res) => {
  const result = identifyVideoUrl(req.body?.url);

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.json(result);
});

// Video metadata status
app.post('/api/video-info', (req, res) => {
  const result = identifyVideoUrl(req.body?.url);

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.status(501).json({
    success: false,
    platform: result.platform,
    formats: [],
    metadataAvailable: false,
    downloadReady: false,
    message:
      `The ${result.platform} URL is recognized, but a compatible media metadata provider has not been configured.`,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QuickSave API running on port ${PORT}`);
});
