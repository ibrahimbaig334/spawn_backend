import { createCipheriv, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

export interface EncryptedDeploymentSigner {
  signerAddress: `0x${string}`;
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class DeploymentSignerCustody {
  constructor(
    private readonly encryptionKey: Buffer,
    private readonly keyId: string,
  ) {}

  generate(tokenId: string): EncryptedDeploymentSigner {
    let privateKey: Buffer | undefined;
    try {
      privateKey = this.generateScalar();
      const account = privateKeyToAccount(`0x${privateKey.toString('hex')}`);
      const signerAddress = account.address.toLowerCase() as `0x${string}`;
      const iv = randomBytes(12);
      const aad = this.aad(tokenId, signerAddress);
      const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv, {
        authTagLength: 16,
      });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
      const authTag = cipher.getAuthTag();
      aad.fill(0);

      return {
        signerAddress,
        version: 1,
        algorithm: 'aes-256-gcm',
        keyId: this.keyId,
        iv,
        ciphertext,
        authTag,
      };
    } finally {
      privateKey?.fill(0);
    }
  }

  private generateScalar(): Buffer {
    while (true) {
      const candidate = randomBytes(32);
      try {
        privateKeyToAccount(`0x${candidate.toString('hex')}`);
        return candidate;
      } catch {
        candidate.fill(0);
      }
    }
  }

  private aad(tokenId: string, signerAddress: string): Buffer {
    const fields = ['1', tokenId, signerAddress, 'aes-256-gcm', this.keyId];
    const parts = fields.map((field) => {
      const value = Buffer.from(field, 'utf8');
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(value.length);
      return Buffer.concat([length, value]);
    });
    return Buffer.concat(parts);
  }
}
