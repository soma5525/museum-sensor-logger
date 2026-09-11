const path = require("node:path");
const sharp = require("sharp");
const folder = path.join(__dirname, "../icons");
Promise.all([
  [192, "icon-192.png"],
  [512, "icon-512.png"],
  [180, "apple-touch-icon.png"],
].map(([size, filename]) => sharp(path.join(folder, "icon.svg"))
  .resize(size, size).png().toFile(path.join(folder, filename))))
  .catch(error => { console.error(error); process.exitCode = 1; });
