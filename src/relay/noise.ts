// Noise_XX_25519_ChaChaPoly_SHA256 (Noise Protocol Framework, revision 34) on node:crypto only.
// https://noiseprotocol.org/noise.html — section numbers below refer to that document.
// Key material lives in #private fields so it never shows up in util.inspect or JSON output.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

/** Raw 32-byte X25519 keys. */
export interface NoiseKeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export const NOISE_PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_SHA256";
/** Every Noise message, handshake or transport, is at most 65535 bytes (section 3). */
export const NOISE_MAX_MESSAGE = 65535;

const DHLEN = 32;
const HASHLEN = 32;
const KEYLEN = 32;
const TAGLEN = 16;
/** 2^64-1 is reserved: once n reaches it, the CipherState refuses further use (section 5.1). */
const MAX_NONCE = 0xffff_ffff_ffff_ffffn;
const EMPTY = Buffer.alloc(0);
// PKCS#8 wrapper for a raw X25519 private key, used only to derive its public key.
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

type Token = "e" | "s" | "ee" | "es" | "se";
// XX (section 7.5): -> e / <- e, ee, s, es / -> s, se. No pre-messages.
const XX_MESSAGE_PATTERNS: readonly (readonly Token[])[] = [["e"], ["e", "ee", "s", "es"], ["s", "se"]];

// ---------------------------------------------------------------------------------------------
// Crypto functions (section 12): 25519, ChaChaPoly, SHA256.

export function generateNoiseKeyPair(): NoiseKeyPair {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.d) throw new Error("Noise: X25519 key generation returned an incomplete key");
  return { publicKey: Buffer.from(jwk.x, "base64url"), privateKey: Buffer.from(jwk.d, "base64url") };
}

/** Rebuilds a key pair from a raw 32-byte X25519 private key (for stored keys and test vectors). */
export function noiseKeyPairFromPrivateKey(privateKey: Buffer): NoiseKeyPair {
  if (privateKey.length !== DHLEN) throw new TypeError("Noise: an X25519 private key must be 32 bytes");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]), format: "der", type: "pkcs8" });
  const x = createPublicKey(key).export({ format: "jwk" }).x;
  if (!x) throw new Error("Noise: could not derive the X25519 public key");
  return { publicKey: Buffer.from(x, "base64url"), privateKey: Buffer.from(privateKey) };
}

function privateKeyObject(pair: NoiseKeyPair): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: pair.publicKey.toString("base64url"), d: pair.privateKey.toString("base64url") },
    format: "jwk",
  });
}

function publicKeyObject(publicKey: Buffer): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey.toString("base64url") }, format: "jwk" });
}

/** DH(key_pair, public_key). OpenSSL rejects an all-zero (low-order) result, which surfaces as a throw. */
function dh(local: NoiseKeyPair, remotePublicKey: Buffer): Buffer {
  return diffieHellman({ privateKey: privateKeyObject(local), publicKey: publicKeyObject(remotePublicKey) });
}

function hash(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF(chaining_key, input_key_material, 2) from section 4.3. XX never needs the third output. */
function hkdf2(chainingKey: Buffer, inputKeyMaterial: Buffer): [Buffer, Buffer] {
  const tempKey = hmac(chainingKey, inputKeyMaterial);
  const output1 = hmac(tempKey, Buffer.from([0x01]));
  const output2 = hmac(tempKey, Buffer.concat([output1, Buffer.from([0x02])]));
  return [output1, output2];
}

/** ChaChaPoly nonce: 32 bits of zeros followed by the 64-bit little-endian counter. */
function chachaNonce(n: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}

function aeadEncrypt(key: Buffer, n: bigint, ad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, chachaNonce(n), { authTagLength: TAGLEN });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  const body = cipher.update(plaintext);
  const tail = cipher.final();
  return Buffer.concat([body, tail, cipher.getAuthTag()]);
}

function aeadDecrypt(key: Buffer, n: bigint, ad: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < TAGLEN) throw new Error("Noise: ciphertext is shorter than the authentication tag");
  const body = ciphertext.subarray(0, ciphertext.length - TAGLEN);
  const decipher = createDecipheriv("chacha20-poly1305", key, chachaNonce(n), { authTagLength: TAGLEN });
  decipher.setAAD(ad, { plaintextLength: body.length });
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
  const plaintext = decipher.update(body);
  try {
    return Buffer.concat([plaintext, decipher.final()]);
  } catch {
    throw new Error("Noise: decryption failed (authentication tag mismatch)");
  }
}

