/** Broad trade zones — mirrors backend agents/drafter.py + region_map.py */

const REGION_TO_ZONE = {
  // Excel region names (canonical display values in vessels.region)
  "us gulf": "AMERICAS",
  "us east coast": "AMERICAS",
  "us west coast": "AMERICAS",
  "east coast south america": "AMERICAS",
  "west coast south america": "AMERICAS",
  caribbean: "AMERICAS",
  "west africa": "AFRICA",
  "east africa": "AFRICA",
  mediterranean: "MED/BLACK SEA",
  "black sea": "MED/BLACK SEA",
  "continent (amsterdam-rotterdam-antwerp range)": "EUROPE",
  "uk-continent": "EUROPE",
  "baltic sea": "EUROPE",
  "arabian gulf / persian gulf": "AG/MIDDLE EAST",
  "red sea": "AG/MIDDLE EAST",
  "west coast india": "INDIA",
  "east coast india": "INDIA",
  "indian subcontinent (often grouped with india range)": "INDIA",
  "southeast asia": "STRAITS/SEA",
  "singapore / malacca strait hub zone (open-position term)": "STRAITS/SEA",
  "far east": "FAR EAST",
  "australia (often grouped with nz as oceania)": "OCEANIA",
  // Region codes (legacy rows / filters)
  usg: "AMERICAS",
  usec: "AMERICAS",
  uswc: "AMERICAS",
  ecsa: "AMERICAS",
  wcsa: "AMERICAS",
  caribs: "AMERICAS",
  waf: "AFRICA",
  eaf: "AFRICA",
  eafr: "AFRICA",
  med: "MED/BLACK SEA",
  blacksea: "MED/BLACK SEA",
  "cont / ara": "EUROPE",
  ukc: "EUROPE",
  baltic: "EUROPE",
  "ag / pg": "AG/MIDDLE EAST",
  rsea: "AG/MIDDLE EAST",
  "india / wci": "INDIA",
  "india / eci": "INDIA",
  sea: "STRAITS/SEA",
  straits: "STRAITS/SEA",
  "australia / aus": "OCEANIA",
  // Broad / broker slang fallbacks
  "north east asia": "FAR EAST",
  "northeast asia": "FAR EAST",
  "south east asia": "STRAITS/SEA",
  seasia: "STRAITS/SEA",
  "east asia": "FAR EAST",
  "middle east": "AG/MIDDLE EAST",
  "north america": "AMERICAS",
  "south america": "AMERICAS",
  americas: "AMERICAS",
  america: "AMERICAS",
  bsea: "MED/BLACK SEA",
  continent: "EUROPE",
  cont: "EUROPE",
  wci: "INDIA",
  eci: "INDIA",
  singapore: "STRAITS/SEA",
  malaysia: "STRAITS/SEA",
  indonesia: "STRAITS/SEA",
  china: "FAR EAST",
  japan: "FAR EAST",
  korea: "FAR EAST",
  taiwan: "FAR EAST",
  india: "INDIA",
  australia: "OCEANIA",
  peru: "AMERICAS",
};

export const ZONE_ORDER = [
  "STRAITS/SEA", "FAR EAST", "INDIA", "AG/MIDDLE EAST",
  "MED/BLACK SEA", "EUROPE", "AFRICA", "AMERICAS", "OCEANIA", "UNSPECIFIED",
];

export function regionToZone(region) {
  if (!region) return "UNSPECIFIED";
  const r = region.trim().toLowerCase();
  if (["unspecified", "n/a", "na", "-", "unknown"].includes(r)) return "UNSPECIFIED";
  if (REGION_TO_ZONE[r]) return REGION_TO_ZONE[r];
  for (const [key, zone] of Object.entries(REGION_TO_ZONE)) {
    if (r.includes(key) || key.includes(r)) return zone;
  }
  return "UNSPECIFIED";
}

/** Group vessels by trade zone for Contact List grid (same order as draft email). */
export function vesselsGroupedByZone(vessels) {
  const mapped = vessels.map((v) => {
    const zone = regionToZone(v.region);
    return { ...v, attachment_id: zone, filename: zone };
  });
  return mapped.sort((a, b) => {
    const za = ZONE_ORDER.indexOf(a.attachment_id);
    const zb = ZONE_ORDER.indexOf(b.attachment_id);
    const ai = za === -1 ? ZONE_ORDER.length : za;
    const bi = zb === -1 ? ZONE_ORDER.length : zb;
    if (ai !== bi) return ai - bi;
    return (a.dynamic_data?.vessel_name || "").localeCompare(b.dynamic_data?.vessel_name || "");
  });
}
