/**
 * Oppdagelse av nye produkter hos TD Synnex.
 *
 * Den daglige synken henter kun MPN-er som allerede finnes i `products`, så
 * nye modeller (f.eks. en ny MacBook-generasjon) kommer aldri inn av seg selv.
 * Denne modulen ser ukentlig gjennom avgrensede segmenter (produsent +
 * class/subclass, se config/new-product-watch.json) og finner varer som er
 * NYE HOS TD SYNNEX siden forrige kjøring, ikke bare nye for oss. Skillet er
 * viktig: TD Synnex fører hundrevis av eldre varianter vi bevisst ikke har
 * kuratert inn, og de skal aldri dukke opp som "nye".
 *
 * Derfor huskes alt som er sett i data/seen-catalogue.json (git committed,
 * samme mønster som icecat-cachen). Første kjøring for et segment er en ren
 * registrering ("baseline") som ikke oppretter noe. Et produkt admin har
 * slettet forblir i seen-listen og kommer ikke tilbake.
 *
 * Sikringer mot en ny søppelbølge (se CLAUDE.md om mode=full):
 * - kun avgrensede segmenter, aldri et rent produsentsøk (10 000-rads-cap)
 * - CTO-koder og service/BTO/komponenter filtreres (mapProduct + isConfigToOrder)
 * - kun varer med lager eller bekreftet innkommende leveranse
 * - tak på antall nye per kjøring; over taket opprettes INGENTING
 * - opprettelse skjer alltid uten finalize, så lageret på andre varer røres ikke
 */

import type { SupplierProduct } from '../types.ts';

export interface WatchSegment {
  manufacturer: string;
  class?: string;
  subclass?: string;
  /** Valgfritt regex (case-insensitivt) produktnavnet må matche. */
  nameFilter?: string;
  /** Fri tekst for rapporten, f.eks. "Apple bærbare". */
  label?: string;
}

export interface WatchConfig {
  maxNewPerRun: number;
  segments: WatchSegment[];
}

/** mpn (store bokstaver) → dato først sett (YYYY-MM-DD), per segmentnøkkel. */
export type SeenCatalogue = Record<string, Record<string, string>>;

export function segmentKey(s: WatchSegment): string {
  return [s.manufacturer, s.class ?? '*', s.subclass ?? '*', s.nameFilter ?? ''].join('|');
}

export function segmentLabel(s: WatchSegment): string {
  return s.label ?? `${s.manufacturer} ${[s.class, s.subclass].filter(Boolean).join(':')}`.trim();
}

/**
 * Apple sine configure-to-order-koder: "_CTO"/"_NO_CTO"-suffiks hos TD Synnex,
 * og Apple sine egne Z-koder (f.eks. "Z1UL", "Z1UL0001ND"). Dette er uendelige
 * RAM/lagring/tastatur-kombinasjoner bygget på bestilling, ikke lagerførte SKU-er.
 */
export function isConfigToOrder(p: Pick<SupplierProduct, 'mpn' | 'manufacturer'>): boolean {
  if (/_cto$/i.test(p.mpn)) return true;
  const isApple = (p.manufacturer ?? '').toLowerCase().includes('apple');
  return isApple && /^Z[0-9A-Z]{3}/i.test(p.mpn) && !/\/A$/i.test(p.mpn);
}

export function isAvailable(p: Pick<SupplierProduct, 'available_qty' | 'next_delivery_date'>): boolean {
  return (p.available_qty ?? 0) > 0 || Boolean(p.next_delivery_date);
}

export interface SegmentPlan {
  key: string;
  label: string;
  baseline: boolean;
  fetched: number;
  /** Nye hos TD Synnex, klare til å opprettes. */
  toCreate: SupplierProduct[];
  /** Nye, men uten lager eller innkommende leveranse. Huskes IKKE som sett, så de plukkes opp når lageret kommer. */
  waitingForStock: SupplierProduct[];
  /** MPN-er som skal registreres som sett etter denne kjøringen. */
  markSeen: string[];
}

/**
 * Ren funksjon: avgjør hva som er nytt i ett segment. Ingen I/O.
 *
 * @param fetched  alt TD Synnex returnerte for segmentet (allerede gjennom mapProduct)
 * @param seen     tidligere sette MPN-er for segmentet (undefined = aldri kjørt før)
 * @param knownMpns MPN-er som allerede finnes i products (store bokstaver)
 */
