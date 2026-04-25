const fs = require("fs");
const https = require("https");
const path = require("path");

const ITEMS_JSON_URL =
  "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json";

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Bumps when catalog shape changes; stale files are rebuilt. */
const CATALOG_SCHEMA_VERSION = 5;

const CATEGORY_ORDER = [
  { id: "helmets", label: "Helmets", icon: "⛑" },
  { id: "armors", label: "Armors", icon: "🛡" },
  { id: "shoes", label: "Shoes", icon: "👞" },
  { id: "weapons", label: "Weapons", icon: "⚔" },
  { id: "offhand", label: "Off Hand", icon: "📦" },
  { id: "other", label: "Other", icon: "📋" },
];

const EXACT_CATEGORY_ORDER = [
  { id: "weapons", label: "Weapons" },
  { id: "chest_armor", label: "Chest Armor" },
  { id: "head_armor", label: "Head Armor" },
  { id: "foot_armor", label: "Foot Armor" },
  { id: "off_hands", label: "Off-Hands" },
  { id: "capes", label: "Capes" },
  { id: "bags", label: "Bags" },
  { id: "mount", label: "Mount" },
  { id: "consumable", label: "Consumable" },
  { id: "gathering_equipment", label: "Gathering Equipment" },
  { id: "crafting", label: "Crafting" },
  { id: "artifact", label: "Artifact" },
  { id: "farming", label: "Farming" },
  { id: "furniture", label: "Furniture" },
  { id: "vanity", label: "Vanity" },
];

function categorizeUniqueName(uniqueName) {
  if (!uniqueName || typeof uniqueName !== "string") {
    return "other";
  }
  const u = uniqueName.toUpperCase();
  if (u.includes("_HEAD_")) {
    return "helmets";
  }
  if (u.includes("_ARMOR_")) {
    return "armors";
  }
  if (u.includes("_SHOES_")) {
    return "shoes";
  }
  if (u.includes("_OFF_")) {
    return "offhand";
  }
  if (u.includes("_MAIN_")) {
    return "weapons";
  }
  if (u.includes("_2H_") && !u.includes("_2H_TOOL_")) {
    return "weapons";
  }
  return "other";
}

function categorizeExactGroup(uniqueName) {
  if (!uniqueName || typeof uniqueName !== "string") {
    return "consumable";
  }
  const u = uniqueName.toUpperCase();
  if (
    u.includes("ARTEFACT") ||
    u.includes("ARTIFACT") ||
    u.includes("_RUNE") ||
    u.includes("_SOUL") ||
    u.includes("_RELIC")
  ) {
    return "artifact";
  }
  if (u.includes("_MAIN_") || (u.includes("_2H_") && !u.includes("_2H_TOOL_"))) return "weapons";
  if (u.includes("_ARMOR_")) return "chest_armor";
  if (u.includes("_HEAD_")) return "head_armor";
  if (u.includes("_SHOES_")) return "foot_armor";
  if (u.includes("_OFF_")) return "off_hands";
  if (u.includes("CAPE")) return "capes";
  /** Wearable inventory bags only (e.g. T4_BAG, T4_BAG_INSIGHT@1). Not LOOTBAG, not "CABBAGE". */
  if (/^T\d+_BAG/i.test(uniqueName)) return "bags";
  if (u.includes("MOUNT")) return "mount";
  if (u.includes("2H_TOOL_") || u.includes("_TOOL_")) return "gathering_equipment";
  if (
    u.includes("FARM") ||
    u.includes("SEED") ||
    u.includes("BABY") ||
    u.includes("MOUNT_GROWN")
  ) {
    return "farming";
  }
  if (u.includes("FURNITURE") || u.includes("HOUSE") || u.includes("TROPHY")) return "furniture";
  if (u.includes("VANITY") || u.includes("SKIN")) return "vanity";
  if (
    u.includes("MATERIAL") ||
    u.includes("METALBAR") ||
    u.includes("PLANK") ||
    u.includes("CLOTH") ||
    u.includes("LEATHER")
  ) {
    return "crafting";
  }
  return "consumable";
}

/**
 * Tier and enchant are encoded in UniqueName (ao-bin-dumps does not expose item quality).
 * - Tier: leading T4_, T5_, …
 * - Enchant: trailing @1 … @4 (shown in-game as .1 … .4); missing @ = flat / .0
 */
