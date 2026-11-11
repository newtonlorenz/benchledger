import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { CredentialStore } from "./connection";
import { PairLinkMemory } from "./pair-memory";

const key = "benchledger.connection.v1";
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const credentialStore: CredentialStore = {
  get: () => SecureStore.getItemAsync(key, options),
  set: (value) => SecureStore.setItemAsync(key, value, options),
  remove: () => SecureStore.deleteItemAsync(key, options)
};

/** Hash of the last consumed pairing link; never the token-bearing link itself. */
const consumedPairKey = "benchledger.consumed-pair.v1";
export const pairLinkMemory = new PairLinkMemory({
  get: () => SecureStore.getItemAsync(consumedPairKey, options),
  set: (value) => SecureStore.setItemAsync(consumedPairKey, value, options)
}, (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value));
