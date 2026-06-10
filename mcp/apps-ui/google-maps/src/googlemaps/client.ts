// ---------------------------------------------------------------------------
// Google Maps API Client
// Uses GOOGLE_MAPS_API_KEY for all Maps Platform API calls.
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_MAPS_API_KEY environment variable is required");
  }
  return key;
}

const MAPS_BASE = "https://maps.googleapis.com/maps/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaceResult {
  place_id: string;
  name: string;
  formatted_address: string;
  geometry: {
    location: { lat: number; lng: number };
  };
  rating?: number;
  user_ratings_total?: number;
  opening_hours?: { open_now?: boolean };
  types?: string[];
  price_level?: number;
  photos?: Array<{ photo_reference: string }>;
}

export interface PlaceDetails {
  place_id: string;
  name: string;
  formatted_address: string;
  formatted_phone_number?: string;
  website?: string;
  url?: string;
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  opening_hours?: {
    open_now?: boolean;
    weekday_text?: string[];
  };
  reviews?: Array<{
    author_name: string;
    rating: number;
    text: string;
    relative_time_description: string;
  }>;
  geometry: {
    location: { lat: number; lng: number };
  };
  types?: string[];
  photos?: Array<{ photo_reference: string }>;
}

export interface DirectionsResult {
  routes: Array<{
    summary: string;
    legs: Array<{
      distance: { text: string; value: number };
      duration: { text: string; value: number };
      start_address: string;
      end_address: string;
      start_location: { lat: number; lng: number };
      end_location: { lat: number; lng: number };
      steps: Array<{
        html_instructions: string;
        distance: { text: string };
        duration: { text: string };
        travel_mode: string;
        start_location: { lat: number; lng: number };
        end_location: { lat: number; lng: number };
      }>;
    }>;
    overview_polyline: { points: string };
  }>;
}

export interface GeocodeResult {
  formatted_address: string;
  geometry: {
    location: { lat: number; lng: number };
  };
  place_id: string;
  address_components: Array<{
    long_name: string;
    short_name: string;
    types: string[];
  }>;
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Search for places using Google Places Text Search API.
 */
export async function searchPlaces(
  query: string,
  options?: {
    location?: { lat: number; lng: number };
    radius?: number;
    type?: string;
  },
): Promise<PlaceResult[]> {
  const apiKey = getApiKey();
  const params = new URLSearchParams({
    query,
    key: apiKey,
  });

  if (options?.location) {
    params.set("location", `${options.location.lat},${options.location.lng}`);
  }
  if (options?.radius) {
    params.set("radius", String(options.radius));
  }
  if (options?.type) {
    params.set("type", options.type);
  }

  const response = await fetch(
    `${MAPS_BASE}/place/textsearch/json?${params}`,
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Places API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(
      `Places API error: ${data.status} - ${data.error_message || ""}`,
    );
  }

  return data.results || [];
}

/**
 * Get detailed information about a specific place.
 */
export async function getPlaceDetails(
  placeId: string,
): Promise<PlaceDetails> {
  const apiKey = getApiKey();
  const params = new URLSearchParams({
    place_id: placeId,
    key: apiKey,
    fields: [
      "place_id",
      "name",
      "formatted_address",
      "formatted_phone_number",
      "website",
      "url",
      "rating",
      "user_ratings_total",
      "price_level",
      "opening_hours",
      "reviews",
      "geometry",
      "types",
      "photos",
    ].join(","),
  });

  const response = await fetch(
    `${MAPS_BASE}/place/details/json?${params}`,
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Place Details API error (${response.status}): ${errorText}`,
    );
  }

  const data = await response.json();
  if (data.status !== "OK") {
    throw new Error(
      `Place Details API error: ${data.status} - ${data.error_message || ""}`,
    );
  }

  return data.result;
}

/**
 * Get directions between two locations.
 */
export async function getDirections(
  origin: string,
  destination: string,
  options?: {
    mode?: "driving" | "walking" | "bicycling" | "transit";
    waypoints?: string[];
    avoid?: string[];
    departure_time?: number;
  },
): Promise<DirectionsResult> {
  const apiKey = getApiKey();
  const params = new URLSearchParams({
    origin,
    destination,
    key: apiKey,
  });

  if (options?.mode) {
    params.set("mode", options.mode);
  }
  if (options?.waypoints?.length) {
    params.set("waypoints", options.waypoints.join("|"));
  }
  if (options?.avoid?.length) {
    params.set("avoid", options.avoid.join("|"));
  }
  if (options?.departure_time) {
    params.set("departure_time", String(options.departure_time));
  }

  const response = await fetch(
    `${MAPS_BASE}/directions/json?${params}`,
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Directions API error (${response.status}): ${errorText}`,
    );
  }

  const data = await response.json();
  if (data.status !== "OK") {
    throw new Error(
      `Directions API error: ${data.status} - ${data.error_message || ""}`,
    );
  }

  return data;
}

/**
 * Geocode an address to coordinates, or reverse-geocode coordinates to an address.
 */
export async function geocode(
  input: { address: string } | { lat: number; lng: number },
): Promise<GeocodeResult[]> {
  const apiKey = getApiKey();
  const params = new URLSearchParams({ key: apiKey });

  if ("address" in input) {
    params.set("address", input.address);
  } else {
    params.set("latlng", `${input.lat},${input.lng}`);
  }

  const response = await fetch(
    `${MAPS_BASE}/geocode/json?${params}`,
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Geocoding API error (${response.status}): ${errorText}`,
    );
  }

  const data = await response.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(
      `Geocoding API error: ${data.status} - ${data.error_message || ""}`,
    );
  }

  return data.results || [];
}
