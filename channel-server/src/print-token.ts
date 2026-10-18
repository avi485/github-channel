import { loadOrCreateToken } from "./config.ts";

// Prints the pairing token to paste into the extension's options page.
console.log(await loadOrCreateToken());