function parseTierEnchant(uniqueName) {
  let tier = null;
  const tierMatch = /^T(\d+)_/i.exec(uniqueName);
  if (tierMatch) {
    tier = parseInt(tierMatch[1], 10);
  }
  let enchant = 0;
  const encMatch = /@(\d+)$/i.exec(uniqueName);
  if (encMatch) {
    enchant = parseInt(encMatch[1], 10);
  }
  return { tier, enchant };
}

function buildSearchHaystack({ name, id, tier, enchant }) {
  const parts = [name, id];
  if (tier != null) {
    parts.push(`t${tier}`, `T${tier}`);
  }
  if (enchant > 0) {
    parts.push(`.${enchant}`, `@${enchant}`);
    if (tier != null) {
      parts.push(`${tier}.${enchant}`);
    }
  }
  return parts.join(" ").toLowerCase();
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const next = response.headers.location;
        file.close();
        fs.unlink(destPath, () => {});
        if (!next) {
          reject(new Error("Redirect without location"));
          return;
        }
        downloadToFile(next, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    request.on("error", (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function buildCatalogFromRaw(rawList) {
  if (!Array.isArray(rawList)) {
    throw new Error("items.json must be a JSON array");
  }
  const buckets = {
    helmets: [],
    armors: [],
    shoes: [],
    weapons: [],
    offhand: [],
    other: [],
  };
  const exactBuckets = Object.fromEntries(EXACT_CATEGORY_ORDER.map((c) => [c.id, []]));

  for (const row of rawList) {
    const id = row.UniqueName;
    if (!id) {
      continue;
    }
    const names = row.LocalizedNames || {};
    const name = names["EN-US"] || names["EN"] || id;
    const category = categorizeUniqueName(id);
    const { tier, enchant } = parseTierEnchant(id);
    const item = {
      id,
      name,
      category,
      exactCategoryId: categorizeExactGroup(id),
      tier,
      enchant,
      /** Item quality (Normal…Masterpiece) is not in this dataset. */
      hasQualityInDataset: false,
      searchHaystack: "",
    };
    item.searchHaystack = buildSearchHaystack(item);
    buckets[category].push(item);
    exactBuckets[item.exactCategoryId].push(item);
  }

  const collator = new Intl.Collator("en", { sensitivity: "base" });
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => {
      const byName = collator.compare(a.name, b.name);
      if (byName !== 0) {
        return byName;
      }
      const ta = a.tier ?? -1;
      const tb = b.tier ?? -1;
      if (ta !== tb) {
        return ta - tb;
      }
      return (a.enchant ?? 0) - (b.enchant ?? 0);
    });
  }
  for (const key of Object.keys(exactBuckets)) {
    exactBuckets[key].sort((a, b) => collator.compare(a.name, b.name));
  }

  const categories = CATEGORY_ORDER.map((meta) => ({
    ...meta,
    count: buckets[meta.id].length,
    items: buckets[meta.id],
  }));
  const exactCategories = EXACT_CATEGORY_ORDER.map((meta) => ({
    ...meta,
    count: exactBuckets[meta.id].length,
  }));

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: ITEMS_JSON_URL,
    itemCount: rawList.length,
    categories,
    exactCategories,
  };
}

function isFresh(filePath, maxAgeMs) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const stat = fs.statSync(filePath);
  return Date.now() - stat.mtimeMs < maxAgeMs;
}

async function ensureItemCatalog(userDataPath, { force = false } = {}) {
  const catalogPath = path.join(userDataPath, "albion_items_catalog.json");
  const rawPath = path.join(userDataPath, "albion_items_raw.json");

  if (!force && isFresh(catalogPath, CACHE_MAX_AGE_MS) && fs.existsSync(catalogPath)) {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
    if (parsed.schemaVersion === CATALOG_SCHEMA_VERSION) {
      return { ...parsed, fromCache: true };
    }
  }

  let rawList = null;
  if (!force && fs.existsSync(rawPath) && fs.statSync(rawPath).size > 1_000_000) {
    try {
      rawList = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
    } catch (_e) {
      rawList = null;
    }
  }

  if (!rawList) {
    await downloadToFile(ITEMS_JSON_URL, rawPath);
    rawList = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
  }

  const catalog = buildCatalogFromRaw(rawList);
  catalog.fetchedAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), "utf-8");

  return { ...catalog, fromCache: false };
}

module.exports = {
  ITEMS_JSON_URL,
  CATEGORY_ORDER,
  CATALOG_SCHEMA_VERSION,
  categorizeUniqueName,
  parseTierEnchant,
  ensureItemCatalog,
  buildCatalogFromRaw,
};
