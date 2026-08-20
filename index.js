#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGE_DELAY_MS = 800;
const MAX_RETRIES = 4;

function usageAndExit(message) {
  if (message) {
    console.error(message);
  }
  console.error(
    "Usage: node index.js <app-handle> [filename.csv]\n" +
      "Example: node index.js location-inventory-info\n" +
      "CSV files are written to the exports/ folder."
  );
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows) {
  const headers = [
    "shop_name",
    "country",
    "length_of_app_use",
    "date",
    "rating",
    "review",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers.map((header) => csvEscape(row[header])).join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function parseAppHandle(input) {
  const value = String(input || "").trim();
  if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    return value;
  }

  throw new Error(
    `Invalid app handle: ${input}. Use the listing slug, e.g. location-inventory-info`
  );
}

function reviewsUrl(handle, page) {
  const url = new URL(`https://apps.shopify.com/${handle}/reviews`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort_by", "newest");
  return url.toString();
}

async function fetchHtml(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      const waitMs = PAGE_DELAY_MS * 2 ** attempt;
      console.error(`Retrying after ${response.status} (wait ${waitMs}ms)...`);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return response.text();
  }

  throw lastError;
}

function parseReviews($) {
  const reviews = [];

  $("[data-merchant-review][data-review-content-id]").each((_, element) => {
    const $review = $(element);
    const ratingLabel =
      $review.find('[aria-label$="out of 5 stars"]').first().attr("aria-label") ||
      "";
    const ratingMatch = ratingLabel.match(/(\d+(?:\.\d+)?)\s+out of 5 stars/i);

    const date = $review
      .find(".tw-flex.tw-items-center.tw-justify-between .tw-text-body-xs")
      .first()
      .text()
      .trim();

    const $meta = $review.find(".tw-order-1.tw-text-fg-tertiary").first();
    const shopName = (
      $meta.find("span[title]").first().attr("title") ||
      $meta.find("span[title]").first().text()
    )
      .trim();

    const metaLines = $meta
      .children("div")
      .map((_, div) => $(div).clone().children().remove().end().text().trim())
      .get()
      .filter(Boolean);

    const country = metaLines[0] || "";
    const lengthOfAppUse = metaLines[1] || "";

    const review = $review
      .find("[data-truncate-content-copy] p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter(Boolean)
      .join("\n\n");

    reviews.push({
      shop_name: shopName,
      country,
      length_of_app_use: lengthOfAppUse,
      date,
      rating: ratingMatch ? ratingMatch[1] : "",
      review,
    });
  });

  return reviews;
}

function hasNextPage($) {
  return $('a[rel="next"]').length > 0;
}

async function scrapeAllReviews(handle) {
  const reviews = [];
  let page = 1;

  while (true) {
    const url = reviewsUrl(handle, page);
    console.log(`Fetching page ${page}: ${url}`);
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const pageReviews = parseReviews($);

    if (pageReviews.length === 0) {
      if (page === 1) {
        throw new Error("No reviews found. Check that the app URL is correct.");
      }
      break;
    }

    reviews.push(...pageReviews);
    console.log(`  Found ${pageReviews.length} reviews (total ${reviews.length})`);

    if (!hasNextPage($)) {
      break;
    }

    page += 1;
    await sleep(PAGE_DELAY_MS);
  }

  return reviews;
}

async function main() {
  const appHandle = process.argv[2];
  if (!appHandle || appHandle === "-h" || appHandle === "--help") {
    usageAndExit();
  }

  let handle;
  try {
    handle = parseAppHandle(appHandle);
  } catch (error) {
    usageAndExit(error.message);
  }

  const exportsDir = path.join(process.cwd(), "exports");
  fs.mkdirSync(exportsDir, { recursive: true });

  const filename = process.argv[3]
    ? path.basename(process.argv[3])
    : `${handle}-reviews.csv`;
  const outputPath = path.join(exportsDir, filename);

  const reviews = await scrapeAllReviews(handle);
  fs.writeFileSync(outputPath, toCsv(reviews), "utf8");
  console.log(`Wrote ${reviews.length} reviews to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
