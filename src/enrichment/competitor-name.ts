/**
 * Sekundær navnekilde når Icecat ikke har et treff (eller ikke har et
 * meningsfullt navn, se normalize.ts sin isMeaningfulModelName): spør de
 * samme tre konkurrent-kildene prisings-motoren allerede bruker
 * (src/fetchers/power.ts/komplett.ts/dustin.ts), i rekkefølge Power (EAN) →
 * Komplett (MPN) → Dustin (MPN).
 *
 * Disse gir et EKTE navn en norsk nettbutikk selv bruker for akkurat denne
 * EAN-en/MPN-en — ikke gjetting, bare en tredje kilde å spørre før vi gir
 * opp. De gir kun et navn, ingen strukturerte specs (i motsetning til
 * Icecat) — specs forblir tomt/uendret når navnet kommer herfra.
 *
 * Returnerer null hvis ingen av de tre fører produktet, eller ved
 * forbigående feil — alle tre fetcherne fanger sine egne feil og returnerer
 * null, kaster aldri, så denne funksjonen kaster heller aldri.
 */

import { fetchPowerByEAN } from '../fetchers/power.ts';
import { fetchKomplettByMPN } from '../fetchers/komplett.ts';
import { fetchDustinByMPN } from '../fetchers/dustin.ts';

export type CompetitorNameSource = 'power' | 'komplett' | 'dustin';

export interface CompetitorNameResult {
  name: string;
  source: CompetitorNameSource;
  // Bilde-URL hos kilden, hvis den fantes — alle tre gir dette i praksis (se
  // filkommentarer i power.ts/komplett.ts/dustin.ts for hvordan hver trekker
  // det ut). Kun brukt når produktet mangler bilde helt fra før (Icecat har
  // ingen bildedata i dette repoet uansett).
  imageUrl?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function lookupCompetitorName(input: {
  ean?: string | null;
  mpn: string;
}): Promise<CompetitorNameResult | null> {
  // Navnet tas fra første kilde som har det (Power → Komplett → Dustin). Mangler
  // den kilden bilde, spørres de neste kun for bildets skyld (2026-11-17: nye
  // MacBook Pro M6/iMac M6 hadde navn hos Power, men bilde kun hos Komplett og
  // Dustin, og ble stående uten bilde fordi oppslaget stoppet ved Power).
  //
  // Komplett-bilder er siste utvei: price-sync laster bildet ned fra serveren,
  // og Komplett sin bot-beskyttelse avviste det (bekreftet 2026-11-17: 3 av 3
  // Komplett-bilder ble ikke lagret, 2 av 2 fra Dustin ble det). Har vi bare et
  // Komplett-bilde, spørres Dustin også, og Dustin sitt bilde foretrekkes.
  let result: CompetitorNameResult | null = null;
  let imageFromKomplett = false;
  const consider = (name: string | undefined, source: CompetitorNameSource, imageUrl: string | undefined) => {
    if (!result && name) {
      result = { name, source, ...(imageUrl ? { imageUrl } : {}) };
      imageFromKomplett = Boolean(imageUrl) && source === 'komplett';
    } else if (result && imageUrl && (!result.imageUrl || (imageFromKomplett && source !== 'komplett'))) {
      result.imageUrl = imageUrl;
      imageFromKomplett = source === 'komplett';
    }
  };
  const done = () => Boolean(result?.imageUrl) && !imageFromKomplett;

  if (input.ean) {
    const power = await fetchPowerByEAN(input.ean);
    consider(power?.name, 'power', power?.image_url);
    if (done()) return result;
    await sleep(500); // Samme høflighetspause som Power sin egen batch-henting.
  }

  const komplett = await fetchKomplettByMPN(input.mpn, input.ean);
  consider(komplett?.name, 'komplett', komplett?.image_url);
  if (done()) return result;
  await sleep(800); // Samme pause som Komplett/Dustin sine egne batch-hentinger.

  const dustin = await fetchDustinByMPN(input.mpn);
  consider(dustin?.name, 'dustin', dustin?.image_url);

  return result;
}
