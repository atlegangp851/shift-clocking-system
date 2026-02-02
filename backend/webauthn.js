const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');

const rpName = process.env.WEBAUTHN_RP_NAME || 'Shift Clocking System';
const rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
const origin = process.env.WEBAUTHN_ORIGIN || 'https://shift-clocking-system.onrender.com';

function toBase64URL(buffer) {
  return isoBase64URL.fromBuffer(buffer);
}

function toBuffer(base64url) {
  return isoBase64URL.toBuffer(base64url);
}

function buildRegistrationOptions({ employeeId, existingCredentials }) {
  return generateRegistrationOptions({
    rpName,
    rpID,
    userID: Buffer.from(employeeId),
    userName: employeeId,
    timeout: 60000,
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
    },
    excludeCredentials: existingCredentials.map((credential) => ({
      id: toBuffer(credential.credential_id),
      type: 'public-key',
    })),
  });
}

function buildAuthenticationOptions({ credentials }) {
  return generateAuthenticationOptions({
    timeout: 60000,
    rpID,
    userVerification: 'required',
    allowCredentials: credentials.map((credential) => ({
      id: toBuffer(credential.credential_id),
      type: 'public-key',
      transports: credential.transports || undefined,
    })),
  });
}

async function verifyRegistration({ response, expectedChallenge }) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
}

async function verifyAuthentication({ response, expectedChallenge, credential }) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    authenticator: {
      credentialID: toBuffer(credential.credential_id),
      credentialPublicKey: toBuffer(credential.public_key),
      counter: credential.counter,
      transports: credential.transports || undefined,
    },
  });
}

module.exports = {
  rpName,
  rpID,
  origin,
  toBase64URL,
  toBuffer,
  buildRegistrationOptions,
  buildAuthenticationOptions,
  verifyRegistration,
  verifyAuthentication,
};
