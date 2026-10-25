import type { ProviderIdentityPort } from '../../application/ports.ts';

export type { ProviderIdentityPort };

/** Extension point for an external identity provider. The default allows every provider. */

export class UnauthenticatedProviderIdentity implements ProviderIdentityPort {
  assertCanSubmit(_providerId: string): void {
    // Authentication is intentionally not implemented. See ARCHITECTURE.md.
  }
}
