import { CID } from 'multiformats/cid';

export function canonicalIpfsUri(value: string): string {
  if (!value.startsWith('ipfs://')) throw new Error('URI must use ipfs://');
  if (/[?#]/u.test(value)) throw new Error('IPFS URI cannot contain query or fragment');

  const remainder = value.slice('ipfs://'.length);
  if (!remainder || remainder.includes('@')) throw new Error('Invalid IPFS URI');
  const [cidText, ...pathParts] = remainder.split('/');
  if (!cidText) throw new Error('IPFS URI must contain a CID');

  const cid = CID.parse(cidText).toV1().toString();
  const path = pathParts.map((part) => encodeURIComponent(decodeURIComponent(part))).join('/');
  return path ? `ipfs://${cid}/${path}` : `ipfs://${cid}`;
}
