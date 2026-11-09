/** @file Logical reader-page geometry and image identities shared by display and preload. */

/**
 * Resolve all images required to display one logical source page. Invalid or
 * incomplete segment coverage is never treated as a successful first tile.
 * @param {any} page Brokered logical page metadata.
 * @returns {Array<{index:number,src:string,x?:number,y?:number,width?:number,height?:number}>}
 */
export const resolveReaderPageImages = (page) => {
  if (!page || page.missing) return [];
  if (!Array.isArray(page.segments) || page.segments.length === 0) {
    return typeof page.src === "string" && page.src ? [{index: 0, src: page.src}] : [];
  }
  const {width, height} = page;
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(width * height) || page.segments.length > 1024) return [];
  const indexes = new Set();
  const images = [];
  let area = 0;
  for (const segment of page.segments) {
    if (!segment || ![segment.index, segment.x, segment.y, segment.width, segment.height].every(Number.isSafeInteger)
      || segment.index < 0 || indexes.has(segment.index) || !segment.src
      || typeof segment.src !== "string" || segment.x < 0 || segment.y < 0
      || segment.width <= 0 || segment.height <= 0
      || segment.x + segment.width > width || segment.y + segment.height > height) return [];
    if (images.some((other) => segment.x < other.x + other.width && other.x < segment.x + segment.width
      && segment.y < other.y + other.height && other.y < segment.y + segment.height)) return [];
    indexes.add(segment.index);
    images.push({...segment});
    area += segment.width * segment.height;
  }
  return area === width * height ? images.sort((a, b) => a.index - b.index) : [];
};

/**
 * Build an identity that changes when any segment changes, not only tile zero.
 * @param {any} page Brokered logical page metadata.
 * @returns {string} Stable image identity.
 */
export const readerPageImageKey = (page) => JSON.stringify(resolveReaderPageImages(page).map(({index, src}) => [index, src]));
