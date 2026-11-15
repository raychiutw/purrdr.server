/// 測試用的 X.509 憑證產生器：只用 WebCrypto 與手寫的 DER 編碼，
/// 在 Node(vitest.config.ts 產生信任的根憑證)與 Workers 測試環境(簽中繼、葉憑證與 JWS)都能跑。
///
/// 憑證鏈模仿 Apple 簽 StoreKit／App Store Server Notifications JWS 的形狀(App Store Server Library 的檢查項目):
/// 根(P-384)→ 中繼(P-384,帶 Apple WWDR 中繼的 OID)→ 葉(P-256,帶 Apple 收據簽章的 OID),全部 ecdsa-with-SHA384。
/// 絕不使用真的 Apple 憑證或金鑰。

export const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecdsaWithSha384: "1.2.840.10045.4.3.3",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  /** Apple WWDR 中繼憑證的標記。 */
  appleIntermediate: "1.2.840.113635.100.6.2.1",
  /** Apple App Store 收據簽章葉憑證的標記。 */
  appleLeaf: "1.2.840.113635.100.6.11.1",
} as const;

// MARK: - DER 編碼

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  const length = value.length;
  let header: number[];
  if (length < 0x80) header = [tag, length];
  else if (length < 0x100) header = [tag, 0x81, length];
  else header = [tag, 0x82, length >> 8, length & 0xff];
  return concat(new Uint8Array(header), value);
}

const sequence = (...items: Uint8Array[]) => tlv(0x30, concat(...items));
const set = (...items: Uint8Array[]) => tlv(0x31, concat(...items));
const explicit = (tag: number, value: Uint8Array) => tlv(0xa0 + tag, value);
const octetString = (value: Uint8Array) => tlv(0x04, value);
const bitString = (value: Uint8Array) => tlv(0x03, concat(new Uint8Array([0]), value));
const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
const boolean = (value: boolean) => tlv(0x01, new Uint8Array([value ? 0xff : 0]));

function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.slice(start);
  return tlv(0x02, (trimmed[0] ?? 0) & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed);
}

function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const bytes = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let value = part >>> 7; value > 0; value >>>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, new Uint8Array(bytes));
}

function generalizedTime(date: Date): Uint8Array {
  const text = date.toISOString().replace(/[-:T]/g, "").replace(/\.\d+Z$/, "Z");
  return tlv(0x18, new TextEncoder().encode(text));
}

const name = (commonName: string) => sequence(set(sequence(oid(OID.commonName), utf8(commonName))));

/// WebCrypto 的 ECDSA 簽章是 r‖s;X.509 要 DER 的 SEQUENCE { r, s }。
function derSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return sequence(integer(raw.slice(0, half)), integer(raw.slice(half)));
}

// MARK: - 憑證

export type Curve = "P-256" | "P-384";

export type TestCertificate = {
  der: Uint8Array;
  /** 這張憑證的私鑰(用來簽下一層，或簽 JWS)。 */
  privateKey: CryptoKey;
  subject: string;
};

export type CertificateOptions = {
  subject: string;
  curve: Curve;
  /** 簽發者;沒給就是自簽(根憑證)。 */
  issuer?: { subject: string; privateKey: CryptoKey };
  /** 要帶的自訂 extension(值是 DER NULL)。 */
  markers?: string[];
  ca?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  /** 用這把金鑰當憑證裡的公鑰(預設產生新的)。 */
  keyPair?: CryptoKeyPair;
};

export async function generateKeyPair(curve: Curve): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"])) as CryptoKeyPair;
}

export async function makeCertificate(options: CertificateOptions): Promise<TestCertificate> {
  const keyPair = options.keyPair ?? (await generateKeyPair(options.curve));
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", keyPair.publicKey)) as ArrayBuffer);
  const signer = options.issuer ?? { subject: options.subject, privateKey: keyPair.privateKey };
  const extensions: Uint8Array[] = [];
  if (options.ca) extensions.push(sequence(oid(OID.basicConstraints), boolean(true), octetString(sequence(boolean(true)))));
  for (const marker of options.markers ?? []) extensions.push(sequence(oid(marker), octetString(new Uint8Array([0x05, 0x00]))));
  const signatureAlgorithm = sequence(oid(OID.ecdsaWithSha384));
  const serial = crypto.getRandomValues(new Uint8Array(12));
  serial[0] = serial[0]! & 0x7f;
  const now = Date.now();
  const tbs = sequence(
    explicit(0, integer(new Uint8Array([2]))),
    integer(serial),
    signatureAlgorithm,
    name(signer.subject),
    sequence(generalizedTime(options.notBefore ?? new Date(now - 86_400_000)), generalizedTime(options.notAfter ?? new Date(now + 365 * 86_400_000))),
    name(options.subject),
    spki,
    ...(extensions.length > 0 ? [explicit(3, sequence(...extensions))] : []),
  );
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-384" }, signer.privateKey, tbs));
  const der = sequence(tbs, signatureAlgorithm, bitString(derSignature(raw)));
  return { der, privateKey: keyPair.privateKey, subject: options.subject };
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
