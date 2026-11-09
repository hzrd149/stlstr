import { createIdentityService } from '@kehto/services';
import { createIdentityOptions, type KehtoContext } from 'applesauce-extra/kehto';

/** Applesauce reads with empty results for the anonymous identity (never cast an empty key). */
export function createStlstrIdentityService(context: KehtoContext) {
  const options = createIdentityOptions(context);
  return createIdentityService({
    ...options,
    getProfile: (pubkey, message) => (pubkey ? options.getProfile!(pubkey, message) : null),
    getFollows: (pubkey, message) => (pubkey ? options.getFollows!(pubkey, message) : []),
    getMutes: (pubkey, message) => (pubkey ? options.getMutes!(pubkey, message) : []),
    getList: (type, pubkey, message) => (pubkey ? options.getList!(type, pubkey, message) : []),
    getZaps: (pubkey, message) => (pubkey ? options.getZaps!(pubkey, message) : []),
    getBadges: (pubkey, message) => (pubkey ? options.getBadges!(pubkey, message) : []),
  });
}
