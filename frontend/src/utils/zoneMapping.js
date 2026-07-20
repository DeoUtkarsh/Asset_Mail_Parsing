/** Broad trade zones — mirrors backend agents/drafter.py REGION_TO_ZONE */

const REGION_TO_ZONE = {
  // Broad section headers brokers group by (checked first).
  "north east asia": "FAR EAST", "northeast asia": "FAR EAST",
  "south east asia": "STRAITS/SEA", "southeast asia": "STRAITS/SEA",
  seasia: "STRAITS/SEA", "far east": "FAR EAST", "east asia": "FAR EAST",
  "middle east": "AG/MIDDLE EAST",
  "north america": "AMERICAS", "south america": "AMERICAS",
  americas: "AMERICAS", america: "AMERICAS",
  bsea: "MED/BLACK SEA", "black sea": "MED/BLACK SEA",
  med: "MED/BLACK SEA", mediterranean: "MED/BLACK SEA",
  waf: "AFRICA", "west africa": "AFRICA", eafr: "AFRICA", "east africa": "AFRICA",
  cont: "EUROPE", continent: "EUROPE",
  wci: "INDIA", "west coast india": "INDIA", "east coast india": "INDIA",
  // Ports / countries
  singapore: "STRAITS/SEA", straits: "STRAITS/SEA", johor: "STRAITS/SEA",
  batam: "STRAITS/SEA", bintan: "STRAITS/SEA", malaysia: "STRAITS/SEA",
  indonesia: "STRAITS/SEA", manila: "STRAITS/SEA", philippines: "STRAITS/SEA",
  "port klang": "STRAITS/SEA", kotabaru: "STRAITS/SEA",
  "hong kong": "FAR EAST", china: "FAR EAST", japan: "FAR EAST", korea: "FAR EAST",
  taiwan: "FAR EAST", yangoon: "FAR EAST", yangon: "FAR EAST", myanmar: "FAR EAST",
  vietnam: "FAR EAST", thailand: "FAR EAST", eci: "FAR EAST", chiba: "FAR EAST",
  taichung: "FAR EAST", yosu: "FAR EAST",
  mumbai: "INDIA", sikka: "INDIA", vizag: "INDIA", india: "INDIA",
  haldia: "INDIA", paradip: "INDIA", kandla: "INDIA",
  fujairah: "AG/MIDDLE EAST", uae: "AG/MIDDLE EAST", kuwait: "AG/MIDDLE EAST",
  oman: "AG/MIDDLE EAST", ag: "AG/MIDDLE EAST", kwinana: "OCEANIA",
  rotterdam: "EUROPE", europe: "EUROPE", uk: "EUROPE",
  durban: "AFRICA", africa: "AFRICA",
  australia: "OCEANIA", sydney: "OCEANIA",
  usg: "AMERICAS", peru: "AMERICAS",
};

export const ZONE_ORDER = [
  "STRAITS/SEA", "FAR EAST", "INDIA", "AG/MIDDLE EAST",
  "MED/BLACK SEA", "EUROPE", "AFRICA", "AMERICAS", "OCEANIA", "UNSPECIFIED",
];

export function regionToZone(region) {
  if (!region) return "UNSPECIFIED";
  const r = region.trim().toLowerCase();
  if (["unspecified", "n/a", "na", "-", "unknown"].includes(r)) return "UNSPECIFIED";
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
