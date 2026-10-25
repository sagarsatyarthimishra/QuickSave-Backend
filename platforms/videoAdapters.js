
const adapters = {
  YouTube: {
    getInfo: async () => ({
      platform: 'YouTube',
      supported: false,
      formats: [],
      message:
        'Connect an eligible official integration to retrieve video metadata and permitted downloads.',
    }),
  },

  Instagram: {
    getInfo: async () => ({
      platform: 'Instagram',
      supported: false,
      formats: [],
      message:
        'Connect the Instagram Platform API for eligible account media.',
    }),
  },

  Facebook: {
    getInfo: async () => ({
      platform: 'Facebook',
      supported: false,
      formats: [],
      message:
        'Connect the Facebook Graph API for eligible Page media.',
    }),
  },

  'Direct Video': {
    getInfo: async () => ({
      platform: 'Direct Video',
      supported: true,
      formats: [],
      message:
        'Use the existing /api/video-info endpoint to inspect a direct video URL.',
    }),
  },
};

function getAdapter(platform) {
  return adapters[platform] || null;
}

module.exports = { getAdapter };
