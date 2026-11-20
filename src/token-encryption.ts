/// Sign in with Apple refresh token 的 AES-GCM 加密(#3)。金鑰是 secret `APPLE_TOKEN_ENCRYPTION_KEY`(base64 的 32 bytes)。
/// 存成 base64(12 bytes IV ‖ 密文);以身分的 subject 當 AAD,權杖搬到別的身分列就解不開。

const IV_LENGTH = 12;

async function importKey(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.APPLE_TOKEN_ENCRYPTION_KEY), (character) => character.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error("APPLE_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64).");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptAppleToken(env: Env, subject: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(subject) },
    await importKey(env),
    new TextEncoder().encode(token),
  );
  const sealed = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), IV_LENGTH);
  return btoa(String.fromCharCode(...sealed));
}

/// 解不開(格式錯、金鑰換過、被竄改)回 null,呼叫端視同沒有權杖(撤銷是盡力而為)。
export async function decryptAppleToken(env: Env, subject: string, stored: string): Promise<string | null> {
  try {
    const sealed = Uint8Array.from(atob(stored), (character) => character.charCodeAt(0));
    if (sealed.length <= IV_LENGTH) {
      return null;
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, IV_LENGTH), additionalData: new TextEncoder().encode(subject) },
      await importKey(env),
      sealed.slice(IV_LENGTH),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
