
const express = require('express');
const cors = require('cors');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
require('dotenv').config();

const app = express();
const execFileAsync = promisify(execFile);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 5000;
const METADATA_TIMEOUT_MS = 45000;

// Set this if Python is not available through the "python" command.
// Example Windows value: C:\\Users\\YourUser\\AppData\\Local\\Programs\\Python\\Python313\\python.exe
const PYTHON_COMMAND = process.env.PYTHON_COMMAND || 'python';

function identifyVideoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return {
      success: false,
      message: 'Video URL is required.',
    };
  }

  let parsed;

  try {
    parsed = new URL(value.trim());
  } catch {
    return {
      success: false,
      message: 'Invalid URL.',
    };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      success: false,
      message: 'Only HTTP and HTTPS URLs are supported.',
    };
  }

  const host = parsed.hostname.toLowerCase();

  // Basic private-network protection.
  // Production deployments should additionally enforce network-level
  // egress restrictions and resolve/check destination IP addresses.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '127.0.0.1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return {
      success: false,
      message: 'Private network URLs are not supported.',
    };
  }

  const isDomain = (domain) =>
    host === domain || host.endsWith(`.${domain}`);

  const directVideo =
    /\.(mp4|mov|m4v|webm)$/i.test(parsed.pathname);

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
    url: parsed.href,
  };
}

function getQualityLabel(height) {
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  if (height >= 240) return '240p';

  return `${height}p`;
}

function buildQualityOptions(info) {
  const candidates = (info.formats || []).filter((format) => (
    Number.isFinite(format.height) &&
    format.height > 0 &&
    format.vcodec &&
    format.vcodec !== 'none' &&
    ['mp4', 'webm', 'mov', 'm4v'].includes(format.ext)
  ));

  // Prefer MP4, then formats that already include audio,
  // then formats with known size information.
  candidates.sort((a, b) => {
    const mp4A = a.ext === 'mp4' ? 1 : 0;
    const mp4B = b.ext === 'mp4' ? 1 : 0;

    if (mp4A !== mp4B) return mp4B - mp4A;

    const audioA =
      a.acodec && a.acodec !== 'none' ? 1 : 0;
    const audioB =
      b.acodec && b.acodec !== 'none' ? 1 : 0;

    if (audioA !== audioB) return audioB - audioA;

    const sizeA = a.filesize ?? a.filesize_approx ?? 0;
    const sizeB = b.filesize ?? b.filesize_approx ?? 0;

    return sizeB - sizeA;
  });

  // Keep one preferred format for each resolution.
  const chosen = new Map();

  for (const format of candidates) {
    if (!chosen.has(format.height)) {
      chosen.set(format.height, format);
    }
  }

  return [...chosen.values()]
    .sort((a, b) => b.height - a.height)
    .map((format) => {
      const exactSize = format.filesize ?? null;
      const approximateSize = format.filesize_approx ?? null;

      // A bitrate-based size is an estimate, not an exact file size.
      const bitrateEstimate =
        format.tbr > 0 && info.duration > 0
          ? Math.round(
              (format.tbr * 1000 * info.duration) / 8
            )
          : null;

      const sizeBytes =
        exactSize ?? approximateSize ?? bitrateEstimate;

      const sizeType =
        exactSize != null
          ? 'exact'
          : approximateSize != null || bitrateEstimate != null
            ? 'estimated'
            : 'unknown';

      return {
        id: String(format.format_id),
        label: `${getQualityLabel(format.height)} - ${format.ext.toUpperCase()}`,
        resolution: format.height,
        ext: format.ext,
        sizeBytes,
        sizeType,
        hasAudio: Boolean(
          format.acodec && format.acodec !== 'none'
        ),
      };
    });
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

  return res.json({
    success: true,
    platform: result.platform,
    directVideo: result.directVideo,
    metadataAvailable: false,
    downloadReady: false,
    message: `${result.platform} URL recognized.`,
  });
});

// Retrieve metadata and available formats.
// Use only for content you are authorized to access.
app.post('/api/video-info', async (req, res) => {
  const result = identifyVideoUrl(req.body?.url);

  if (!result.success) {
    return res.status(400).json(result);
  }

  try {
    const { stdout } = await execFileAsync(
      PYTHON_COMMAND,
      [
        '-m',
        'yt_dlp',
        '--no-warnings',
        '--no-playlist',
        '--dump-single-json',
        result.url,
      ],
      {
        timeout: METADATA_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      }
    );

    const info = JSON.parse(stdout);
    const formats = buildQualityOptions(info);

    if (formats.length === 0) {
      return res.status(422).json({
        success: false,
        platform: result.platform,
        title: info.title || 'Untitled video',
        duration: info.duration ?? null,
        formats: [],
        metadataAvailable: true,
        downloadReady: false,
        message:
          'Metadata was retrieved, but no supported video formats were found.',
      });
    }

    return res.json({
      success: true,
      platform: result.platform,
      title: info.title || 'Untitled video',
      duration: info.duration ?? null,
      formats,
      metadataAvailable: true,
      downloadReady: false,
      message: 'Available video formats retrieved.',
    });
  } catch (error) {
    const timedOut =
      error.killed || error.signal === 'SIGTERM';

    console.error(
      'Video metadata retrieval failed:',
      error.message
    );

    return res.status(timedOut ? 504 : 502).json({
      success: false,
      platform: result.platform,
      formats: [],
      metadataAvailable: false,
      downloadReady: false,
      message: timedOut
        ? 'Metadata request timed out. Please try again.'
        : 'Could not retrieve video metadata. The source may be unavailable or require supported access.',
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QuickSave API running on port ${PORT}`);
});
