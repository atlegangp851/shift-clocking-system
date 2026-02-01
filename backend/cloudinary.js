const cloudinary = require('cloudinary').v2;

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
}

const uploadFolder = process.env.CLOUDINARY_FOLDER || 'shift-clocking-system';

async function uploadImage(base64, publicIdPrefix) {
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary credentials are not configured');
  }

  const result = await cloudinary.uploader.upload(base64, {
    folder: uploadFolder,
    public_id: `${publicIdPrefix}-${Date.now()}`,
    resource_type: 'image',
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
  };
}

module.exports = {
  uploadImage,
  uploadFolder,
};