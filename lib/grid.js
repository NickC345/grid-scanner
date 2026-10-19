// Builds a rectangular grid of GPS points centered on a business.
// Grid is COLS wide (west -> east) and ROWS tall (north -> south).

const MILES_PER_DEG_LAT = 69.0;

function milesPerDegLng(lat) {
  return MILES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

function round7(n) {
  return Math.round(n * 1e7) / 1e7;
}

/**
 * @returns {Array<{row:number,col:number,lat:number,lng:number,isCenter:boolean}>}
 *   ordered row by row starting at the north-west corner.
 */
function buildGrid(centerLat, centerLng, spacingMiles, cols = 9, rows = 11) {
  const dLat = spacingMiles / MILES_PER_DEG_LAT;
  const dLng = spacingMiles / milesPerDegLng(centerLat);
  const midCol = (cols - 1) / 2;
  const midRow = (rows - 1) / 2;
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        row: r,
        col: c,
        lat: round7(centerLat + (midRow - r) * dLat),
        lng: round7(centerLng + (c - midCol) * dLng),
        isCenter: r === midRow && c === midCol,
      });
    }
  }
  return points;
}

// 3x3 sample of the grid (corners, edge midpoints, center) used for the
// more expensive Google Search ad checks.
function samplePoints(points, cols = 9, rows = 11) {
  const pickRows = [0, Math.floor((rows - 1) / 2), rows - 1];
  const pickCols = [0, Math.floor((cols - 1) / 2), cols - 1];
  return points.filter((p) => pickRows.includes(p.row) && pickCols.includes(p.col));
}

// Google Maps zoom level that roughly matches a searcher's view at this spacing.
function zoomForSpacing(spacingMiles) {
  if (spacingMiles <= 0.5) return 15;
  if (spacingMiles <= 1) return 14;
  return 13;
}

module.exports = { buildGrid, samplePoints, zoomForSpacing, milesPerDegLng };