export function planSegment(
  segment: WatchSegment,
  fetched: SupplierProduct[],
  seen: Record<string, string> | undefined,
  knownMpns: Set<string>
): SegmentPlan {
  const nameRe = segment.nameFilter ? new RegExp(segment.nameFilter, 'i') : null;
  const relevant = fetched.filter(
    p => !isConfigToOrder(p) && p.price_ex_vat != null && (!nameRe || nameRe.test(p.name))
  );

  // Samme MPN kan komme flere ganger fra API-et (paginering); behold første.
  const unique = new Map<string, SupplierProduct>();
  for (const p of relevant) {
    const k = p.mpn.toUpperCase();
    if (!unique.has(k)) unique.set(k, p);
  }

  const plan: SegmentPlan = {
    key: segmentKey(segment),
    label: segmentLabel(segment),
    baseline: seen === undefined,
    fetched: fetched.length,
    toCreate: [],
    waitingForStock: [],
    markSeen: [],
  };

  for (const [mpn, p] of unique) {
    if (seen && seen[mpn]) continue;
    if (plan.baseline || knownMpns.has(mpn)) {
      // Baseline: registrer alt som finnes i dag uten å opprette noe.
      // Allerede i products: ingenting å opprette, men husk den.
      plan.markSeen.push(mpn);
      continue;
    }
    if (isAvailable(p)) {
      plan.toCreate.push(p);
      plan.markSeen.push(mpn);
    } else {
      plan.waitingForStock.push(p);
    }
  }

  return plan;
}

export function applySeen(seen: SeenCatalogue, key: string, mpns: string[], today: string): void {
  const bucket = (seen[key] ??= {});
  for (const m of mpns) bucket[m] ??= today;
}

function fmtPrice(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n).toLocaleString('nb-NO')} kr`;
}

export interface RunSummary {
  plans: SegmentPlan[];
  created: number;
  capExceeded: boolean;
  maxNewPerRun: number;
  errors: string[];
}

/** Markdown-rapport til GitHub-issuet. Returnerer null når det ikke er noe å si fra om. */
export function buildReport(s: RunSummary): string | null {
  const toCreate = s.plans.flatMap(p => p.toCreate);
  if (toCreate.length === 0 && !s.capExceeded && s.errors.length === 0) return null;

  const lines: string[] = [];
  if (s.capExceeded) {
    lines.push(
      `⚠️ **${toCreate.length} nye produkter funnet, over taket på ${s.maxNewPerRun}. Ingenting er opprettet.**`,
      '',
      'Det kan bety at TD Synnex har endret noe i katalogen, eller at et segment er for bredt. ' +
        'Se over listen. Kjør så manuelt med `mode=new-products` og `max_new` satt høyere, ' +
        'eller legg ønskede varenumre inn med `mode=tdsynnex-add`.',
      ''
    );
  } else if (toCreate.length > 0) {
    lines.push(
      `**${s.created} nye produkter er lagt inn skjult** i shop.impero.no med pris, lager, navn og bilde.`,
      '',
      'Gå til admin, se over navn, kategori og bilde, og gjør dem synlige. Lukk dette issuet når det er gjort.',
      ''
    );
  }

  for (const plan of s.plans) {
    if (plan.toCreate.length === 0) continue;
    lines.push(`### ${plan.label} (${plan.toCreate.length})`, '', '| MPN | Navn | Innkjøp ekskl. mva | Lager |', '|---|---|---|---|');
    for (const p of plan.toCreate.sort((a, b) => a.name.localeCompare(b.name, 'nb'))) {
      const stock = (p.available_qty ?? 0) > 0 ? String(p.available_qty) : `innkommende ${p.next_delivery_date ?? ''}`.trim();
      lines.push(`| \`${p.mpn}\` | ${p.name.replace(/\|/g, '/')} | ${fmtPrice(p.price_ex_vat)} | ${stock} |`);
    }
    lines.push('');
  }

  const waiting = s.plans.flatMap(p => p.waitingForStock);
  if (waiting.length > 0) {
    lines.push(
      `<details><summary>${waiting.length} nye uten lager ennå (legges inn når lageret kommer)</summary>`,
      '',
      ...waiting.map(p => `- \`${p.mpn}\` ${p.name}`),
      '',
      '</details>',
      ''
    );
  }

  if (s.errors.length > 0) {
    lines.push('### Feil', '', ...s.errors.map(e => `- ${e}`), '');
  }

  return lines.join('\n');
}
