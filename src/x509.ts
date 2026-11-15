/// 最小的 X.509(DER)解析與 ECDSA 憑證鏈驗證，只做驗 App Store JWS 需要的部分。
///
/// Workers 沒有 X509Certificate 可以讀任意 extension,所以自己解析;簽章驗證交給 WebCrypto。
/// 任何格式不符一律丟 `CertificateError`,呼叫端視為驗證失敗。

export class CertificateError extends Error {}

type Node = { tag: number; value: Uint8Array; /** 含 tag 與長度的完整編碼。 */ raw: Uint8Array };

function readNode(bytes: Uint8Array, offset: number): { node: Node; next: number } {
  const tag = bytes[offset];
  let lengthByte = bytes[offset + 1];
  if (tag === undefined || lengthByte === undefined) throw new CertificateError("DER 太短");
  let cursor = offset + 2;
  let length = lengthByte;
  if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f;
    if (count === 0 || count > 4) throw new CertificateError("DER 長度不支援");
    length = 0;
    for (let i = 0; i < count; i++) {
      lengthByte = bytes[cursor++];
      if (lengthByte === undefined) throw new CertificateError("DER 太短");
      length = length * 256 + lengthByte;
    }
  }
  const end = cursor + length;
  if (end > bytes.length) throw new CertificateError("DER 長度超出範圍");
  return { node: { tag, value: bytes.subarray(cursor, end), raw: bytes.subarray(offset, end) }, next: end };
}

/// 一個 DER 值底下的子節點。
function children(node: Node): Node[] {
  const result: Node[] = [];
  for (let offset = 0; offset < node.value.length; ) {
    const { node: child, next } = readNode(node.value, offset);
    result.push(child);
    offset = next;
  }
  return result;
}

function single(bytes: Uint8Array): Node {
  const { node, next } = readNode(bytes, 0);
  if (next !== bytes.length) throw new CertificateError("DER 後面有多餘的資料");
  return node;
}

function expect(node: Node | undefined, tag: number): Node {
  if (!node || node.tag !== tag) throw new CertificateError(`預期 tag 0x${tag.toString(16)}`);
  return node;
}

const SEQUENCE = 0x30;
const OID_TAG = 0x06;

function decodeOid(node: Node): string {
  const bytes = expect(node, OID_TAG).value;
  const first = bytes[0];
  if (first === undefined) throw new CertificateError("OID 是空的");
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function decodeTime(node: Node | undefined): number {
  if (!node) throw new CertificateError("缺少有效期間");
  const text = new TextDecoder().decode(node.value);
  let match: RegExpMatchArray | null;
  if (node.tag === 0x17 && (match = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    const year = Number(match[1]) < 50 ? 2000 + Number(match[1]) : 1900 + Number(match[1]);
    return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  }
  if (node.tag === 0x18 && (match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  }
  throw new CertificateError("時間格式不支援");
}

const CURVES: Record<string, { name: "P-256" | "P-384"; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
};

const SIGNATURE_HASHES: Record<string, "SHA-256" | "SHA-384"> = {
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
};

export type Certificate = {
  der: Uint8Array;
  tbs: Uint8Array;
  signatureHash: "SHA-256" | "SHA-384";
  /** DER 編碼的 ECDSA 簽章(SEQUENCE { r, s })。 */
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array;
  curve: "P-256" | "P-384";
  extensionOids: string[];
};

export function parseCertificate(der: Uint8Array): Certificate {
  const [tbsNode, algorithmNode, signatureNode] = children(expect(single(der), SEQUENCE));
  const tbs = expect(tbsNode, SEQUENCE);
  const signatureHash = SIGNATURE_HASHES[decodeOid(expect(children(expect(algorithmNode, SEQUENCE))[0], OID_TAG))];
  if (!signatureHash) throw new CertificateError("只接受 ECDSA 簽章");
  const bits = expect(signatureNode, 0x03).value;
  if (bits[0] !== 0) throw new CertificateError("簽章 bit string 不完整");

  const fields = children(tbs);
  // version 是 [0] EXPLICIT;沒有時代表 v1(沒有 extension)。
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const issuer = expect(fields[offset + 2], SEQUENCE);
  const [notBefore, notAfter] = children(expect(fields[offset + 3], SEQUENCE));
  const subject = expect(fields[offset + 4], SEQUENCE);
  const spki = expect(fields[offset + 5], SEQUENCE);
  const [keyAlgorithm] = children(spki);
  const [keyType, curveOid] = children(expect(keyAlgorithm, SEQUENCE));
  if (decodeOid(expect(keyType, OID_TAG)) !== "1.2.840.10045.2.1") throw new CertificateError("只接受 EC 公鑰");
  const curve = CURVES[decodeOid(expect(curveOid, OID_TAG))];
  if (!curve) throw new CertificateError("不支援的曲線");

  const extensionOids: string[] = [];
  for (const field of fields.slice(offset + 6)) {
    if (field.tag !== 0xa3) continue;
    for (const extension of children(expect(children(field)[0], SEQUENCE))) {
      extensionOids.push(decodeOid(expect(children(expect(extension, SEQUENCE))[0], OID_TAG)));
    }
  }

  return {
    der,
    tbs: tbs.raw,
    signatureHash,
    signature: bits.subarray(1),
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore: decodeTime(notBefore),
    notAfter: decodeTime(notAfter),
    spki: spki.raw,
    curve: curve.name,
    extensionOids,
  };
}

export function publicKey(certificate: Certificate, usage: "verify" = "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", certificate.spki, { name: "ECDSA", namedCurve: certificate.curve }, false, [usage]);
}

/// DER SEQUENCE { r, s } → WebCrypto 要的 r‖s(各補到曲線長度)。
function rawSignature(der: Uint8Array, size: number): Uint8Array {
  const [r, s] = children(expect(single(der), SEQUENCE));
  const out = new Uint8Array(size * 2);
  for (const [index, node] of [r, s].entries()) {
    let value = expect(node, 0x02).value;
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw new CertificateError("簽章長度不對");
    out.set(value, size * (index + 1) - value.length);
  }
  return out;
}

/// `certificate` 是否由 `issuer` 的私鑰簽發(名稱相符且簽章正確)。
export async function isIssuedBy(certificate: Certificate, issuer: Certificate): Promise<boolean> {
  if (!equalBytes(certificate.issuer, issuer.subject)) return false;
  const size = issuer.curve === "P-256" ? 32 : 48;
  return crypto.subtle.verify(
    { name: "ECDSA", hash: certificate.signatureHash },
    await publicKey(issuer),
    rawSignature(certificate.signature, size),
    certificate.tbs,
  );
}

export function isValidAt(certificate: Certificate, time: number): boolean {
  return certificate.notBefore <= time && time <= certificate.notAfter;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function base64Bytes(text: string): Uint8Array {
  try {
    return Uint8Array.from(atob(text.trim()), (character) => character.charCodeAt(0));
  } catch {
    throw new CertificateError("不是 base64");
  }
}
