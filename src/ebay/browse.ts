import type { EbayClient } from "./client.js";
import { browsePaths as paths } from "./browse-endpoints.js";
import { readMoney, type Money } from "./money.js";
import { EbayApiError } from "./errors.js";

export type ListingEvidence = {
  priceBasis?: "asking_price" | "current_bid" | "unavailable";
  currentBidPrice?: Money | null;
  bidCount?: number | null;
  conditionId?: string | null;
  itemEndDate?: string | null;
  shippingOptions?: ShippingOptionView[];
};

export type ListingSummary = ListingEvidence & {
  itemId: string;
  title: string;
  price: Money | null;
  condition: string | null;
  imageUrl: string | null;
  itemWebUrl: string | null;
  sellerUsername: string | null;
  feedbackPercentage: string | null;
  feedbackScore: number | null;
  buyingOptions: string[];
};

export type ShippingOptionView = {
  shippingCost: string | null;
  currency: string | null;
  shippingServiceCode: string | null;
  shippingCostType: string | null;
  minEstimatedDeliveryDate: string | null;
  maxEstimatedDeliveryDate: string | null;
};

export type ItemDetail = ListingEvidence & {
  conditionDescription?: string | null;
  buyingOptions?: string[];
  sellerUsername?: string | null;
  feedbackPercentage?: string | null;
  feedbackScore?: number | null;
  itemId: string;
  legacyItemId: string | null;
  title: string;
  description: string | null;
  price: Money | null;
  condition: string | null;
  aspects: Record<string, string[]>;
  images: string[];
  shippingOptions: ShippingOptionView[];
  itemWebUrl: string | null;
};

export type SearchInput = {
  q: string;
  categoryIds?: string;
  filter?: string;
  aspectFilter?: string;
  sort?: "price" | "-price" | "newlyListed";
  limit?: number;
  offset?: number;
  marketplaceId?: string;
};

export class BrowseApi {
  constructor(
    private readonly client: EbayClient,
    private readonly auth: { getAppToken(): Promise<string> },
    private readonly strict = false,
  ) {}

  async search(input: SearchInput): Promise<{ total: number; items: ListingSummary[] }> {
    const token = await this.auth.getAppToken();
    const response = await this.client.request(paths.browseSearch, {
      token,
      marketplaceId: input.marketplaceId,
      query: {
        q: input.q,
        category_ids: input.categoryIds,
        filter: input.filter,
        aspect_filter: input.aspectFilter,
        sort: input.sort,
        limit: input.limit,
        offset: input.offset,
      },
    });
    const body = asRecord(response.json);
    if (
      this.strict &&
      (!body ||
        !Number.isSafeInteger(body.total) ||
        Number(body.total) < 0 ||
        (body.itemSummaries !== undefined && !Array.isArray(body.itemSummaries)) ||
        (Number(body.total) > 0 && !Array.isArray(body.itemSummaries)))
    ) {
      throw new EbayApiError("Invalid eBay search response.", 502);
    }
    const summaries = Array.isArray(body?.itemSummaries) ? body.itemSummaries : [];
    if (this.strict) {
      if (summaries.length > (input.limit ?? 25))
        throw new EbayApiError("Invalid eBay search response size.", 502);
      summaries.forEach(validateListing);
    }
    return {
      total: typeof body?.total === "number" ? body.total : summaries.length,
      items: summaries.map((entry) => mapSummary(entry)),
    };
  }

  async getItem(itemId: string, marketplaceId?: string): Promise<ItemDetail> {
    const token = await this.auth.getAppToken();
    const response = await this.client.request(paths.browseItem(itemId), { token, marketplaceId });
    if (this.strict) validateListing(response.json);
    return mapItem(response.json);
  }

  async getItemByLegacyId(legacyItemId: string, marketplaceId?: string): Promise<ItemDetail> {
    const token = await this.auth.getAppToken();
    const response = await this.client.request(paths.browseLegacy, {
      token,
      marketplaceId,
      query: { legacy_item_id: legacyItemId },
    });
    if (this.strict) validateListing(response.json);
    return mapItem(response.json);
  }
}

function validateListing(value: unknown): void {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.itemId !== "string" ||
    !record.itemId.trim() ||
    typeof record.title !== "string" ||
    !record.title.trim()
  ) {
    throw new EbayApiError("Invalid eBay listing response.", 502);
  }
}

