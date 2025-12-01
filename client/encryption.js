const ENC_PREFIX = 'enc-v1:';
const VERIFIER_PLAINTEXT = 'memus-article-encryption-ok';

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  throw new Error('No base64 encoder available');
}

function base64ToBytes(value) {
  if (!value) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(value, 'base64');
    const bytes = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i += 1) {
      bytes[i] = buf[i];
    }
    return bytes;
  }
  throw new Error('No base64 decoder available');
}

export function isEncryptedText(text) {
  return typeof text === 'string' && text.startsWith(ENC_PREFIX);
}

export async function deriveKeyFromPassword(password, saltBase64) {
  if (!password) {
    throw new Error('Password is required');
  }
  const salt =
    saltBase64 && saltBase64.length ? base64ToBytes(saltBase64) : fallbackRandomBytes(16);
  const pwdBytes = simpleHashToBytes(password || '');
  const combined = new Uint8Array(pwdBytes.length + salt.length);
  combined.set(pwdBytes, 0);
  combined.set(salt, pwdBytes.length);
  const keyBytes = simpleHashToBytes(String.fromCharCode(...combined));
  return { key: { raw: keyBytes }, salt: bytesToBase64(salt) };
}

function simpleHashToBytes(input = '') {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = (h1 * 16777619) >>> 0;
    h2 ^= ch << (i % 8);
    h2 = (h2 * 16777619) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const v = i < 16 ? h1 : h2;
    out[i] = (v >>> ((i % 4) * 8)) & 0xff;
  }
  return out;
}

function fallbackRandomBytes(len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

export async function encryptString(key, plaintext = '') {
  if (!key) {
    throw new Error('Missing encryption key');
  }
  const keyBytes = key && key.raw ? key.raw : simpleHashToBytes('fallback-key');
  const iv = fallbackRandomBytes(12);
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext || '');
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv, 0);
  for (let i = 0; i < data.length; i += 1) {
    const kb = keyBytes[i % keyBytes.length];
    const nb = iv[i % iv.length];
    out[iv.length + i] = data[i] ^ kb ^ nb;
  }
  return `${ENC_PREFIX}${bytesToBase64(out)}`;
}

export async function decryptString(key, payload) {
  if (!key) {
    throw new Error('Missing encryption key');
  }
  if (!isEncryptedText(payload)) {
    throw new Error('Data is not in encrypted format');
  }
  const encoded = payload.slice(ENC_PREFIX.length);
  const combined = base64ToBytes(encoded);
  if (combined.length < 13) {
    throw new Error('Encrypted payload is too short');
  }
  const iv = combined.slice(0, 12);
  const cipherBytes = combined.slice(12);
  const keyBytes = key && key.raw ? key.raw : simpleHashToBytes('fallback-key');
  const out = new Uint8Array(cipherBytes.length);
  for (let i = 0; i < cipherBytes.length; i += 1) {
    const kb = keyBytes[i % keyBytes.length];
    const nb = iv[i % iv.length];
    out[i] = cipherBytes[i] ^ kb ^ nb;
  }
  const decoder = new TextDecoder();
  return decoder.decode(out);
}

export async function createEncryptionVerifier(key) {
  return encryptString(key, VERIFIER_PLAINTEXT);
}

export async function checkEncryptionVerifier(key, verifier) {
  if (!verifier) return false;
  try {
    const plain = await decryptString(key, verifier);
    return plain === VERIFIER_PLAINTEXT;
  } catch (error) {
    return false;
  }
}

export async function decryptBlockTree(block, key) {
  if (!block) return;
  if (typeof block.text === 'string' && isEncryptedText(block.text)) {
    try {
      // eslint-disable-next-line no-param-reassign
      block.text = await decryptString(key, block.text);
    } catch (error) {
      // eslint-disable-next-line no-param-reassign
      block.text = '';
    }
  }
  const children = Array.isArray(block.children) ? block.children : [];
  // eslint-disable-next-line no-restricted-syntax
  for (const child of children) {
    // eslint-disable-next-line no-await-in-loop
    await decryptBlockTree(child, key);
  }
}

export async function decryptArticleBlocks(article, key) {
  if (!article || !Array.isArray(article.blocks)) return;
  // eslint-disable-next-line no-restricted-syntax
  for (const block of article.blocks) {
    // eslint-disable-next-line no-await-in-loop
    await decryptBlockTree(block, key);
  }
}

export async function encryptBlockTree(block, key) {
  if (!block) return;
  if (typeof block.text === 'string') {
    // eslint-disable-next-line no-param-reassign
    block.text = await encryptString(key, block.text);
  }
  const children = Array.isArray(block.children) ? block.children : [];
  // eslint-disable-next-line no-restricted-syntax
  for (const child of children) {
    // eslint-disable-next-line no-await-in-loop
    await encryptBlockTree(child, key);
  }
}

export async function encryptTextForArticle(key, text) {
  return encryptString(key, text || '');
}

export { ENC_PREFIX };
