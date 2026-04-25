import { randomUUID } from 'node:crypto';

export const testProjectId = (prefix = 'test-proj') => `${prefix}-${randomUUID()}`;
export const testJobId = (prefix = 'test-job') => `${prefix}-${randomUUID()}`;
export const testAssetKey = (kind: string, ext: string) => `${kind}/${randomUUID()}.${ext}`;
