const {
  createECDH,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} = require("crypto");

function generateKeyPair(curve = "secp256k1") {
  const ecdh = createECDH(curve);
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey("base64"),
    privateKey: ecdh.getPrivateKey("base64"),
    curve,
  };
}

function deriveSharedSecret(privateKeyB64, peerPublicKeyB64, curve = "secp256k1") {
  const ecdh = createECDH(curve);
  ecdh.setPrivateKey(Buffer.from(privateKeyB64, "base64"));
  return ecdh.computeSecret(Buffer.from(peerPublicKeyB64, "base64"));
}

function hkdf(secret, salt, info = "flixers-e2e", length = 32) {
  const saltBuf = salt ? Buffer.from(salt, "base64") : randomBytes(16);
  const key = hkdfSync("sha256", saltBuf, secret, Buffer.from(info, "utf8"), length);
  return { key, salt: saltBuf.toString("base64") };
}

function encryptJson(payload, key, iv) {
  const ivBuf = iv ? Buffer.from(iv, "base64") : randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, ivBuf);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: ivBuf.toString("base64"),
    tag: tag.toString("base64"),
    alg: "aes-256-gcm",
  };
}

function decryptJson({ ciphertext, iv, tag }, key) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function buildEncryptedEnvelope(message, opts) {
  const { privateKey, peerPublicKey, curve = "secp256k1", salt, info } = opts;
  const secret = deriveSharedSecret(privateKey, peerPublicKey, curve);
  const { key, salt: derivedSalt } = hkdf(secret, salt, info);
  return { ...encryptJson(message, key), salt: derivedSalt };
}

function openEncryptedEnvelope(envelope, opts) {
  const { privateKey, peerPublicKey, curve = "secp256k1", info } = opts;
  const secret = deriveSharedSecret(privateKey, peerPublicKey, curve);
  const { key } = hkdf(secret, envelope.salt, info);
  return decryptJson(envelope, key);
}

module.exports = {
  generateKeyPair,
  deriveSharedSecret,
  hkdf,
  encryptJson,
  decryptJson,
  buildEncryptedEnvelope,
  openEncryptedEnvelope,
};