function assertNonceUsable(n: bigint): void {
  if (n >= MAX_NONCE) throw new Error("Noise: nonce space exhausted");
}

// ---------------------------------------------------------------------------------------------
// CipherState (section 5.1).

export class NoiseCipherState {
  #k: Buffer | undefined;
  #n: bigint;

  /** InitializeKey(key). The optional starting nonce is the spec's SetNonce; transport code should leave it at 0. */
  constructor(key?: Buffer, nonce: bigint = 0n) {
    if (key !== undefined && key.length !== KEYLEN) throw new TypeError("Noise: a cipher key must be 32 bytes");
    if (nonce < 0n || nonce > MAX_NONCE) throw new RangeError("Noise: nonce must be a 64-bit unsigned integer");
    this.#k = key === undefined ? undefined : Buffer.from(key);
    this.#n = nonce;
  }

  hasKey(): boolean {
    return this.#k !== undefined;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (plaintext.length + (this.#k ? TAGLEN : 0) > NOISE_MAX_MESSAGE) {
      throw new RangeError(`Noise: a message may not exceed ${NOISE_MAX_MESSAGE} bytes`);
    }
    if (!this.#k) return Buffer.from(plaintext);
    assertNonceUsable(this.#n);
    const ciphertext = aeadEncrypt(this.#k, this.#n, ad, plaintext);
    this.#n += 1n;
    return ciphertext;
  }

  /** Throws on authentication failure without advancing the nonce. */
  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (ciphertext.length > NOISE_MAX_MESSAGE) throw new RangeError(`Noise: a message may not exceed ${NOISE_MAX_MESSAGE} bytes`);
    if (!this.#k) return Buffer.from(ciphertext);
    assertNonceUsable(this.#n);
    const plaintext = aeadDecrypt(this.#k, this.#n, ad, ciphertext);
    this.#n += 1n;
    return plaintext;
  }
}

/** Transport-message encryption with empty associated data. Refuses a keyless (pass-through) state. */
export function noiseEncrypt(state: NoiseCipherState, plaintext: Buffer): Buffer {
  if (plaintext.length > NOISE_MAX_MESSAGE - TAGLEN) {
    throw new RangeError(`Noise: transport plaintext may not exceed ${NOISE_MAX_MESSAGE - TAGLEN} bytes`);
  }
  if (!state.hasKey()) throw new Error("Noise: transport cipher state has no key");
  return state.encryptWithAd(EMPTY, plaintext);
}

export function noiseDecrypt(state: NoiseCipherState, ciphertext: Buffer): Buffer {
  if (ciphertext.length > NOISE_MAX_MESSAGE) throw new RangeError(`Noise: a message may not exceed ${NOISE_MAX_MESSAGE} bytes`);
  if (!state.hasKey()) throw new Error("Noise: transport cipher state has no key");
  return state.decryptWithAd(EMPTY, ciphertext);
}

// ---------------------------------------------------------------------------------------------
// SymmetricState (section 5.2). Internal; it carries its own k and n so a handshake step can run
// on a clone and be committed only when the whole message succeeds.

class SymmetricState {
  private ck: Buffer;
  private h: Buffer;
  private k: Buffer | undefined;
  private n: bigint;

  private constructor(ck: Buffer, h: Buffer, k: Buffer | undefined, n: bigint) {
    this.ck = ck;
    this.h = h;
    this.k = k;
    this.n = n;
  }

  static initialize(protocolName: string): SymmetricState {
    const name = Buffer.from(protocolName, "ascii");
    const h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : hash(name);
    return new SymmetricState(Buffer.from(h), h, undefined, 0n);
  }

  clone(): SymmetricState {
    return new SymmetricState(this.ck, this.h, this.k, this.n);
  }

  get handshakeHash(): Buffer {
    return Buffer.from(this.h);
  }

  hasKey(): boolean {
    return this.k !== undefined;
  }

  mixKey(inputKeyMaterial: Buffer): void {
    const [ck, tempK] = hkdf2(this.ck, inputKeyMaterial);
    this.ck = ck;
    this.k = tempK; // HASHLEN is 32, so no truncation is needed.
    this.n = 0n;
  }

  mixHash(data: Buffer): void {
    this.h = hash(Buffer.concat([this.h, data]));
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    let ciphertext: Buffer;
    if (this.k) {
      assertNonceUsable(this.n);
      ciphertext = aeadEncrypt(this.k, this.n, this.h, plaintext);
      this.n += 1n;
    } else {
      ciphertext = Buffer.from(plaintext);
    }
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    let plaintext: Buffer;
    if (this.k) {
      assertNonceUsable(this.n);
      plaintext = aeadDecrypt(this.k, this.n, this.h, ciphertext);
      this.n += 1n;
    } else {
      plaintext = Buffer.from(ciphertext);
    }
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Split(): [initiator-to-responder key, responder-to-initiator key]. */
  split(): [Buffer, Buffer] {
    return hkdf2(this.ck, EMPTY);
  }
}

// ---------------------------------------------------------------------------------------------
// HandshakeState (section 5.3) for pattern XX.

interface HandshakeOptions {
  initiator: boolean;
  prologue?: Buffer;
  staticKeyPair: NoiseKeyPair;
  /** Fixed ephemeral key pair. Only for test vectors: reusing an ephemeral key breaks Noise's security. */
  ephemeralKeyPair?: NoiseKeyPair;
}

interface StepState {
  symmetric: SymmetricState;
  e: NoiseKeyPair | undefined;
  re: Buffer | undefined;
  rs: Buffer | undefined;
}

function copyKeyPair(pair: NoiseKeyPair, label: string): NoiseKeyPair {
  if (pair.publicKey.length !== DHLEN || pair.privateKey.length !== DHLEN) {
    throw new TypeError(`Noise: ${label} must hold raw 32-byte X25519 keys`);
  }
  if (!noiseKeyPairFromPrivateKey(pair.privateKey).publicKey.equals(pair.publicKey)) {
    throw new Error(`Noise: ${label} public key does not match its private key`);
  }
  return { publicKey: Buffer.from(pair.publicKey), privateKey: Buffer.from(pair.privateKey) };
}

export class NoiseHandshake {
  readonly #initiator: boolean;
  readonly #s: NoiseKeyPair;
  #state: StepState;
  #messageIndex = 0;
  #failed = false;
  #transportKeys: [Buffer, Buffer] | undefined;
  #handshakeHash: Buffer | undefined;
  #splitTaken = false;

  constructor(options: HandshakeOptions) {
    this.#initiator = options.initiator;
    this.#s = copyKeyPair(options.staticKeyPair, "staticKeyPair");
    const symmetric = SymmetricState.initialize(NOISE_PROTOCOL_NAME);
    symmetric.mixHash(options.prologue ?? EMPTY);
    // XX has no pre-message patterns, so nothing else is mixed in before the first message.
    this.#state = {
      symmetric,
      e: options.ephemeralKeyPair ? copyKeyPair(options.ephemeralKeyPair, "ephemeralKeyPair") : undefined,
      re: undefined,
      rs: undefined,
    };
  }

  get complete(): boolean {
    return !this.#failed && this.#messageIndex === XX_MESSAGE_PATTERNS.length;
  }

  /** The peer's static key, once the message carrying it has been fully authenticated. */
  get remoteStaticKey(): Buffer | undefined {
    return this.#state.rs ? Buffer.from(this.#state.rs) : undefined;
  }

  /** GetHandshakeHash(): h after the final message, for channel binding. */
  get handshakeHash(): Buffer {
    if (!this.complete || !this.#handshakeHash) throw new Error("Noise: the handshake hash is only available after the handshake completes");
    return Buffer.from(this.#handshakeHash);
  }

  writeMessage(payload: Buffer = EMPTY): Buffer {
    const tokens = this.#nextTokens("write");
    // Size check before any state changes, so an oversize payload is a recoverable caller error.
    let length = 0;
    let keyed = this.#state.symmetric.hasKey();
    for (const token of tokens) {
      if (token === "e") length += DHLEN;
      else if (token === "s") length += DHLEN + (keyed ? TAGLEN : 0);
      else keyed = true;
    }
    length += payload.length + (keyed ? TAGLEN : 0);
    if (length > NOISE_MAX_MESSAGE) throw new RangeError(`Noise: a handshake message may not exceed ${NOISE_MAX_MESSAGE} bytes`);

    return this.#step((step) => {
      const parts: Buffer[] = [];
      for (const token of tokens) {
        if (token === "e") {
          step.e ??= generateNoiseKeyPair();
          parts.push(Buffer.from(step.e.publicKey));
          step.symmetric.mixHash(step.e.publicKey);
        } else if (token === "s") {
          parts.push(step.symmetric.encryptAndHash(this.#s.publicKey));
        } else {
          this.#mixDh(step, token);
        }
      }
      parts.push(step.symmetric.encryptAndHash(payload));
      return Buffer.concat(parts);
    });
  }

  readMessage(message: Buffer): Buffer {
    const tokens = this.#nextTokens("read");
    return this.#step((step) => {
      if (message.length > NOISE_MAX_MESSAGE) throw new RangeError(`Noise: a handshake message may not exceed ${NOISE_MAX_MESSAGE} bytes`);
      let offset = 0;
      const take = (length: number): Buffer => {
        if (message.length - offset < length) throw new Error("Noise: handshake message is truncated");
        const bytes = message.subarray(offset, offset + length);
        offset += length;
        return bytes;
      };
      for (const token of tokens) {
        if (token === "e") {
          step.re = Buffer.from(take(DHLEN));
          step.symmetric.mixHash(step.re);
        } else if (token === "s") {
          step.rs = step.symmetric.decryptAndHash(take(DHLEN + (step.symmetric.hasKey() ? TAGLEN : 0)));
        } else {
          this.#mixDh(step, token);
        }
      }
      return step.symmetric.decryptAndHash(message.subarray(offset));
    });
  }

  /** Transport cipher states oriented for this side. One call per handshake, so keys are never duplicated. */
  split(): { send: NoiseCipherState; receive: NoiseCipherState } {
    if (this.#splitTaken) throw new Error("Noise: split() was already called for this handshake");
    if (!this.complete || !this.#transportKeys) throw new Error("Noise: split() is only available after the handshake completes");
    this.#splitTaken = true;
    const [initiatorToResponder, responderToInitiator] = this.#transportKeys;
    this.#transportKeys = undefined;
    const c1 = new NoiseCipherState(initiatorToResponder);
    const c2 = new NoiseCipherState(responderToInitiator);
    return this.#initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }

  #nextTokens(direction: "write" | "read"): readonly Token[] {
    if (this.#failed) throw new Error("Noise: the handshake has failed and cannot be used");
    if (this.#messageIndex >= XX_MESSAGE_PATTERNS.length) throw new Error("Noise: the handshake is already complete");
    const initiatorTurn = this.#messageIndex % 2 === 0;
    const writing = direction === "write";
    if (initiatorTurn !== (this.#initiator === writing)) {
      throw new Error(`Noise: it is not this side's turn to ${direction} a handshake message`);
    }
    return XX_MESSAGE_PATTERNS[this.#messageIndex];
  }

  /**
   * Runs one handshake message on a copy of the state and commits it only on success. Any failure
   * (DH, decryption, malformed input) leaves the last good state visible and marks the handshake
   * failed, as section 5 requires ("the handshake has failed and the HandshakeState is deleted").
   */
  #step(run: (step: StepState) => Buffer): Buffer {
    const step: StepState = { ...this.#state, symmetric: this.#state.symmetric.clone() };
    let result: Buffer;
    try {
      result = run(step);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    this.#state = step;
    this.#messageIndex += 1;
    if (this.#messageIndex === XX_MESSAGE_PATTERNS.length) {
      this.#transportKeys = step.symmetric.split();
      this.#handshakeHash = step.symmetric.handshakeHash;
    }
    return result;
  }

  #mixDh(step: StepState, token: "ee" | "es" | "se"): void {
    let local: NoiseKeyPair | undefined;
    let remote: Buffer | undefined;
    if (token === "ee") [local, remote] = [step.e, step.re];
    else if (token === "es") [local, remote] = this.#initiator ? [step.e, step.rs] : [this.#s, step.re];
    else [local, remote] = this.#initiator ? [this.#s, step.re] : [step.e, step.rs];
    if (!local || !remote) throw new Error(`Noise: missing key for the ${token} token`);
    step.symmetric.mixKey(dh(local, remote));
  }
}
