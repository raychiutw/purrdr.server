import { compactVerify, decodeProtectedHeader } from "jose";
import { base64Bytes, CertificateError, equalBytes, isIssuedBy, isValidAt, parseCertificate, publicKey } from "./x509";

/// 驗證 App Store 簽的 JWS(StoreKit 2 交易、續訂資訊、App Store Server Notifications v2)。
///
/// 與 Apple 的 App Store Server Library 同樣的檢查(不做線上 OCSP):
/// 1. header 是 ES256,`x5c` 恰好三張：葉、中繼、根;
/// 2. 根憑證與 `APPLE_ROOT_CERTIFICATES`(正式是 Apple Root CA - G3)其中一張逐位元組相同;
/// 3. 葉由中繼簽、中繼由根簽，三張在簽章時間(payload 的 `signedDate`)都在有效期間內;
/// 4. 中繼帶 Apple WWDR 中繼的 OID、葉帶 App Store 收據簽章的 OID;
/// 5. JWS 簽章用葉憑證的公鑰驗證。
/// 任何一項不符丟 `SignedDataError`。

export class SignedDataError extends Error {}

const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
const LEAF_OID = "1.2.840.113635.100.6.11.1";

export async function verifySignedData<T extends { signedDate?: number }>(env: Env, jws: string): Promise<T> {
  try {
    const header = decodeProtectedHeader(jws);
    if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
      throw new SignedDataError("JWS header 不是 App Store 的格式");
    }
    const [leaf, intermediate, root] = header.x5c.map((certificate) => parseCertificate(base64Bytes(certificate)));
    if (!leaf || !intermediate || !root) throw new SignedDataError("x5c 不完整");

    const trustedRoots = env.APPLE_ROOT_CERTIFICATES.split(",").filter((text) => text.trim().length > 0);
    if (!trustedRoots.some((trusted) => equalBytes(base64Bytes(trusted), root.der))) {
      throw new SignedDataError("根憑證不受信任");
    }
    if (!intermediate.extensionOids.includes(INTERMEDIATE_OID) || !leaf.extensionOids.includes(LEAF_OID)) {
      throw new SignedDataError("憑證不是 App Store 簽章用的");
    }
    if (!(await isIssuedBy(leaf, intermediate)) || !(await isIssuedBy(intermediate, root))) {
      throw new SignedDataError("憑證鏈簽章不符");
    }

    const { payload } = await compactVerify(jws, await publicKey(leaf), { algorithms: ["ES256"] });
    const decoded = JSON.parse(new TextDecoder().decode(payload)) as T;
    const signedAt = typeof decoded.signedDate === "number" ? decoded.signedDate : Date.now();
    if (![leaf, intermediate, root].every((certificate) => isValidAt(certificate, signedAt))) {
      throw new SignedDataError("憑證在簽章時間不在有效期間內");
    }
    return decoded;
  } catch (error) {
    if (error instanceof SignedDataError) throw error;
    if (error instanceof CertificateError) throw new SignedDataError(error.message);
    throw new SignedDataError(error instanceof Error ? error.message : "JWS 驗證失敗");
  }
}

/// StoreKit 2 交易(JWSTransactionDecodedPayload),只列後台用到的欄位。
export type TransactionPayload = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  expiresDate?: number;
  type: string;
  appAccountToken?: string;
  revocationDate?: number;
  signedDate: number;
  environment: string;
};

/// 續訂資訊(JWSRenewalInfoDecodedPayload)。
export type RenewalInfoPayload = {
  originalTransactionId: string;
  autoRenewStatus?: number;
  gracePeriodExpiresDate?: number;
  signedDate: number;
  environment: string;
};

/// App Store Server Notifications v2(ResponseBodyV2DecodedPayload)。
export type NotificationPayload = {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  signedDate: number;
  data?: {
    appAppleId?: number;
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
};
