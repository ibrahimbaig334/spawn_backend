import { Inject, Injectable } from '@nestjs/common';
import { canonicalIpfsUri } from '../../../common/validation/ipfs-uri';
import { APP_ENVIRONMENT } from '../../../config/config.constants';
import type { Environment } from '../../../config/environment';

const PINATA_PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

export interface PinnedObject {
  cid: string;
  ipfsUri: string;
  gatewayUrl: string;
}

/**
 * Minimal Pinata client over fetch (no SDK dependency).
 *
 * All pinning happens server-side so the JWT never reaches the browser.
 * Returned CIDs are canonicalized to CIDv1 `ipfs://` URIs, matching the
 * backend's ipfs-only validation (see common/validation/ipfs-uri).
 */
@Injectable()
export class PinataService {
  constructor(@Inject(APP_ENVIRONMENT) private readonly environment: Environment) {}

  private get jwt(): string {
    const jwt = this.environment.PINATA_JWT;
    if (!jwt) {
      throw new Error('PINATA_JWT is required');
    }
    return jwt;
  }

  private gateway(): string {
    const configured = this.environment.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs';
    return configured.replace(/\/+$/, '');
  }

  async pinJson(name: string, value: unknown): Promise<PinnedObject> {
    const response = await fetch(PINATA_PIN_JSON_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pinataContent: value, pinataMetadata: { name } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Pinata pinJSON failed: ${await this.errorDetail(response)}`);
    }
    const body = (await response.json()) as { IpfsHash?: unknown };
    if (typeof body.IpfsHash !== 'string' || !body.IpfsHash) {
      throw new Error('Pinata did not return an IpfsHash');
    }
    return this.describe(body.IpfsHash);
  }

  async pinFile(filename: string, contentType: string, bytes: Uint8Array): Promise<PinnedObject> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: contentType }), filename);
    form.append('pinataMetadata', JSON.stringify({ name: filename }));
    const response = await fetch(PINATA_PIN_FILE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`Pinata pinFile failed: ${await this.errorDetail(response)}`);
    }
    const body = (await response.json()) as { IpfsHash?: unknown };
    if (typeof body.IpfsHash !== 'string' || !body.IpfsHash) {
      throw new Error('Pinata did not return an IpfsHash');
    }
    return this.describe(body.IpfsHash);
  }

  private describe(cid: string): PinnedObject {
    const ipfsUri = canonicalIpfsUri(`ipfs://${cid}`);
    return { cid, ipfsUri, gatewayUrl: `${this.gateway()}/${ipfsUri.slice('ipfs://'.length)}` };
  }

  private async errorDetail(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return `HTTP ${response.status} ${text.slice(0, 300)}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}
