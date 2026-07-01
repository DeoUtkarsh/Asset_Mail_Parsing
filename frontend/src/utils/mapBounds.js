/** Shared centre/zoom logic for Leaflet modal + PDF static map. */

const STATIC_MAP_PX = { w: 960, h: 400 };

function latRad(lat) {
  const sin = Math.sin((lat * Math.PI) / 180);
  const clamped = Math.max(Math.min(sin, 0.9999), -0.9999);
  return Math.log((1 + clamped) / (1 - clamped)) / 2;
}

function zoomForBounds(minLat, maxLat, minLng, maxLng, mapW, mapH) {
  const WORLD = 256;
  const latFraction = Math.max((latRad(maxLat) - latRad(minLat)) / Math.PI, 0.01);
  let lngDiff = maxLng - minLng;
  if (lngDiff < 0) lngDiff += 360;
  const lngFraction = Math.max(lngDiff / 360, 0.01);
  const latZoom = Math.log(mapH / WORLD / latFraction) / Math.LN2;
  const lngZoom = Math.log(mapW / WORLD / lngFraction) / Math.LN2;
  return Math.max(2, Math.min(Math.floor(Math.min(latZoom, lngZoom)) - 1, 8));
}

export function mapViewFromZones(zones) {
  if (!zones?.length) {
    return { lat: 15, lng: 100, zoom: 3, size: STATIC_MAP_PX };
  }

  const lats = zones.map((z) => z.lat);
  const lngs = zones.map((z) => z.lng);
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);

  const pad = zones.length === 1 ? 6 : 12;
  minLat -= pad;
  maxLat += pad;
  minLng -= pad;
  maxLng += pad;

  return {
    lat: (minLat + maxLat) / 2,
    lng: (minLng + maxLng) / 2,
    zoom: zoomForBounds(minLat, maxLat, minLng, maxLng, STATIC_MAP_PX.w, STATIC_MAP_PX.h),
    size: STATIC_MAP_PX,
  };
}

export function leafletBoundsFromZones(zones) {
  if (!zones?.length) return null;
  return zones.map((z) => [z.lat, z.lng]);
}