function mapSummary(value: unknown): ListingSummary {
  const record = asRecord(value) ?? {};
  const seller = asRecord(record.seller);
  const image = asRecord(record.image);
  const price = readMoney(record.price) ?? readMoney(record.currentBidPrice);
  return {
    ...listingEvidence(record),
    itemId: stringOr(record.itemId, ""),
    title: stringOr(record.title, ""),
    price,
    condition: stringOrNull(record.condition),
    imageUrl: safeUrl(image?.imageUrl),
    itemWebUrl: listingUrl(record.itemWebUrl),
    sellerUsername: stringOrNull(seller?.username),
    feedbackPercentage:
      typeof seller?.feedbackPercentage === "string" ||
      typeof seller?.feedbackPercentage === "number"
        ? String(seller.feedbackPercentage)
        : null,
    feedbackScore: typeof seller?.feedbackScore === "number" ? seller.feedbackScore : null,
    buyingOptions: stringArray(record.buyingOptions),
  };
}

function mapItem(value: unknown): ItemDetail {
  const record = asRecord(value) ?? {};
  const image = asRecord(record.image);
  const images = [
    safeUrl(image?.imageUrl),
    ...arrayOf(record.additionalImages).map((entry) => safeUrl(asRecord(entry)?.imageUrl)),
  ].filter((url): url is string => Boolean(url));
  return {
    ...listingEvidence(record),
    itemId: stringOr(record.itemId, ""),
    legacyItemId: stringOrNull(record.legacyItemId),
    title: stringOr(record.title, ""),
    description: stringOrNull(record.description),
    conditionDescription: stringOrNull(record.conditionDescription),
    buyingOptions: stringArray(record.buyingOptions),
    sellerUsername: stringOrNull(asRecord(record.seller)?.username),
    feedbackPercentage: mapSummary(record).feedbackPercentage,
    feedbackScore: mapSummary(record).feedbackScore,
    price: readMoney(record.price) ?? readMoney(record.currentBidPrice),
    condition: stringOrNull(record.condition),
    aspects: mapAspects(record.localizedAspects),
    images,
    shippingOptions: arrayOf(record.shippingOptions).map(mapShipping),
    itemWebUrl: listingUrl(record.itemWebUrl),
  };
}

function mapAspects(value: unknown): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  for (const entry of arrayOf(value)) {
    const record = asRecord(entry);
    const name = stringOrNull(record?.name);
    const aspectValue = stringOrNull(record?.value);
    if (!name || !aspectValue) continue;
    const existing = aspects[name] ?? [];
    existing.push(aspectValue);
    aspects[name] = existing;
  }
  return aspects;
}

function mapShipping(value: unknown): ShippingOptionView {
  const record = asRecord(value) ?? {};
  const cost = readMoney(record.shippingCost);
  return {
    shippingCost: cost?.value ?? null,
    currency: cost?.currency ?? null,
    shippingServiceCode: stringOrNull(record.shippingServiceCode),
    shippingCostType: stringOrNull(record.shippingCostType),
    minEstimatedDeliveryDate: stringOrNull(record.minEstimatedDeliveryDate),
    maxEstimatedDeliveryDate: stringOrNull(record.maxEstimatedDeliveryDate),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayOf(value).filter((entry): entry is string => typeof entry === "string");
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function listingEvidence(record: Record<string, unknown>): ListingEvidence {
  const asking = readMoney(record.price);
  const bid = readMoney(record.currentBidPrice);
  return {
    priceBasis: asking ? "asking_price" : bid ? "current_bid" : "unavailable",
    currentBidPrice: bid,
    bidCount:
      Number.isSafeInteger(record.bidCount) && Number(record.bidCount) >= 0
        ? Number(record.bidCount)
        : null,
    conditionId: stringOrNull(record.conditionId),
    itemEndDate: stringOrNull(record.itemEndDate),
    shippingOptions: arrayOf(record.shippingOptions).map(mapShipping),
  };
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function listingUrl(value: unknown): string | null {
  const safe = safeUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  // Exact marketplace domain suffixes; no redirect/affiliate hosts or lookalikes.
  const domains = [
    "ebay.com",
    "ebay.ca",
    "ebay.co.uk",
    "ebay.com.au",
    "ebay.de",
    "ebay.fr",
    "ebay.it",
    "ebay.es",
    "ebay.at",
    "ebay.be",
    "ebay.ch",
    "ebay.ie",
    "ebay.nl",
    "ebay.pl",
    "ebay.com.hk",
    "ebay.com.sg",
    "ebay.com.my",
    "ebay.ph",
  ];
  return !url.port &&
    domains.some(
      (domain) =>
        url.hostname === domain ||
        url.hostname === `www.${domain}` ||
        (domain === "ebay.com" &&
          ["sandbox.ebay.com", "www.sandbox.ebay.com"].includes(url.hostname)),
    )
    ? safe
    : null;
}
