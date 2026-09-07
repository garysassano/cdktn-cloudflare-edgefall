/** Signed anonymous identity shared by the gateway and local room integration harness. */
export const PROFILE_COOKIE_NAME = "edgefall_profile";
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}
function encodeSignature(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function key(secret: string) {
  if (secret.length < 32)
    throw new Error("Profile signing key must contain at least 32 characters");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export function profileCookie(header: string | null): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PROFILE_COOKIE_NAME}=`));
  return values.length === 1 ? values[0]?.slice(PROFILE_COOKIE_NAME.length + 1) : undefined;
}
export async function signProfileIdentity(
  id: string,
  expires: number,
  secret: string,
): Promise<string> {
  if (
    !isProfileId(id) ||
    !Number.isSafeInteger(expires) ||
    expires <= 0 ||
    expires > 999_999_999_999
  )
    throw new Error("Invalid profile identity");
  const payload = `${id}.${expires}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(payload),
  );
  const encoded = encodeSignature(new Uint8Array(signature));
  return `${payload}.${encoded}`;
}
export async function verifyProfileIdentity(
  value: string | undefined,
  secret: string,
  nowSeconds: number,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error("Invalid profile clock");
  if (!value || value.length > 128) return undefined;
  const parts = value.split(".");
  const [id, expiresText, signature] = parts;
  if (
    parts.length !== 3 ||
    !id ||
    !idPattern.test(id) ||
    !expiresText ||
    !/^[1-9][0-9]{0,11}$/u.test(expiresText) ||
    !signature ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature)
  )
    return undefined;
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires <= nowSeconds) return undefined;
  const bytes = Uint8Array.from(
    atob(`${signature.replaceAll("-", "+").replaceAll("_", "/")}=`),
    (character) => character.charCodeAt(0),
  );
  if (encodeSignature(bytes) !== signature) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    new TextEncoder().encode(`${id}.${expiresText}`),
  );
  return valid ? id : undefined;
}
