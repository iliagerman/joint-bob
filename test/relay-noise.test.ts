// Noise_XX_25519_ChaChaPoly_SHA256 checked byte for byte against the published test vectors,
// plus round trips, tampering, turn order and size limits.
import assert from "node:assert/strict";
import test from "node:test";
import {
  NOISE_MAX_MESSAGE,
  NOISE_PROTOCOL_NAME,
  NoiseCipherState,
  NoiseHandshake,
  generateNoiseKeyPair,
  noiseDecrypt,
  noiseEncrypt,
  noiseKeyPairFromPrivateKey,
} from "../src/relay/noise.js";

interface NoiseVector {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static: string;
  init_ephemeral: string;
  resp_prologue: string;
  resp_psks?: string[];
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

// Every entry with protocol_name exactly "Noise_XX_25519_ChaChaPoly_SHA256", copied verbatim from
// https://raw.githubusercontent.com/haskell-cryptography/cacophony/master/vectors/cacophony.txt
const CACOPHONY_XX_VECTORS: NoiseVector[] = [
  {
    "protocol_name": "Noise_XX_25519_ChaChaPoly_SHA256",
    "init_prologue": "4a6f686e2047616c74",
    "init_static": "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
    "init_ephemeral": "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    "resp_prologue": "4a6f686e2047616c74",
    "resp_static": "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    "resp_ephemeral": "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    "handshake_hash": "c8e5f64e846193be2a834104c2a009868d6c9f3bd3c186299888b488b2f1f58e",
    "messages": [
      {
        "payload": "4c756477696720766f6e204d69736573",
        "ciphertext": "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573"
      },
      {
        "payload": "4d757272617920526f746862617264",
        "ciphertext": "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884381cbad1f276e038c48378ffce2b65285e08d6b68aaa3629a5a8639392490e5b9bd5269c2f1e4f488ed8831161f19b7815528f8982ffe09be9b5c412f8a0db50f8814c7194e83f23dbd8d162c9326ad"
      },
      {
        "payload": "462e20412e20486179656b",
        "ciphertext": "c7195ffacac1307ff99046f219750fc47693e23c3cb08b89c2af808b444850a80ae475b9df0f169ae80a89be0865b57f58c9fea0d4ec82a286427402f113e4b6ae769a1d95941d49b25030"
      },
      {
        "payload": "4361726c204d656e676572",
        "ciphertext": "96763ed773f8e47bb3712f0e29b3060ffc956ffc146cee53d5e1df"
      },
      {
        "payload": "4a65616e2d426170746973746520536179",
        "ciphertext": "3e40f15f6f3a46ae446b253bf8b1d9ffb6ed9b174d272328ff91a7e2e5c79c07f5"
      },
      {
        "payload": "457567656e2042f6686d20766f6e2042617765726b",
        "ciphertext": "eb3f3515110702e047a6c9da4478b6ead94873c11c0f2d710ddb3f09fce024b3a58502ae3f"
      }
    ]
  }
];

// Same selection, copied verbatim from https://raw.githubusercontent.com/mcginty/snow/main/tests/vectors/snow.txt
// (empty psk lists: this is the plain XX pattern, not a psk variant).
const SNOW_XX_VECTORS: NoiseVector[] = [
  {
    "protocol_name": "Noise_XX_25519_ChaChaPoly_SHA256",
    "init_prologue": "5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e",
    "init_psks": [],
    "init_static": "7dec208517a3b81a2861d7a71266d5d6dc944c5a8816634a86fe63198a0148ee",
    "init_ephemeral": "a32daf21e93c0131495ce1d903181fde81cc46937daaeb990bae7c992709421e",
    "resp_prologue": "5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e",
    "resp_psks": [],
    "resp_static": "4d0aed5098e3b4ef20357e9f686ce66204c792b358da2e475017d6c485304881",
    "resp_ephemeral": "4eece0f195d026db035ff987597c429d3ad3bcc2944df37d649528951b2a27c5",
    "messages": [
      {
        "payload": "d03c489139e645d0711a3c9e810d776b46a84912463fafa87b884eebf242dc34",
        "ciphertext": "f9fa868ba97ab8a2686deccfaad5a484ee10a5bb85e3d1dce015a84797f92818d03c489139e645d0711a3c9e810d776b46a84912463fafa87b884eebf242dc34"
      },
      {
        "payload": "d8190a92f7dc0c93dbea9118ba8055751fb7c6590c416ffbd419964132b99a85",
        "ciphertext": "8c4e6fdb7d09d501a86f7eca5c234522751706ed409182c05cdf5f827d4dae47b81c6c5f43b025692c24391eefee725c17d8cb0fbe3e4abb8aedf42c4fd2592d4ea48ac08989d6ae8b4adae08b2c34087c808c7aa55a63c02b0fab9e930612336bd43eaea04d3c670a0a146691aa9cc9d357872320dc735dbc48580cffb553db"
      },
      {
        "payload": "77891b19dcb92ef7c055b672c4a5aa7fdf1c84146b8b303459022729473ce254",
        "ciphertext": "933ca6b5ed60df3df66121f0ab49a09e49efa45c613a86a3cecbf4c535cef2f83f72b42837b18e3572f2fdc2b74c331e2368a545cef54bdca081678ab0e9dd5348122459e0c034c851984d88ce610963d43cde6cfe73a67fbd5a63e8bfca96d0"
      },
      {
        "payload": "d7efdf988072881941db045a42882433817555128fbf5663e56081712ec7d212",
        "ciphertext": "54ef0ff0629e1aaa7685a2806ab111cba76b52331f2642276736f415868eacb69ab2577f3bda0cbf72f879685f6ed25f"
      },
      {
        "payload": "dd7bf01a588bafb52c6cfba952e5d8fe35cc2b3f92b4730ae2474615157345ce",
        "ciphertext": "356be70f110306d5c699bb834bb9d58d909e325924dfbec972e406e6f294dc63e1daebefe8a62a334facc8048ab4ad66"
      }
    ]
  }
];

const HANDSHAKE_MESSAGES = 3;
const hex = (value: string) => Buffer.from(value, "hex");

function completeHandshake(prologue?: Buffer) {
  const initiatorKeys = generateNoiseKeyPair();
  const responderKeys = generateNoiseKeyPair();
  const initiator = new NoiseHandshake({ initiator: true, prologue, staticKeyPair: initiatorKeys });
  const responder = new NoiseHandshake({ initiator: false, prologue, staticKeyPair: responderKeys });
  responder.readMessage(initiator.writeMessage());
  initiator.readMessage(responder.writeMessage());
  responder.readMessage(initiator.writeMessage());
  return { initiator, responder, initiatorKeys, responderKeys };
}

function flipByte(message: Buffer, index: number): Buffer {
  const copy = Buffer.from(message);
  copy[index] ^= 0x01;
  return copy;
}

for (const [source, vectors] of [["cacophony", CACOPHONY_XX_VECTORS], ["snow", SNOW_XX_VECTORS]] as const) {
  vectors.forEach((vector, index) => {
    test(`${source} vector ${index + 1}: ${vector.protocol_name} matches byte for byte`, () => {
      assert.equal(vector.protocol_name, NOISE_PROTOCOL_NAME);
      assert.ok(!vector.init_psks?.length && !vector.resp_psks?.length, "psk vectors are out of scope");
      const initiator = new NoiseHandshake({
        initiator: true,
        prologue: hex(vector.init_prologue),
        staticKeyPair: noiseKeyPairFromPrivateKey(hex(vector.init_static)),
        ephemeralKeyPair: noiseKeyPairFromPrivateKey(hex(vector.init_ephemeral)),
      });
      const responder = new NoiseHandshake({
        initiator: false,
        prologue: hex(vector.resp_prologue),
        staticKeyPair: noiseKeyPairFromPrivateKey(hex(vector.resp_static)),
        ephemeralKeyPair: noiseKeyPairFromPrivateKey(hex(vector.resp_ephemeral)),
      });
      assert.ok(vector.messages.length > HANDSHAKE_MESSAGES, "vector should include transport messages");

      // Vector convention for interactive patterns: messages alternate, starting with the initiator,
      // through the handshake and on into transport messages (even index = initiator sends).
      for (let i = 0; i < HANDSHAKE_MESSAGES; i += 1) {
        const { payload, ciphertext } = vector.messages[i];
        const [sender, receiver] = i % 2 === 0 ? [initiator, responder] : [responder, initiator];
        const written = sender.writeMessage(hex(payload));
        assert.equal(written.toString("hex"), ciphertext, `handshake message ${i}`);
        assert.equal(receiver.readMessage(written).toString("hex"), payload, `handshake payload ${i}`);
      }

      assert.ok(initiator.complete && responder.complete);
      assert.deepEqual(initiator.handshakeHash, responder.handshakeHash);
      if (vector.handshake_hash) assert.equal(initiator.handshakeHash.toString("hex"), vector.handshake_hash);
      assert.deepEqual(initiator.remoteStaticKey, noiseKeyPairFromPrivateKey(hex(vector.resp_static)).publicKey);
      assert.deepEqual(responder.remoteStaticKey, noiseKeyPairFromPrivateKey(hex(vector.init_static)).publicKey);

      const initiatorTransport = initiator.split();
      const responderTransport = responder.split();
      for (let i = HANDSHAKE_MESSAGES; i < vector.messages.length; i += 1) {
        const { payload, ciphertext } = vector.messages[i];
        const [send, receive] = i % 2 === 0
          ? [initiatorTransport.send, responderTransport.receive]
          : [responderTransport.send, initiatorTransport.receive];
        const written = noiseEncrypt(send, hex(payload));
        assert.equal(written.toString("hex"), ciphertext, `transport message ${i}`);
        assert.equal(noiseDecrypt(receive, written).toString("hex"), payload, `transport payload ${i}`);
      }
    });
  });
}

test("handshake with random keys authenticates both statics and agrees on the hash", () => {
  const prologue = Buffer.from("joint-bob-relay test prologue");
  const initiatorKeys = generateNoiseKeyPair();
  const responderKeys = generateNoiseKeyPair();
  assert.equal(initiatorKeys.publicKey.length, 32);
  assert.equal(initiatorKeys.privateKey.length, 32);
  assert.deepEqual(noiseKeyPairFromPrivateKey(initiatorKeys.privateKey), initiatorKeys);
  const initiator = new NoiseHandshake({ initiator: true, prologue, staticKeyPair: initiatorKeys });
  const responder = new NoiseHandshake({ initiator: false, prologue, staticKeyPair: responderKeys });

  assert.equal(responder.readMessage(initiator.writeMessage(Buffer.from("hello"))).toString(), "hello");
  assert.equal(initiator.remoteStaticKey, undefined);
  assert.equal(initiator.readMessage(responder.writeMessage(Buffer.from("responder id"))).toString(), "responder id");
  assert.deepEqual(initiator.remoteStaticKey, responderKeys.publicKey);
  assert.equal(responder.remoteStaticKey, undefined);
  assert.equal(initiator.complete, false);
  assert.equal(responder.readMessage(initiator.writeMessage(Buffer.from("initiator id"))).toString(), "initiator id");
  assert.deepEqual(responder.remoteStaticKey, initiatorKeys.publicKey);

  assert.ok(initiator.complete && responder.complete);
  assert.equal(initiator.handshakeHash.length, 32);
  assert.deepEqual(initiator.handshakeHash, responder.handshakeHash);

  const a = initiator.split();
  const b = responder.split();
  for (let i = 0; i < 5; i += 1) {
    const ping = Buffer.from(`ping ${i}`);
    assert.deepEqual(noiseDecrypt(b.receive, noiseEncrypt(a.send, ping)), ping);
    const pong = Buffer.from(`pong ${i}`);
    assert.deepEqual(noiseDecrypt(a.receive, noiseEncrypt(b.send, pong)), pong);
  }
  assert.deepEqual(noiseDecrypt(b.receive, noiseEncrypt(a.send, Buffer.alloc(0))), Buffer.alloc(0));
  assert.throws(() => initiator.split(), /already called/);
});

test("mismatched prologues fail the handshake", () => {
  const initiator = new NoiseHandshake({ initiator: true, prologue: Buffer.from("a"), staticKeyPair: generateNoiseKeyPair() });
  const responder = new NoiseHandshake({ initiator: false, prologue: Buffer.from("b"), staticKeyPair: generateNoiseKeyPair() });
  responder.readMessage(initiator.writeMessage());
  assert.throws(() => initiator.readMessage(responder.writeMessage()), /decryption failed/);
});

test("a tampered handshake message throws and fails the handshake without exposing its contents", () => {
  // Fixed initiator keys give identical replicas, so each tampered copy meets an otherwise valid state.
  const initiatorOptions = { initiator: true, staticKeyPair: generateNoiseKeyPair(), ephemeralKeyPair: generateNoiseKeyPair() };
  const replica = () => {
    const handshake = new NoiseHandshake(initiatorOptions);
    return { handshake, first: handshake.writeMessage() };
  };
  const responder = new NoiseHandshake({ initiator: false, staticKeyPair: generateNoiseKeyPair() });
  responder.readMessage(replica().first);
  const second = responder.writeMessage(Buffer.from("payload"));
  // Byte 0 is in the responder's ephemeral key, byte 32 in the encrypted static key, the last byte in the payload tag.
  for (const index of [0, 32, second.length - 1]) {
    const { handshake } = replica();
    assert.throws(() => handshake.readMessage(flipByte(second, index)), /decryption failed/, `tampered byte ${index}`);
    // Section 5: a DECRYPT failure ends the handshake; nothing from the bad message is committed.
    assert.equal(handshake.remoteStaticKey, undefined);
    assert.equal(handshake.complete, false);
    assert.throws(() => handshake.readMessage(second), /handshake has failed/);
    assert.throws(() => handshake.writeMessage(), /handshake has failed/);
    assert.throws(() => handshake.handshakeHash, /only available after/);
  }
  assert.equal(replica().handshake.readMessage(second).toString(), "payload", "the untampered message is valid");

  // Tampering with the third message is caught by the responder.
  const fresh = (() => {
    const i = new NoiseHandshake({ initiator: true, staticKeyPair: generateNoiseKeyPair() });
    const r = new NoiseHandshake({ initiator: false, staticKeyPair: generateNoiseKeyPair() });
    r.readMessage(i.writeMessage());
    i.readMessage(r.writeMessage());
    return { i, r, third: i.writeMessage(Buffer.from("x")) };
  })();
  assert.throws(() => fresh.r.readMessage(flipByte(fresh.third, 5)), /decryption failed/);
  assert.equal(fresh.r.remoteStaticKey, undefined);
  assert.equal(fresh.r.complete, false);

  // Truncated messages are rejected too.
  const short = new NoiseHandshake({ initiator: false, staticKeyPair: generateNoiseKeyPair() });
  assert.throws(() => short.readMessage(Buffer.alloc(31)), /truncated/);
});

test("a tampered transport message throws and leaves the cipher state unchanged", () => {
  const { initiator, responder } = completeHandshake();
  const a = initiator.split();
  const b = responder.split();
  const first = noiseEncrypt(a.send, Buffer.from("first"));
  const second = noiseEncrypt(a.send, Buffer.from("second"));

  for (const index of [0, first.length - 1]) {
    assert.throws(() => noiseDecrypt(b.receive, flipByte(first, index)), /decryption failed/);
  }
  assert.throws(() => noiseDecrypt(b.receive, first.subarray(0, 15)), /shorter than the authentication tag/);
  assert.throws(() => noiseDecrypt(b.receive, second), /decryption failed/, "out-of-order message uses the wrong nonce");
  // No nonce was consumed by the failures, so the genuine stream still decrypts in order.
  assert.equal(noiseDecrypt(b.receive, first).toString(), "first");
  assert.equal(noiseDecrypt(b.receive, second).toString(), "second");
  assert.throws(() => noiseDecrypt(b.receive, first), /decryption failed/, "replays are rejected");
  assert.equal(noiseDecrypt(a.receive, noiseEncrypt(b.send, Buffer.from("reply"))).toString(), "reply");
});

test("cipher state follows the spec for keyless pass-through, associated data and the reserved nonce", () => {
  const keyless = new NoiseCipherState();
  assert.equal(keyless.hasKey(), false);
  assert.deepEqual(keyless.encryptWithAd(Buffer.from("ad"), Buffer.from("plain")), Buffer.from("plain"));
  assert.deepEqual(keyless.decryptWithAd(Buffer.from("ad"), Buffer.from("plain")), Buffer.from("plain"));
  assert.throws(() => noiseEncrypt(keyless, Buffer.from("x")), /no key/);
  assert.throws(() => noiseDecrypt(keyless, Buffer.alloc(16)), /no key/);

  const key = Buffer.alloc(32, 7);
  const sender = new NoiseCipherState(key);
  const receiver = new NoiseCipherState(key);
  const sealed = sender.encryptWithAd(Buffer.from("ad"), Buffer.from("body"));
  assert.equal(sealed.length, 4 + 16);
  assert.throws(() => receiver.decryptWithAd(Buffer.from("other ad"), sealed), /decryption failed/);
  assert.equal(receiver.decryptWithAd(Buffer.from("ad"), sealed).toString(), "body");

  // n = 2^64-2 is the last usable nonce; once n reaches 2^64-1 every call throws.
  const last = 2n ** 64n - 2n;
  const nearEndSender = new NoiseCipherState(key, last);
  const nearEndReceiver = new NoiseCipherState(key, last);
  const final = nearEndSender.encryptWithAd(Buffer.alloc(0), Buffer.from("last"));
  assert.equal(nearEndReceiver.decryptWithAd(Buffer.alloc(0), final).toString(), "last");
  assert.throws(() => nearEndSender.encryptWithAd(Buffer.alloc(0), Buffer.from("more")), /nonce space exhausted/);
  assert.throws(() => nearEndReceiver.decryptWithAd(Buffer.alloc(0), final), /nonce space exhausted/);
  assert.throws(() => new NoiseCipherState(Buffer.alloc(31)), /32 bytes/);
});

test("out-of-turn handshake calls and early split throw", () => {
  const initiator = new NoiseHandshake({ initiator: true, staticKeyPair: generateNoiseKeyPair() });
  const responder = new NoiseHandshake({ initiator: false, staticKeyPair: generateNoiseKeyPair() });
  assert.throws(() => responder.writeMessage(), /not this side's turn to write/);
  assert.throws(() => initiator.readMessage(Buffer.alloc(32)), /not this side's turn to read/);
  assert.throws(() => initiator.split(), /only available after/);
  assert.throws(() => initiator.handshakeHash, /only available after/);

  const first = initiator.writeMessage();
  assert.throws(() => initiator.writeMessage(), /not this side's turn to write/);
  responder.readMessage(first);
  assert.throws(() => responder.readMessage(first), /not this side's turn to read/);
  initiator.readMessage(responder.writeMessage());
  assert.throws(() => responder.split(), /only available after/);
  responder.readMessage(initiator.writeMessage());

  assert.ok(initiator.complete && responder.complete);
  assert.throws(() => initiator.writeMessage(), /already complete/);
  assert.throws(() => responder.readMessage(Buffer.alloc(64)), /already complete/);
});

test("oversize handshake and transport messages throw", () => {
  const initiator = new NoiseHandshake({ initiator: true, staticKeyPair: generateNoiseKeyPair() });
  const responder = new NoiseHandshake({ initiator: false, staticKeyPair: generateNoiseKeyPair() });
  // Message 1 is a 32-byte ephemeral key plus an unencrypted payload.
  assert.throws(() => initiator.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - 32 + 1)), RangeError);
  // An oversize payload is a caller error, rejected before any state changes.
  const first = initiator.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - 32));
  assert.equal(first.length, NOISE_MAX_MESSAGE);
  responder.readMessage(first);
  // Message 2: e (32) + encrypted s (48) + payload tag (16).
  assert.throws(() => responder.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - 96 + 1)), RangeError);
  assert.equal(responder.writeMessage(Buffer.alloc(NOISE_MAX_MESSAGE - 96)).length, NOISE_MAX_MESSAGE);

