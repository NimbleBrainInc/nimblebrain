import { Mpak } from "@nimblebrain/mpak-sdk";

let _mpak: Mpak | undefined;

export function getMpak(mpakHome: string): Mpak {
  if (!_mpak || _mpak.configManager.mpakHome !== mpakHome) {
    _mpak = new Mpak({ mpakHome });
  }
  return _mpak;
}
