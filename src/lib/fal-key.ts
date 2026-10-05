import { settings } from './config';

// Keys are read from the environment only, so nothing secret is ever written to disk by the app.
export async function falKey() {
  return settings().falKey;
}
export async function higgsfieldKey() {
  return settings().higgsfieldKey;
}
export async function openrouterKey() {
  return settings().openrouterKey;
}
export async function replicateKey() {
  return settings().replicateKey;
}
