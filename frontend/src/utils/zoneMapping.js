/** Broad trade zones — mirrors backend agents/drafter.py REGION_TO_ZONE */

const REGION_TO_ZONE = {
  singapore: "STRAITS/SEA", straits: "STRAITS/SEA", johor: "STRAITS/SEA",
  batam: "STRAITS/SEA", bintan: "STRAITS/SEA", malaysia: "STRAITS/SEA",
  indonesia: "STRAITS/SEA", manila: "STRAITS/SEA", philippines: "STRAITS/SEA",
  "hong kong": "FAR EAST", china: "FAR EAST", japan: "FAR EAST", korea: "FAR EAST",
  taiwan: "FAR EAST", yangoon: "FAR EAST", yangon: "FAR EAST", myanmar: "FAR EAST",
  vietnam: "FAR EAST", thailand: "FAR EAST",
  mumbai: "INDIA", sikka: "INDIA", vizag: "INDIA", india: "INDIA",
  fujairah: "AG/MIDDLE EAST", uae: "AG/MIDDLE EAST", kuwait: "AG/MIDDLE EAST",
  oman: "AG/MIDDLE EAST", ag: "AG/MIDDLE EAST",
  rotterdam: "EUROPE", europe: "EUROPE", uk: "EUROPE",
  durban: "AFRICA", africa: "AFRICA",
  australia: "OCEANIA", sydney: "OCEANIA",
};

export const ZONE_ORDER = [
  "STRAITS/SEA", "FAR EAST", "INDIA",
  "AG/MIDDLE EAST", "EUROPE", "AFRICA", "OCEANIA", "UNSPECIFIED",
];

export function regionToZone(region) {
  if (!region) return "UNSPECIFIED";
  const r = region.trim().toLowerCase();
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