  const reader = new NoiseHandshake({ initiator: false, staticKeyPair: generateNoiseKeyPair() });
  assert.throws(() => reader.readMessage(Buffer.alloc(NOISE_MAX_MESSAGE + 1)), RangeError);

  const { initiator: done, responder: peer } = completeHandshake();
  const a = done.split();
  const b = peer.split();
  assert.throws(() => noiseEncrypt(a.send, Buffer.alloc(NOISE_MAX_MESSAGE - 16 + 1)), RangeError);
  assert.throws(() => noiseDecrypt(b.receive, Buffer.alloc(NOISE_MAX_MESSAGE + 1)), RangeError);
  assert.throws(() => a.send.encryptWithAd(Buffer.alloc(0), Buffer.alloc(NOISE_MAX_MESSAGE - 16 + 1)), RangeError);
  const largest = noiseEncrypt(a.send, Buffer.alloc(NOISE_MAX_MESSAGE - 16, 1));
  assert.equal(largest.length, NOISE_MAX_MESSAGE);
  assert.deepEqual(noiseDecrypt(b.receive, largest), Buffer.alloc(NOISE_MAX_MESSAGE - 16, 1));
});

test("key pairs are validated and keys stay out of inspection output", async () => {
  const pair = generateNoiseKeyPair();
  const other = generateNoiseKeyPair();
  assert.throws(() => new NoiseHandshake({ initiator: true, staticKeyPair: { publicKey: other.publicKey, privateKey: pair.privateKey } }), /does not match/);
  assert.throws(() => new NoiseHandshake({ initiator: true, staticKeyPair: { publicKey: pair.publicKey.subarray(1), privateKey: pair.privateKey } }), /32-byte/);

  const { inspect } = await import("node:util");
  const { initiator } = completeHandshake();
  const { send } = initiator.split();
  for (const value of [initiator, send]) {
    const shown = inspect(value, { depth: 10, showHidden: true });
    assert.ok(!shown.includes(pair.privateKey.toString("hex")));
    assert.ok(!/[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}/.test(shown), `no raw buffer bytes in ${shown}`);
  }
});
