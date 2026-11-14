// Signed requests to an R2 bucket over its S3 API, for the scripts in this folder that work on the bucket.
//
// Those scripts run with the upload keys. Keep this file free of imports other than Node's own modules.
import { createHash, createHmac } from "node:crypto";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** The bucket and its keys, from the environment. With `optional`, missing ones are left empty, for a dry run that sends nothing. */
export function targetFromEnv({ optional = false } = {}) {
  const need = (name) => {
    const value = process.env[name];
    if (!value && !optional) throw new Error(`${name} is not set`);
    return value ?? "";
  };
  return { account: need("R2_ACCOUNT_ID"), accessKeyId: need("R2_ACCESS_KEY_ID"), secretAccessKey: need("R2_SECRET_ACCESS_KEY"), bucket: need("R2_BUCKET") };
}

/** R2_PREFIX without slashes at its ends. Everything the scripts write or delete is under it. */
export function prefixFromEnv() {
  const prefix = (process.env.R2_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(prefix)) throw new Error("R2_PREFIX is missing or has unexpected characters");
  return prefix;
}

/**
 * AWS Signature V4 for one S3 request. `headers` holds every signed header, names in lower case.
 * `query` is the query string as it is sent, with its names in order. R2 uses the region "auto".
 */
function sign({ method, path: requestPath, query, headers, accessKeyId, secretAccessKey }) {
  const amzDate = headers["x-amz-date"];
  const day = amzDate.slice(0, 8);
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, requestPath, query, canonicalHeaders, signedHeaders, headers["x-amz-content-sha256"]].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// Percent-encoding the way Signature V4 wants it. encodeURIComponent on its own leaves ! ' ( ) * as they are.
const encode = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * One signed request, tried up to four times. It returns the answer, or throws when the request fails for good.
 * Without a key it goes to the bucket itself, which is how objects are listed.
 * `failure` starts the error message, as in "<key>: upload failed".
 */
export async function send({ account, accessKeyId, secretAccessKey, bucket }, { method, key = "", query = {}, headers = {}, body, failure }) {
  // Only listing goes to the bucket itself. A DELETE without a key would ask to delete the whole bucket.
  if (!key && method !== "GET") throw new Error(`${method} needs a key`);
  const host = `${account}.r2.cloudflarestorage.com`;
  const requestPath = `/${bucket}${key && "/"}${key.split("/").map(encode).join("/")}`;
  const names = Object.keys(query).sort();
  const queryString = names.map((name) => `${encode(name)}=${encode(query[name])}`).join("&");
  for (let attempt = 1; ; attempt++) {
    // Sign again on every try. A signature that is too old is rejected.
    const signed = {
      host,
      "x-amz-date": new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
      "x-amz-content-sha256": sha256(body ?? ""),
      ...headers,
    };
    const authorization = sign({ method, path: requestPath, query: queryString, headers: signed, accessKeyId, secretAccessKey });
    const { host: _host, ...sent } = signed;
    const url = `https://${host}${requestPath}${queryString && "?"}${queryString}`;
    const response = await fetch(url, { method, headers: { ...sent, authorization }, body }).catch(() => ({
      ok: false,
      status: 0,
      text: async () => "",
    }));
    if (response.ok) return response;
    // Print the error code only, not the whole answer.
    const code = (await response.text()).match(/<Code>([A-Za-z]{1,60})<\/Code>/)?.[1] ?? "no error code";
    const retry = response.status === 0 || response.status === 429 || response.status >= 500;
    if (!retry || attempt >= 4) throw new Error(`${failure} (${response.status}, ${code})`);
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}
