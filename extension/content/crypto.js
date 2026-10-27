(() => {
  'use strict';
  const C = globalThis.Cwtch;

  class RoomCrypto {
    constructor(secret, roomId) {
      this.secret = secret;
      this.roomId = roomId;
      this.keyPromise = null;
    }

    async key() {
      if (!this.keyPromise) {
        const raw = C.utils.base64UrlToBytes(this.secret);
        if (raw.byteLength !== 32) throw new Error('Room secret must contain 32 bytes.');
        this.keyPromise = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
          'encrypt',
          'decrypt',
        ]);
      }
      return this.keyPromise;
    }

    async auth() {
      const bytes = C.utils.encoder.encode(`cwtch-room-auth-v2:${this.roomId}:${this.secret}`);
      return C.utils.bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    }

    async encrypt(value, envelope) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = C.utils.encoder.encode(JSON.stringify(value));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: C.utils.encoder.encode(CwtchProtocol.aad(envelope)),
        },
        await this.key(),
        plaintext,
      );
      return {
        iv: C.utils.bytesToBase64Url(iv),
        ciphertext: C.utils.bytesToBase64Url(new Uint8Array(ciphertext)),
      };
    }

    async decrypt(envelope, metadata) {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: C.utils.base64UrlToBytes(envelope.iv),
          additionalData: C.utils.encoder.encode(CwtchProtocol.aad(metadata)),
        },
        await this.key(),
        C.utils.base64UrlToBytes(envelope.ciphertext),
      );
      return JSON.parse(C.utils.decoder.decode(plaintext));
    }
  }

  C.RoomCrypto = RoomCrypto;
})();
