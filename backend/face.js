const path = require('path');
const faceapi = require('@vladmandic/face-api');
try {
  require('@tensorflow/tfjs-node');
} catch (error) {
  require('@tensorflow/tfjs');
}
const { Canvas, Image, ImageData, loadImage } = require('@napi-rs/canvas');

faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const modelsPath = process.env.FACE_MODELS_PATH || path.join(__dirname, 'models');
let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);
  modelsLoaded = true;
}

function bufferFromBase64(base64Data) {
  const cleaned = base64Data.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(cleaned, 'base64');
}

async function getFaceDescriptor(base64Data) {
  await loadModels();
  const buffer = bufferFromBase64(base64Data);
  const image = await loadImage(buffer);
  const result = await faceapi
    .detectSingleFace(image)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!result) {
    const error = new Error('No face detected');
    error.code = 'NO_FACE_DETECTED';
    throw error;
  }

  return Array.from(result.descriptor);
}

function calculateDistance(descriptorA, descriptorB) {
  return faceapi.euclideanDistance(descriptorA, descriptorB);
}

function isMatch(descriptorA, descriptorB) {
  const threshold = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.6');
  const distance = calculateDistance(descriptorA, descriptorB);
  return { match: distance <= threshold, distance, threshold };
}

module.exports = {
  getFaceDescriptor,
  isMatch,
};
