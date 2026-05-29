import { zones, type ZoneKey } from "@/lib/pricing";

export type RoutePoint = {
  label: string;
  lat: number;
  lng: number;
};

export type RoutePreview = {
  pickup: RoutePoint;
  hub: RoutePoint;
  zoneKey: ZoneKey;
  zoneLabel: string;
  zoneNote: string;
  estimatedDistanceKm: number;
  estimatedDriveMinutes: number;
  googleMapsUrl: string;
  directionsUrl: string;
};

export const bubbleWashHub: RoutePoint = {
  label: "Bubble Wash dispatch hub, Accra",
  lat: 5.5571096,
  lng: -0.2012376,
};

const routePoints: Record<ZoneKey, RoutePoint> = {
  core: { label: "Core Accra route", lat: 5.5833, lng: -0.1667 },
  near: { label: "Near-route Accra pickup", lat: 5.625, lng: -0.145 },
  outer: { label: "Outer route pickup", lat: 5.6698, lng: -0.0166 },
  custom: { label: "Custom pickup area", lat: 5.6037, lng: -0.187 },
};

const routeEstimates: Record<ZoneKey, { distanceKm: number; driveMinutes: number }> = {
  core: { distanceKm: 6, driveMinutes: 18 },
  near: { distanceKm: 12, driveMinutes: 32 },
  outer: { distanceKm: 28, driveMinutes: 58 },
  custom: { distanceKm: 0, driveMinutes: 0 },
};

function encode(value: string) {
  return encodeURIComponent(value);
}

export function googleMapsSearchUrl(query: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encode(query)}`;
}

export function googleMapsDirectionsUrl(origin: string, destination: string) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encode(origin)}&destination=${encode(destination)}&travelmode=driving`;
}

export function buildRoutePreview(zoneKey: ZoneKey = "core", area = ""): RoutePreview {
  const safeZone = zones[zoneKey] ? zoneKey : "core";
  const zone = zones[safeZone];
  const pickup = { ...routePoints[safeZone], label: area.trim() || routePoints[safeZone].label };
  const estimate = routeEstimates[safeZone];
  const destination = `${pickup.label}, Accra, Ghana`;
  const origin = bubbleWashHub.label;

  return {
    pickup,
    hub: bubbleWashHub,
    zoneKey: safeZone,
    zoneLabel: zone.label,
    zoneNote: zone.note,
    estimatedDistanceKm: estimate.distanceKm,
    estimatedDriveMinutes: estimate.driveMinutes,
    googleMapsUrl: googleMapsSearchUrl(destination),
    directionsUrl: googleMapsDirectionsUrl(origin, destination),
  };
}
